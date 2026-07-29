import { describe, it, expect } from 'vitest';
import { transformSource, wireWeaverPlugin } from '../src/vite-plugin.js';

describe('transformSource', () => {
	it('rewrites @Service() to @Service([Dependency]) for a single constructor dependency', () => {
		const input = `
			@Service()
			class UserService {
				constructor(private repository: UserRepository) {}
			}`.trim();

		const result = transformSource(input, 'user-service.ts');
		expect(result).not.toBeNull();
		expect(result!.code).toContain('Service([UserRepository])');
		expect(result!.code).not.toMatch(/@Service\(\)/);
	});

	it('rewrites @Service() with multiple dependencies in correct order', () => {
		const input = `
			@Service()
			class App {
				constructor(private a: ServiceA, private b: ServiceB) {}
			}`.trim();

		const result = transformSource(input, 'app.ts');
		expect(result).not.toBeNull();
		expect(result!.code).toContain('Service([ServiceA, ServiceB])');
	});

	it('rewrites @Component() to @Component([Dependency]) for constructor dependencies', () => {
		const input = `
			@Component()
			class UserService {
				constructor(private repository: UserRepository) {}
			}`.trim();

		const result = transformSource(input, 'user-service.ts');
		expect(result).not.toBeNull();
		expect(result!.code).toContain('Component([UserRepository])');
		expect(result!.code).not.toMatch(/@Component\(\)/);
	});

	it('returns null for a dependency-free class (no rewrite needed)', () => {
		const input = `
			@Service()
			class Logger {}`.trim();

		expect(transformSource(input, 'logger.ts')).toBeNull();
	});

	it('returns null when @Service already has explicit arguments', () => {
		const input = `
			@Service([Dependency])
			class ServiceClass {
				constructor(private dependency: Dependency) {}
			}`.trim();

		expect(transformSource(input, 'service.ts')).toBeNull();
	});

	it('returns null when @Component already has explicit arguments', () => {
		const input = `
			@Component([Dependency])
			class ServiceClass {
				constructor(private dependency: Dependency) {}
			}`.trim();

		expect(transformSource(input, 'service.ts')).toBeNull();
	});

	it('handles multiple @Service() classes in one file independently', () => {
		const input = `
			@Service()
			class A {
				constructor(private b: B) {}
			}

			@Service()
			class B {}`.trim();

		const result = transformSource(input, 'multi.ts');
		expect(result).not.toBeNull();
		expect(result!.code).toContain('Service([B])');
		expect(result!.code).toMatch(/@Service\(\)\n\s*class B/);
	});

	it('excludes primitive-typed params (string is a KeywordTypeNode, not TypeReferenceNode)', () => {
		const input = `
			@Service()
			class ServiceClass {
				constructor(private name: string) {}
			}`.trim();

		expect(transformSource(input, 'service.ts')).toBeNull();
	});

	it('excludes union-typed params', () => {
		const input = `
			@Service()
			class ServiceClass {
				constructor(private x: A | B) {}
			}`.trim();

		expect(transformSource(input, 'service.ts')).toBeNull();
	});

	it('rewrites enum constructor dependencies for @Component()', () => {
		const input = `
			enum LogLevel {
				DEBUG = 'debug',
				INFO = 'info',
			}

			@Component()
			class Logger {
				constructor(private level: LogLevel = LogLevel.INFO) {}
			}`.trim();

		const result = transformSource(input, 'logger.ts');
		expect(result).not.toBeNull();
		expect(result!.code).toContain('Component([LogLevel])');
	});

	it('does not rewrite decorators named something other than Service', () => {
		const input = `
			@Injectable()
			class ServiceClass {
				constructor(private dependency: Dependency) {}
			}`.trim();

		expect(transformSource(input, 'service.ts')).toBeNull();
	});

	it('returns null for a file with no @Service decorators', () => {
		expect(transformSource('export const x = 1;', 'constants.ts')).toBeNull();
	});

	it('maps interface constructor types to discovered concrete services', () => {
		const input = `
			import type { ILogger } from './ilogger';

			@Service()
			class AppService {
				constructor(private logger: ILogger) {}
			}`.trim();

		const result = (transformSource as (...argumentsList: unknown[]) => { code: string } | null)(
			input,
			'/project/src/app.ts',
			new Map([
				['ILogger', [{ className: 'ConsoleLogger', filePath: '/project/src/logger.ts' }]],
			]),
		);

		expect(result).not.toBeNull();
		expect(result!.code).toContain("import { ConsoleLogger } from './logger';");
		expect(result!.code).toContain('Service([ConsoleLogger])');
	});

	it('does not inject an import when the mapped implementation is declared in the same file', () => {
		const input = `
			interface ILogger {}

			@Service()
			class ConsoleLogger implements ILogger {}

			@Service()
			class AppService {
				constructor(private logger: ILogger) {}
			}`.trim();

		const result = (transformSource as (...argumentsList: unknown[]) => { code: string } | null)(
			input,
			'/project/src/app.ts',
			new Map([
				['ILogger', [{ className: 'ConsoleLogger', filePath: '/project/src/app.ts' }]],
			]),
		);

		expect(result).not.toBeNull();
		expect(result!.code).toContain('Service([ConsoleLogger])');
		expect(result!.code).not.toContain("import { ConsoleLogger }");
	});

	it('resolves multiple implementations of the same interface by constructor parameter name', () => {
		const input = `
			import type { StorageService } from './storage-service';

			@Service()
			class UserDataService {
				constructor(
					private localStorageService: StorageService,
					private cloudStorageService: StorageService,
				) {}
			}
		`.trim();

		const result = transformSource(
			input,
			'/project/src/user-data-service.ts',
			new Map([
				[
					'StorageService',
					[
						{ className: 'LocalStorageService', filePath: '/project/src/local-storage-service.ts' },
						{ className: 'CloudStorageService', filePath: '/project/src/cloud-storage-service.ts' },
					],
				],
			]),
		);

		expect(result).not.toBeNull();
		expect(result!.code).toContain("import { LocalStorageService } from './local-storage-service';");
		expect(result!.code).toContain("import { CloudStorageService } from './cloud-storage-service';");
		expect(result!.code).toContain('Service([LocalStorageService, CloudStorageService])');
	});

	it('throws when multiple interface implementations exist but parameter names do not match', () => {
		const input = `
			import type { StorageService } from './storage-service';

			@Service()
			class UserDataService {
				constructor(private primary: StorageService) {}
			}
		`.trim();

		expect(() =>
			transformSource(
				input,
				'/project/src/user-data-service.ts',
				new Map([
					[
						'StorageService',
						[
							{ className: 'LocalStorageService', filePath: '/project/src/local-storage-service.ts' },
							{ className: 'CloudStorageService', filePath: '/project/src/cloud-storage-service.ts' },
						],
					],
				]),
			),
		).toThrow('multiple implementations found for StorageService');
	});

	it('rewrites resolve<IFoo>() to resolve(ConcreteClass) for a single implementation', () => {
		const result = (transformSource as (...args: unknown[]) => { code: string } | null)(
			`const service = resolve<ILogger>();`,
			'/project/src/app.ts',
			new Map([
				['ILogger', [{ className: 'ConsoleLogger', filePath: '/project/src/logger.ts' }]],
			]),
		);

		expect(result).not.toBeNull();
		expect(result!.code).toContain("import { ConsoleLogger } from './logger';");
		expect(result!.code).toContain('resolve(ConsoleLogger)');
	});

	it('rewrites getService<IFoo>() to getService(ConcreteClass) for a single implementation', () => {
		const result = (transformSource as (...args: unknown[]) => { code: string } | null)(
			`const service = getService<ILogger>();`,
			'/project/src/app.ts',
			new Map([
				['ILogger', [{ className: 'ConsoleLogger', filePath: '/project/src/logger.ts' }]],
			]),
		);

		expect(result).not.toBeNull();
		expect(result!.code).toContain("import { ConsoleLogger } from './logger';");
		expect(result!.code).toContain('getService(ConsoleLogger)');
	});

	it('does not inject an import when the mapped implementation is in the same file', () => {
		const input = `
			interface ILogger {}
			class ConsoleLogger implements ILogger {}
			const service = resolve<ILogger>();
		`.trim();

		const result = (transformSource as (...args: unknown[]) => { code: string } | null)(
			input,
			'/project/src/app.ts',
			new Map([
				['ILogger', [{ className: 'ConsoleLogger', filePath: '/project/src/app.ts' }]],
			]),
		);

		expect(result).not.toBeNull();
		expect(result!.code).toContain('resolve(ConsoleLogger)');
		expect(result!.code).not.toContain('import { ConsoleLogger }');
	});

	it('throws for resolve<IFoo>() when multiple implementations exist', () => {
		expect(() =>
			(transformSource as (...args: unknown[]) => { code: string } | null)(
				`const service = resolve<StorageService>();`,
				'/project/src/app.ts',
				new Map([
					[
						'StorageService',
						[
							{ className: 'LocalStorageService', filePath: '/project/src/local.ts' },
							{ className: 'CloudStorageService', filePath: '/project/src/cloud.ts' },
						],
					],
				]),
			),
		).toThrow('multiple implementations found for StorageService');
	});

	it('leaves resolve<IFoo>() untouched when no implementation is registered', () => {
		const input = `const service = resolve<IUnknown>();`;
		const result = transformSource(input, '/project/src/app.ts', new Map());
		expect(result).toBeNull();
	});

	it('rewrites @Bean() on a static method with a concrete return type', () => {
		const input = `
			class AppConfig {
				@Bean()
				static createLogger(): Logger {
					return new Logger();
				}
			}`.trim();

		const result = transformSource(input, '/project/src/app.ts');
		expect(result).not.toBeNull();
		expect(result!.code).toContain('Bean(Logger)');
		expect(result!.code).not.toMatch(/@Bean\(\)/);
	});

	it('rewrites @Bean() on a static method with an enum return type', () => {
		const input = `
			enum LogLevel {
				DEBUG = 'debug',
				INFO = 'info',
			}

			class AppConfig {
				@Bean()
				static createLogLevel(): LogLevel {
					return LogLevel.DEBUG;
				}
			}`.trim();

		const result = transformSource(input, '/project/src/app.ts');
		expect(result).not.toBeNull();
		expect(result!.code).toContain('Bean(LogLevel)');
	});

	it('rewrites @Instance() on a static method with a concrete return type', () => {
		const input = `
			class AppConfig {
				@Instance()
				static createLogger(): Logger {
					return new Logger();
				}
			}`.trim();

		const result = transformSource(input, '/project/src/app.ts');
		expect(result).not.toBeNull();
		expect(result!.code).toContain('Instance(Logger)');
	});

	it('rewrites @Bean() on a static method with an interface return type and injects the import', () => {
		const result = (transformSource as (...args: unknown[]) => { code: string } | null)(
			`
			class AppConfig {
				@Bean()
				static createLogger(): ILogger {
					return new ConsoleLogger();
				}
			}`.trim(),
			'/project/src/app.ts',
			new Map([
				['ILogger', [{ className: 'ConsoleLogger', filePath: '/project/src/logger.ts' }]],
			]),
		);

		expect(result).not.toBeNull();
		expect(result!.code).toContain("import { ConsoleLogger } from './logger';");
		expect(result!.code).toContain('Bean(ConsoleLogger)');
	});

	it('does not rewrite @Bean() that already has an explicit argument', () => {
		const input = `
			class AppConfig {
				@Bean(Logger)
				static createLogger(): Logger {
					return new Logger();
				}
			}`.trim();

		expect(transformSource(input, '/project/src/app.ts')).toBeNull();
	});

	it('does not rewrite @Bean() on a non-static method', () => {
		const input = `
			class AppConfig {
				@Bean()
				createLogger(): Logger {
					return new Logger();
				}
			}`.trim();

		expect(transformSource(input, '/project/src/app.ts')).toBeNull();
	});

	it('throws for @Bean() when the interface return type has multiple implementations', () => {
		expect(() =>
			(transformSource as (...args: unknown[]) => { code: string } | null)(
				`
				class AppConfig {
					@Bean()
					static createStorage(): StorageService {
						return new LocalStorageService();
					}
				}`.trim(),
				'/project/src/app.ts',
				new Map([
					[
						'StorageService',
						[
							{ className: 'LocalStorageService', filePath: '/project/src/local.ts' },
							{ className: 'CloudStorageService', filePath: '/project/src/cloud.ts' },
						],
					],
				]),
			),
		).toThrow('@Bean() has multiple implementations for return type StorageService');
	});

	it('discovers and resolves named interface mappings across files through the plugin', async () => {
		const plugin = wireWeaverPlugin();
		const fixtureRoot = decodeURIComponent(new URL('../src/__fixtures__/named-interface-mapping', import.meta.url).pathname);
		const configResolvedHook = typeof plugin.configResolved === 'function' ? plugin.configResolved : plugin.configResolved?.handler;
		await (configResolvedHook as ((c: { root: string }) => void) | undefined)?.call({} as never, { root: fixtureRoot });
		const buildStartHook = typeof plugin.buildStart === 'function' ? plugin.buildStart : plugin.buildStart?.handler;
		await (buildStartHook as (() => void) | undefined)?.call({} as never);
		const transformHook = typeof plugin.transform === 'function' ? plugin.transform : plugin.transform?.handler;
		const fixtureAppPath = decodeURIComponent(new URL('../src/__fixtures__/named-interface-mapping/user-data-service.ts', import.meta.url).pathname);
		const fixtureAppCode = `
			import { Service } from '../../container';
			import type { StorageService } from './storage-service';

			@Service()
			export class UserDataService {
				constructor(
					private localStorageService: StorageService,
					private cloudStorageService: StorageService,
				) {}
			}
		`.trim();

		expect(transformHook).toBeTypeOf('function');
		const result = await transformHook?.call({} as never, fixtureAppCode, fixtureAppPath);
		expect(result).not.toBeNull();
		expect(result && typeof result === 'object' ? result.code : '').toContain("import { LocalStorageService } from './local-storage-service';");
		expect(result && typeof result === 'object' ? result.code : '').toContain("import { CloudStorageService } from './cloud-storage-service';");
		expect(result && typeof result === 'object' ? result.code : '').toContain('Service([LocalStorageService, CloudStorageService])');
	});

	it('discovers interface mappings across files through the plugin (ILogger -> ConsoleLogger)', async () => {
		const plugin = wireWeaverPlugin();
		const fixtureRoot = decodeURIComponent(new URL('../src/__fixtures__/interface-mapping', import.meta.url).pathname);
		const configResolvedHook = typeof plugin.configResolved === 'function' ? plugin.configResolved : plugin.configResolved?.handler;
		await (configResolvedHook as ((c: { root: string }) => void) | undefined)?.call({} as never, { root: fixtureRoot });
		const buildStartHook = typeof plugin.buildStart === 'function' ? plugin.buildStart : plugin.buildStart?.handler;
		await (buildStartHook as (() => void) | undefined)?.call({} as never);
		const transformHook = typeof plugin.transform === 'function' ? plugin.transform : plugin.transform?.handler;
		const fixtureAppPath = decodeURIComponent(new URL('../src/__fixtures__/interface-mapping/app.ts', import.meta.url).pathname);
		const fixtureAppCode = `
			import { Service } from 'wireweaver';
			import type { ILogger } from './ilogger';

			@Service()
			export class AppService {
				constructor(private logger: ILogger) {}
			}
		`.trim();

		expect(transformHook).toBeTypeOf('function');
		const result = await transformHook?.call({} as never, fixtureAppCode, fixtureAppPath);
		expect(result).not.toBeNull();
		expect(result && typeof result === 'object' ? result.code : '').toContain("import { ConsoleLogger } from './logger';");
		expect(result && typeof result === 'object' ? result.code : '').toContain('Service([ConsoleLogger])');
	});
});
