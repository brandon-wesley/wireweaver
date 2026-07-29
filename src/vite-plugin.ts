import type { Plugin } from 'vite';
import type { Plugin as EsbuildPlugin } from 'esbuild';
import ts from 'typescript';
import { readFile } from 'node:fs/promises';
import { isAbsolute, resolve as resolvePath, join as joinPath, dirname } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';

interface InterfaceImplementation {
	className: string;
	filePath: string;
	/** Package import specifier for implementations
	 *  discovered from external packages via extraScanDirs. When set, this is used for
	 *  import injection instead of computing a relative path to the source file. */
	importSpecifier?: string;
}

type InterfaceImplementationMap = Map<string, InterfaceImplementation[]>;

/** Maps each class name produced by a @Bean factory to the file that declares it. */
type BeanRegistrationMap = Map<string, string>;

interface ConstructorDependency {
	paramName?: string;
	typeName: string;
}

export interface WireWeaverPluginOptions {
	/**
	 * Additional source directories to scan for @Component/@Service implementations,
	 * in addition to the project's own source files. Useful for local workspace packages
	 * that are symlinked through node_modules and would otherwise be skipped.
	 *
	 * Paths may be absolute or relative to the project root.
	 *
	 * @example
	 * wireWeaverPlugin({ extraScanDirs: ['node_modules/my-package/dist'] })
	 */
	extraScanDirs?: string[];
}

export function wireWeaverPlugin(options: WireWeaverPluginOptions = {}): Plugin {
	let implementations: InterfaceImplementationMap = new Map();
	let beanRegistrations: BeanRegistrationMap = new Map();
	let projectRoot = process.cwd();

	return {
		name: 'wireweaver',
		enforce: 'pre',
		configResolved(config) {
			projectRoot = config.root;
		},
		buildStart() {
			const extraScanDirs = resolveExtraScanDirs(projectRoot, options.extraScanDirs);
			implementations = discoverInterfaceImplementations(projectRoot, extraScanDirs);
			beanRegistrations = discoverBeanRegistrations(projectRoot, implementations, extraScanDirs);
		},
		transform(code: string, id: string) {
			if (!/\.(ts|tsx)$/.test(id) || id.endsWith('.d.ts')) return null;
			return transformSource(code, id, implementations, beanRegistrations);
		},
	};
}

export default wireWeaverPlugin;

export function wireWeaverEsbuildPlugin(options: WireWeaverPluginOptions = {}): EsbuildPlugin {
	let implementations: InterfaceImplementationMap = new Map();
	let beanRegistrations: BeanRegistrationMap = new Map();

	return {
		name: 'wireweaver',
		setup(build) {
			build.onStart(() => {
				const cwd = process.cwd();
				const extraScanDirs = resolveExtraScanDirs(cwd, options.extraScanDirs);
				implementations = discoverInterfaceImplementations(cwd, extraScanDirs);
				beanRegistrations = discoverBeanRegistrations(cwd, implementations, extraScanDirs);
			});

			build.onLoad({ filter: /\.(ts|tsx)$/ }, async (args) => {
				if (args.path.endsWith('.d.ts')) return undefined;
				const source = await readFile(args.path, 'utf8');
				const result = transformSource(source, args.path, implementations, beanRegistrations);
				if (!result) return undefined;
				return { contents: result.code, loader: 'ts' };
			});
		},
	};
}

interface Replacement {
	start: number;
	end: number;
	text: string;
}

export function transformSource(
	code: string,
	fileName: string,
	implementations: InterfaceImplementationMap = new Map(),
	beanRegistrations: BeanRegistrationMap = new Map(),
): { code: string } | null {
	const sourceFile = ts.createSourceFile(
		fileName,
		code,
		ts.ScriptTarget.Latest,
		/* setParentNodes */ true,
		ts.ScriptKind.TS,
	);

	const replacements: Replacement[] = [];
	const importsToInject = new Map<string, Set<string>>();
	const sideEffectImports = new Set<string>();
	const declaredSymbols = collectDeclaredSymbols(sourceFile);
	const typeOnlySymbols = collectTypeOnlySymbols(sourceFile);
	const localImplementations = discoverLocalImplementations(sourceFile, fileName);

	// Merge global bean registrations with any @Bean factories declared locally in this file.
	const localBeanRegistrations: BeanRegistrationMap = new Map(beanRegistrations);
	collectBeanRegistrationsFromFile(sourceFile, fileName, implementations, localBeanRegistrations);

	function resolveImplementations(typeName: string): InterfaceImplementation[] | undefined {
		return localImplementations.get(typeName) ?? implementations.get(typeName);
	}

	function visit(node: ts.Node): void {
		if (ts.isClassDeclaration(node)) {
			const decorators = ts.getDecorators(node);
			if (decorators) {
				for (const decorator of decorators) {
					if (!ts.isCallExpression(decorator.expression)) continue;
					const callExpr = decorator.expression;
					if (!ts.isIdentifier(callExpr.expression)) continue;
					const decoratorName = callExpr.expression.text;
					if (!isDIComponentDecoratorName(decoratorName)) continue;
					if (callExpr.arguments.length !== 0) continue;

					const genericTypeParams = new Set(
								(node.typeParameters ?? []).map((tp) => tp.name.text),
							);

					const dependencyNames = getConstructorDependencies(node).flatMap((dependency) => {
						// Generic type parameters are erased at runtime — skip them.
						if (genericTypeParams.has(dependency.typeName)) return [];

						const candidates = resolveImplementations(dependency.typeName);
						if (candidates && candidates.length > 0) {
							const match = pickImplementationForParameter(dependency, candidates);
							if (!match) {
								throw new Error(
									`WireWeaver: multiple implementations found for ${dependency.typeName} but none matched constructor parameter '${dependency.paramName ?? 'unknown'}' in ${fileName}.`,
								);
							}

							if (!declaredSymbols.has(match.className) && normalizeFilePath(fileName) !== normalizeFilePath(match.filePath)) {
								const importPath = match.importSpecifier ?? toImportPath(fileName, match.filePath);
								const names = importsToInject.get(importPath) ?? new Set<string>();
								names.add(match.className);
								importsToInject.set(importPath, names);
							}

							// If this dep's @Bean factory lives in a file other than where the class
							// itself is defined, inject a side-effect import of the config file so
							// that beans are always registered before any resolve() call, regardless
							// of the user's import order.
							const beanFile = localBeanRegistrations.get(match.className);
							if (
								beanFile &&
								normalizeFilePath(beanFile) !== normalizeFilePath(fileName) &&
								normalizeFilePath(beanFile) !== normalizeFilePath(match.filePath)
							) {
								sideEffectImports.add(toImportPath(fileName, beanFile));
							}

							return [match.className];
						}

						// Type-only symbol (interface/type alias) with no known implementation — skip it.
						// Emitting the name would cause a ReferenceError since interfaces are erased at runtime.
						if (typeOnlySymbols.has(dependency.typeName)) return [];

						// Concrete dep referenced directly — still inject its config file if needed.
						const beanFileForConcrete = localBeanRegistrations.get(dependency.typeName);
						if (beanFileForConcrete && normalizeFilePath(beanFileForConcrete) !== normalizeFilePath(fileName)) {
							sideEffectImports.add(toImportPath(fileName, beanFileForConcrete));
						}

						return [dependency.typeName];
					});
					if (dependencyNames.length === 0) continue;

					replacements.push({
						start: callExpr.getStart(sourceFile),
						end: callExpr.getEnd(),
						text: `${decoratorName}([${dependencyNames.join(', ')}])`,
					});
				}
			}
		}

		if (ts.isMethodDeclaration(node)) {
			const isStaticMethod = (ts.getModifiers(node) ?? []).some((m) => m.kind === ts.SyntaxKind.StaticKeyword);
			if (isStaticMethod) {
				const decorators = ts.getDecorators(node);
				if (decorators) {
					for (const decorator of decorators) {
						if (!ts.isCallExpression(decorator.expression)) continue;
						const callExpr = decorator.expression;
						if (!ts.isIdentifier(callExpr.expression)) continue;
						const decoratorName = callExpr.expression.text;
						if (!isDIBeanDecoratorName(decoratorName)) continue;
						if (callExpr.arguments.length !== 0) continue;

						if (!node.type || !ts.isTypeReferenceNode(node.type)) continue;
						if (!ts.isIdentifier(node.type.typeName)) continue;
						const returnTypeName = node.type.typeName.text;

						const candidates = resolveImplementations(returnTypeName);
						let registrationClassName: string | undefined;

						if (candidates && candidates.length > 0) {
							if (candidates.length > 1) {
								throw new Error(
									`WireWeaver: @${decoratorName}() has multiple implementations for return type ${returnTypeName} in ${fileName}. ` +
									`Specify the class explicitly: @${decoratorName}(ConcreteClass).`,
								);
							}
							const match = candidates[0];
							registrationClassName = match.className;
							if (!declaredSymbols.has(match.className) && normalizeFilePath(fileName) !== normalizeFilePath(match.filePath)) {
								const importPath = match.importSpecifier ?? toImportPath(fileName, match.filePath);
								const names = importsToInject.get(importPath) ?? new Set<string>();
								names.add(match.className);
								importsToInject.set(importPath, names);
							}
						} else if (!typeOnlySymbols.has(returnTypeName)) {
							registrationClassName = returnTypeName;
						}

						if (registrationClassName) {
							replacements.push({
								start: callExpr.getStart(sourceFile),
								end: callExpr.getEnd(),
								text: `${decoratorName}(${registrationClassName})`,
							});
						}
					}
				}
			}
		}

		if (ts.isCallExpression(node)) {
			const callee = node.expression;
			if (ts.isIdentifier(callee) && isDIResolveFunctionName(callee.text)) {
				// Case 1: resolve<T>() — interface resolution, rewrite to concrete class
				if (node.typeArguments?.length === 1 && node.arguments.length === 0) {
					const typeArg = node.typeArguments[0];
					if (ts.isTypeReferenceNode(typeArg) && ts.isIdentifier(typeArg.typeName)) {
						const typeName = typeArg.typeName.text;
						const candidates = resolveImplementations(typeName);

						if (candidates && candidates.length > 0) {
							if (candidates.length > 1) {
								throw new Error(
									`WireWeaver: multiple implementations found for ${typeName} in ${fileName}. ` +
									`Cannot disambiguate a ${callee.text}<${typeName}>() call — use ${callee.text}(ConcreteClass) instead.`,
								);
							}

							const match = candidates[0];
							if (!declaredSymbols.has(match.className) && normalizeFilePath(fileName) !== normalizeFilePath(match.filePath)) {
								const importPath = match.importSpecifier ?? toImportPath(fileName, match.filePath);
								const names = importsToInject.get(importPath) ?? new Set<string>();
								names.add(match.className);
								importsToInject.set(importPath, names);
							}

							// Inject side-effect import of the @Bean config file if one exists.
							const beanFile = localBeanRegistrations.get(match.className);
							if (
								beanFile &&
								normalizeFilePath(beanFile) !== normalizeFilePath(fileName) &&
								normalizeFilePath(beanFile) !== normalizeFilePath(match.filePath)
							) {
								sideEffectImports.add(toImportPath(fileName, beanFile));
							}

							replacements.push({
								start: node.getStart(sourceFile),
								end: node.getEnd(),
								text: `${callee.text}(${match.className})`,
							});
						}
					}
				}

				// Case 2: resolve(ConcreteClass) — inject @Bean config side-effect if needed
				if (node.arguments.length === 1 && (!node.typeArguments || node.typeArguments.length === 0)) {
					const arg = node.arguments[0];
					if (ts.isIdentifier(arg)) {
						const beanFile = localBeanRegistrations.get(arg.text);
						if (
							beanFile &&
							normalizeFilePath(beanFile) !== normalizeFilePath(fileName)
						) {
							sideEffectImports.add(toImportPath(fileName, beanFile));
						}
					}
				}
			}
		}

		ts.forEachChild(node, visit);
	}

	visit(sourceFile);

	if (replacements.length === 0 && importsToInject.size === 0 && sideEffectImports.size === 0) return null;

	const importInsertions = buildImportInsertions(code, sourceFile, importsToInject, sideEffectImports, declaredSymbols);
	replacements.push(...importInsertions);

	replacements.sort((a, b) => b.start - a.start);
	let result = code;
	for (const r of replacements) {
		result = result.slice(0, r.start) + r.text + result.slice(r.end);
	}
	return { code: result };
}

function discoverLocalImplementations(sourceFile: ts.SourceFile, fileName: string): InterfaceImplementationMap {
	const localImpls: InterfaceImplementationMap = new Map();

	function visitNode(node: ts.Node): void {
		// Include all classes that implement an interface, not just decorated ones.
		// This allows @Bean-registered classes (which have no @Service/@Component) to be
		// resolved as implementations of local interfaces for @Component() dep injection.
		if (ts.isClassDeclaration(node) && node.name) {
			for (const clause of node.heritageClauses ?? []) {
				if (clause.token !== ts.SyntaxKind.ImplementsKeyword) continue;
				for (const type of clause.types) {
					const interfaceName = ts.isIdentifier(type.expression) ? type.expression.text : undefined;
					if (!interfaceName) continue;
					const existing = localImpls.get(interfaceName) ?? [];
					existing.push({ className: node.name!.text, filePath: fileName });
					localImpls.set(interfaceName, existing);
				}
			}
		}
		ts.forEachChild(node, visitNode);
	}

	visitNode(sourceFile);
	return localImpls;
}

function discoverBeanRegistrations(root: string, implementations: InterfaceImplementationMap, extraScanDirs: string[] = []): BeanRegistrationMap {
	const result: BeanRegistrationMap = new Map();

	collectBeanRegistrationsFromDir(root, implementations, result, false);

	for (const dir of extraScanDirs) {
		collectBeanRegistrationsFromDir(dir, implementations, result, true);
	}

	return result;
}

function collectBeanRegistrationsFromDir(
	root: string,
	implementations: InterfaceImplementationMap,
	result: BeanRegistrationMap,
	allowNodeModules: boolean,
): void {
	const tsconfigPath = ts.findConfigFile(root, ts.sys.fileExists, 'tsconfig.json');
	if (!tsconfigPath) return;

	const configFile = ts.readConfigFile(tsconfigPath, ts.sys.readFile);
	if (configFile.error) return;

	const parsedConfig = ts.parseJsonConfigFileContent(configFile.config, ts.sys, getDirName(tsconfigPath));
	const program = ts.createProgram({ rootNames: parsedConfig.fileNames, options: parsedConfig.options });

	for (const sourceFile of program.getSourceFiles()) {
		if (sourceFile.isDeclarationFile) continue;
		if (!allowNodeModules && sourceFile.fileName.includes('/node_modules/')) continue;
		collectBeanRegistrationsFromFile(sourceFile, sourceFile.fileName, implementations, result);
	}
}

function collectBeanRegistrationsFromFile(
	sourceFile: ts.SourceFile,
	filePath: string,
	globalImplementations: InterfaceImplementationMap,
	result: BeanRegistrationMap,
): void {
	const localImpls = discoverLocalImplementations(sourceFile, filePath);
	const typeOnlySymbols = collectTypeOnlySymbols(sourceFile);

	function resolveToClassName(typeName: string): string | undefined {
		const local = localImpls.get(typeName);
		if (local && local.length === 1) return local[0].className;
		const global = globalImplementations.get(typeName);
		if (global && global.length === 1) return global[0].className;
		if (!typeOnlySymbols.has(typeName)) return typeName;
		return undefined;
	}

	function visitNode(node: ts.Node): void {
		if (ts.isMethodDeclaration(node)) {
			const isStatic = (ts.getModifiers(node) ?? []).some((m) => m.kind === ts.SyntaxKind.StaticKeyword);
			if (isStatic) {
				for (const decorator of ts.getDecorators(node) ?? []) {
					if (!ts.isCallExpression(decorator.expression)) continue;
					if (!ts.isIdentifier(decorator.expression.expression)) continue;
					if (!isDIBeanDecoratorName(decorator.expression.expression.text)) continue;

					const args = decorator.expression.arguments;
					if (args.length > 0 && ts.isIdentifier(args[0])) {
						result.set(args[0].text, filePath);
					} else if (node.type && ts.isTypeReferenceNode(node.type) && ts.isIdentifier(node.type.typeName)) {
						const className = resolveToClassName(node.type.typeName.text);
						if (className) result.set(className, filePath);
					}
				}
			}
		}
		ts.forEachChild(node, visitNode);
	}

	visitNode(sourceFile);
}

function discoverInterfaceImplementations(root: string, extraScanDirs: string[] = []): InterfaceImplementationMap {
	const implementations: InterfaceImplementationMap = new Map();

	// className → [{interfaceName, filePath, importSpecifier}] for ALL classes (no decorator filter)
	const allClassHeritage = new Map<string, Array<{ interfaceName: string; filePath: string; importSpecifier?: string }>>();
	// class names that appear as @Bean() return types — eligible for implementation discovery
	const beanReturnTypes = new Set<string>();

	scanSourceFilesForImplementations(root, implementations, allClassHeritage, beanReturnTypes, false);

	for (const dir of extraScanDirs) {
		const packageRoot = findPackageRoot(dir);
		scanSourceFilesForImplementations(dir, implementations, allClassHeritage, beanReturnTypes, true, packageRoot);
	}

	// Phase 2: for classes provided exclusively via @Bean() (no @Component()),
	// add their interface implementations using the full heritage map.
	for (const typeName of beanReturnTypes) {
		const entries = allClassHeritage.get(typeName);
		if (!entries) continue;
		for (const entry of entries) {
			const existing = implementations.get(entry.interfaceName) ?? [];
			if (existing.some((i) => i.className === typeName && normalizeFilePath(i.filePath) === normalizeFilePath(entry.filePath))) {
				continue;
			}
			existing.push({ className: typeName, filePath: entry.filePath, importSpecifier: entry.importSpecifier });
			implementations.set(entry.interfaceName, existing);
		}
	}

	return implementations;
}

function scanSourceFilesForImplementations(
	root: string,
	implementations: InterfaceImplementationMap,
	allClassHeritage: Map<string, Array<{ interfaceName: string; filePath: string; importSpecifier?: string }>>,
	beanReturnTypes: Set<string>,
	allowNodeModules: boolean,
	packageRoot?: string,
): void {
	const tsconfigPath = ts.findConfigFile(root, ts.sys.fileExists, 'tsconfig.json');
	if (!tsconfigPath) return;

	const configFile = ts.readConfigFile(tsconfigPath, ts.sys.readFile);
	if (configFile.error) return;

	const parsedConfig = ts.parseJsonConfigFileContent(
		configFile.config,
		ts.sys,
		getDirName(tsconfigPath),
	);

	const program = ts.createProgram({
		rootNames: parsedConfig.fileNames,
		options: parsedConfig.options,
	});

	for (const sourceFile of program.getSourceFiles()) {
		if (sourceFile.isDeclarationFile) continue;
		if (!allowNodeModules && sourceFile.fileName.includes('/node_modules/')) continue;

		ts.forEachChild(sourceFile, (node) => {
			if (ts.isClassDeclaration(node) && node.name) {
				const importSpecifier = packageRoot
					? resolvePackageImportSpecifier(node.name.text, packageRoot)
					: undefined;

				// Collect interface implementations for every class (no decorator required).
				for (const clause of node.heritageClauses ?? []) {
					if (clause.token !== ts.SyntaxKind.ImplementsKeyword) continue;
					for (const type of clause.types) {
						const interfaceName = ts.isIdentifier(type.expression) ? type.expression.text : undefined;
						if (!interfaceName) continue;

						// Always record in the full heritage map (used for @Bean-only classes in Phase 2).
						const heritageEntries = allClassHeritage.get(node.name.text) ?? [];
						if (!heritageEntries.some((e) => e.interfaceName === interfaceName && normalizeFilePath(e.filePath) === normalizeFilePath(sourceFile.fileName))) {
							heritageEntries.push({ interfaceName, filePath: sourceFile.fileName, importSpecifier });
							allClassHeritage.set(node.name.text, heritageEntries);
						}

						// Immediately add to implementations if the class is @Component()/@Service() decorated.
						if (!hasServiceDecorator(node)) continue;
						const existing = implementations.get(interfaceName) ?? [];
						if (existing.some((impl) => impl.className === node.name!.text && normalizeFilePath(impl.filePath) === normalizeFilePath(sourceFile.fileName))) {
							continue;
						}
						existing.push({ className: node.name.text, filePath: sourceFile.fileName, importSpecifier });
						implementations.set(interfaceName, existing);
					}
				}
			}

			// Collect @Bean() static method return types as candidates for Phase 2.
			if (ts.isClassDeclaration(node)) {
				for (const member of node.members) {
					if (!ts.isMethodDeclaration(member)) continue;
					const isStatic = (ts.getModifiers(member) ?? []).some((m) => m.kind === ts.SyntaxKind.StaticKeyword);
					if (!isStatic) continue;
					const memberDecs = ts.getDecorators(member) ?? member.modifiers?.filter(ts.isDecorator) ?? [];
					for (const dec of memberDecs) {
						if (!ts.isCallExpression(dec.expression)) continue;
						if (!ts.isIdentifier(dec.expression.expression)) continue;
						if (!isDIBeanDecoratorName(dec.expression.expression.text)) continue;
						// Use @Bean(ClassName) explicit arg when present, otherwise the method return type.
						const args = dec.expression.arguments;
						if (args.length > 0 && ts.isIdentifier(args[0])) {
							beanReturnTypes.add(args[0].text);
						} else if (member.type && ts.isTypeReferenceNode(member.type) && ts.isIdentifier(member.type.typeName)) {
							beanReturnTypes.add(member.type.typeName.text);
						}
					}
				}
			}
		});
	}
}

function hasServiceDecorator(classNode: ts.ClassDeclaration): boolean {
	// ts.getDecorators() may return undefined when the TypeScript program is compiled
	// without experimentalDecorators (stage-3 decorators). Fall back to scanning
	// node.modifiers directly, where decorators appear as Decorator-kind nodes.
	const decorators = ts.getDecorators(classNode) ?? classNode.modifiers?.filter(ts.isDecorator) ?? [];
	for (const decorator of decorators) {
		if (!ts.isCallExpression(decorator.expression)) continue;
		if (!ts.isIdentifier(decorator.expression.expression)) continue;
		if (isDIComponentDecoratorName(decorator.expression.expression.text)) return true;
	}
	return false;
}

function isDIComponentDecoratorName(name: string): boolean {
	return name === 'Service' || name === 'Component';
}

function isDIResolveFunctionName(name: string): boolean {
	return name === 'resolve' || name === 'getService';
}

function isDIBeanDecoratorName(name: string): boolean {
	return name === 'Bean' || name === 'Instance';
}

function collectTypeOnlySymbols(sourceFile: ts.SourceFile): Set<string> {
	const symbols = new Set<string>();

	// Type-only imports are always top-level
	for (const statement of sourceFile.statements) {
		if (ts.isImportDeclaration(statement) && statement.importClause) {
			const isEntirelyTypeOnly = statement.importClause.isTypeOnly;
			const bindings = statement.importClause.namedBindings;
			if (bindings && ts.isNamedImports(bindings)) {
				for (const element of bindings.elements) {
					if (isEntirelyTypeOnly || element.isTypeOnly) {
						symbols.add(element.name.text);
					}
				}
			}
		}
	}

	// Interface and type alias declarations can appear at any nesting level
	// (e.g., inside test function bodies), so we walk the full AST.
	function collectTypeDeclarations(node: ts.Node): void {
		if (ts.isInterfaceDeclaration(node) && node.name) {
			symbols.add(node.name.text);
		}
		if (ts.isTypeAliasDeclaration(node) && node.name) {
			symbols.add(node.name.text);
		}
		ts.forEachChild(node, collectTypeDeclarations);
	}
	collectTypeDeclarations(sourceFile);

	return symbols;
}

function collectDeclaredSymbols(sourceFile: ts.SourceFile): Set<string> {
	const symbols = new Set<string>();
	for (const statement of sourceFile.statements) {
		if (ts.isImportDeclaration(statement) && statement.importClause) {
			if (statement.importClause.name) {
				symbols.add(statement.importClause.name.text);
			}
			const namedBindings = statement.importClause.namedBindings;
			if (namedBindings && ts.isNamedImports(namedBindings)) {
				for (const element of namedBindings.elements) {
					symbols.add(element.name.text);
				}
			}
		}

		if (ts.isClassDeclaration(statement) && statement.name) {
			symbols.add(statement.name.text);
		}
	}
	return symbols;
}

function buildImportInsertions(
	code: string,
	sourceFile: ts.SourceFile,
	importsToInject: Map<string, Set<string>>,
	sideEffectImports: Set<string>,
	declaredSymbols: Set<string>,
): Replacement[] {
	const replacements: Replacement[] = [];

	for (const importPath of sideEffectImports) {
		if (!findImportByModule(sourceFile, importPath)) {
			const insertionPoint = getImportInsertionPoint(sourceFile);
			replacements.push({ start: insertionPoint, end: insertionPoint, text: `import '${importPath}';\n` });
		}
	}

	for (const [importPath, names] of importsToInject.entries()) {
		const unresolved = [...names].filter((name) => !declaredSymbols.has(name));
		if (unresolved.length === 0) continue;

		const existing = findImportByModule(sourceFile, importPath);
		if (existing && existing.importClause?.namedBindings && ts.isNamedImports(existing.importClause.namedBindings)) {
			const existingNames = new Set(existing.importClause.namedBindings.elements.map((element) => element.name.text));
			const missing = unresolved.filter((name) => !existingNames.has(name));
			if (missing.length === 0) continue;

			const namedImports = existing.importClause.namedBindings;
			replacements.push({
				start: namedImports.getStart(sourceFile) + 1,
				end: namedImports.getEnd() - 1,
				text: `${[...existingNames, ...missing].sort().join(', ')}`,
			});
			continue;
		}

		const insertionPoint = getImportInsertionPoint(sourceFile);
		replacements.push({
			start: insertionPoint,
			end: insertionPoint,
			text: `import { ${unresolved.sort().join(', ')} } from '${importPath}';\n`,
		});
	}

	return replacements;
}

function findImportByModule(sourceFile: ts.SourceFile, moduleSpecifier: string): ts.ImportDeclaration | undefined {
	for (const statement of sourceFile.statements) {
		if (!ts.isImportDeclaration(statement)) continue;
		if (!ts.isStringLiteral(statement.moduleSpecifier)) continue;
		if (statement.moduleSpecifier.text !== moduleSpecifier) continue;
		// Skip type-only imports — value imports must not be merged into them,
		// as type-only imports are erased at runtime.
		if (statement.importClause?.isTypeOnly) continue;
		return statement;
	}
	return undefined;
}

function getImportInsertionPoint(sourceFile: ts.SourceFile): number {
	let end = 0;
	for (const statement of sourceFile.statements) {
		if (!ts.isImportDeclaration(statement)) break;
		end = statement.getEnd();
	}
	if (end === 0) return 0;

	const fileText = sourceFile.getFullText();
	if (fileText[end] === '\r' && fileText[end + 1] === '\n') return end + 2;
	if (fileText[end] === '\n') return end + 1;
	return end;
}

function toImportPath(fromFile: string, toFile: string): string {
	const fromDir = getDirName(fromFile);
	const target = normalizeFilePath(toFile);
	let relativePath = getRelativePath(fromDir, target).replace(/\.(ts|tsx|js|jsx)$/, '');
	if (!relativePath.startsWith('.')) relativePath = `./${relativePath}`;
	return relativePath;
}

function normalizeFilePath(filePath: string): string {
	return filePath.replace(/\\/g, '/');
}

function getDirName(filePath: string): string {
	const normalized = normalizeFilePath(filePath);
	const slashIndex = normalized.lastIndexOf('/');
	return slashIndex >= 0 ? normalized.slice(0, slashIndex) : '.';
}

function getRelativePath(fromDir: string, toPath: string): string {
	const fromParts = normalizeFilePath(fromDir).split('/').filter(Boolean);
	const toParts = normalizeFilePath(toPath).split('/').filter(Boolean);

	if (fromParts[0]?.endsWith(':') && toParts[0]?.endsWith(':') && fromParts[0] !== toParts[0]) {
		return normalizeFilePath(toPath);
	}

	let shared = 0;
	while (shared < fromParts.length && shared < toParts.length && fromParts[shared] === toParts[shared]) {
		shared += 1;
	}

	const up = new Array(Math.max(fromParts.length - shared, 0)).fill('..');
	const down = toParts.slice(shared);
	const relative = [...up, ...down].join('/');
	return relative || '.';
}

function getConstructorDependencies(classNode: ts.ClassDeclaration): ConstructorDependency[] {
	const constructorDeclaration = classNode.members.find(ts.isConstructorDeclaration);
	if (!constructorDeclaration) return [];

	const dependencies: ConstructorDependency[] = [];
	for (const parameter of constructorDeclaration.parameters) {
		if (!parameter.type || !ts.isTypeReferenceNode(parameter.type)) continue;
		if (!ts.isIdentifier(parameter.type.typeName)) continue;
		dependencies.push({
			typeName: parameter.type.typeName.text,
			paramName: ts.isIdentifier(parameter.name) ? parameter.name.text : undefined,
		});
	}
	return dependencies;
}

function pickImplementationForParameter(dependency: ConstructorDependency, candidates: InterfaceImplementation[]): InterfaceImplementation | undefined {
	if (candidates.length === 1) return candidates[0];
	if (!dependency.paramName) return undefined;

	const normalizedParameterName = normalizeSymbolName(dependency.paramName);
	for (const candidate of candidates) {
		if (normalizeSymbolName(candidate.className) === normalizedParameterName) return candidate;
		if (normalizeSymbolName(toCamelCase(candidate.className)) === normalizedParameterName) return candidate;

		const parameterWithoutServiceSuffix = stripServiceSuffix(normalizedParameterName);
		const candidateWithoutServiceSuffix = stripServiceSuffix(normalizeSymbolName(toCamelCase(candidate.className)));
		if (candidateWithoutServiceSuffix === parameterWithoutServiceSuffix) return candidate;
	}

	return undefined;
}

function toCamelCase(name: string): string {
	if (name.length === 0) return name;
	return name[0].toLowerCase() + name.slice(1);
}

function normalizeSymbolName(name: string): string {
	return name.replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
}

function stripServiceSuffix(name: string): string {
	return name.endsWith('service') ? name.slice(0, -'service'.length) : name;
}

/**
 * Resolves extra scan directories to absolute paths.
 * Relative paths are resolved relative to the project root.
 */
function resolveExtraScanDirs(root: string, extraScanDirs?: string[]): string[] {
	if (!extraScanDirs || extraScanDirs.length === 0) return [];
	return extraScanDirs.map((dir) => (isAbsolute(dir) ? dir : resolvePath(root, dir)));
}

/**
 * Walks up from `startDir` until it finds a directory containing a `package.json`.
 * Returns that directory, or undefined if none is found.
 */
function findPackageRoot(startDir: string): string | undefined {
	let current = startDir;
	while (true) {
		if (existsSync(joinPath(current, 'package.json'))) return current;
		const parent = dirname(current);
		if (parent === current) return undefined;
		current = parent;
	}
}

/**
 * Given a class name and the root directory of its package, resolves the package
 * import specifier by scanning the package's
 * compiled dist barrel files for the class name.
 */
function resolvePackageImportSpecifier(className: string, packageRoot: string): string | undefined {
	try {
		const pkgJsonPath = joinPath(packageRoot, 'package.json');
		if (!existsSync(pkgJsonPath)) return undefined;

		const pkgJson = JSON.parse(readFileSync(pkgJsonPath, 'utf-8'));
		const packageName = pkgJson.name as string | undefined;
		if (!packageName) return undefined;

		const exports = pkgJson.exports as Record<string, unknown> | undefined;
		if (!exports) return undefined;

		for (const [subPath, entry] of Object.entries(exports)) {
			const typesFile =
				typeof entry === 'string'
					? entry
					: (entry as Record<string, unknown>)?.types as string | undefined;
			if (!typesFile || !typesFile.endsWith('.d.ts')) continue;

			const absTypesFile = joinPath(packageRoot, typesFile);
			if (!existsSync(absTypesFile)) continue;

			const content = readFileSync(absTypesFile, 'utf-8');
			if (new RegExp(`\\b${className}\\b`).test(content)) {
				const normalizedSub = subPath === '.' ? '' : subPath.replace(/^\./, '');
				return packageName + normalizedSub;
			}
		}
	} catch {
		// ignore — fall back to relative path
	}
	return undefined;
}
