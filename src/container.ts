import 'reflect-metadata';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Constructor<T = unknown> = new (...constructorArguments: any[]) => T;
type InjectionToken<T = unknown> = Constructor<T> | object;

interface ComponentRegistration {
	dependencies: InjectionToken[];
	instance?: unknown;
	factory?: () => unknown;
}

const containerRegistry = new Map<InjectionToken, ComponentRegistration>();
const deferredBeans: Array<() => void> = [];

export function Service(dependencies?: InjectionToken[]): ClassDecorator {
	return (target) => {
		const resolvedDependencies: InjectionToken[] = dependencies ?? Reflect.getMetadata('design:paramtypes', target) ?? [];
		containerRegistry.set(target as unknown as Constructor, { dependencies: resolvedDependencies });
	};
}

/** Alias for Service(). */
export function Component(dependencies?: InjectionToken[]): ClassDecorator {
	return Service(dependencies);
}

export function getService<T>(): T;
export function getService<T>(componentToken: InjectionToken<T>, resolving?: Set<InjectionToken>): T;
export function getService<T>(componentToken?: InjectionToken<T>, resolving = new Set<InjectionToken>()): T {
	if (!componentToken) {
		throw new Error(
			'WireWeaver: getService<T>() called without a token argument. ' +
			'Ensure the WireWeaver Vite or esbuild plugin is configured to rewrite interface resolve calls at build time.',
		);
	}
	let registration = findRegistration(componentToken);

	// Drain deferred no-arg @Bean factories one at a time until the requested class is found.
	// This allows @Bean()-decorated methods to resolve lazily regardless of declaration order.
	if (!registration) throw new Error(`${tokenToDisplayName(componentToken)} is not registered as a WireWeaver Component.`);

	if (registration.instance !== undefined) return registration.instance as T;

	if (registration.factory) {
		registration.instance = registration.factory();
		return registration.instance as T;
	}

	if (resolving.has(componentToken)) {
		throw new Error(`Circular dependency detected: ${tokenToDisplayName(componentToken)}`);
	}
	resolving.add(componentToken);

	const constructorArguments = registration.dependencies.map((dependency) => {
		if (!findRegistration(dependency) && isEnumToken(dependency)) {
			return undefined;
		}
		return getService(dependency, resolving);
	});
	const instance = new (componentToken as Constructor<T>)(...constructorArguments);

	registration.instance = instance;
	resolving.delete(componentToken);

	return instance;
}

/** Alias for getService(). */
export function resolve<T>(): T;
export function resolve<T>(componentToken: InjectionToken<T>, resolving?: Set<InjectionToken>): T;
export function resolve<T>(componentToken?: InjectionToken<T>, resolving = new Set<InjectionToken>()): T {
	return getService(componentToken as InjectionToken<T>, resolving);
}

/** Clear all registrations and singletons (useful for testing). */
export function resetRegistry(): void {
	containerRegistry.clear();
	deferredBeans.length = 0;
}

export function Bean<T>(registrationToken?: InjectionToken<T>): MethodDecorator {
	return (target, _propertyKey, descriptor) => {
		if (typeof target !== 'function') {
			throw new Error(
				'WireWeaver: @Bean() is only supported on static methods. ' +
				'Move the method to a static method, or use @Service() for constructor-injected classes.',
			);
		}

		const method = descriptor.value as (() => T) | undefined;
		if (typeof method !== 'function') return;

		const factory = () => {
			return method.call(target) as T;
		};

		// Determine the key. For interface return types the plugin will have supplied registrationToken.
		// For concrete return types without the plugin, we defer the factory until the key is first
		// requested — this avoids eager evaluation which breaks ordering guarantees.
		if (registrationToken) {
			containerRegistry.set(registrationToken, { dependencies: [], factory });
		} else {
			// No explicit key — push a deferred factory that discovers its own key on first run.
			deferredBeans.push(() => {
				const instance = method.call(target) as T;
				if (instance == null || typeof instance !== 'object') {
					throw new Error(
						'WireWeaver: @Bean() could not determine a registration key. ' +
						'Annotate the return type and configure the Vite/esbuild plugin, or pass the class explicitly: @Bean(ClassName).',
					);
				}
				const key = (instance as object).constructor as Constructor<T>;
				containerRegistry.set(key, { dependencies: [], instance });
			});
		}
	};
}

/** Alias for Bean(). */
export function Instance<T>(registrationToken?: InjectionToken<T>): MethodDecorator {
	return Bean(registrationToken);
}

function findRegistration(token: InjectionToken): ComponentRegistration | undefined {
	let registration = containerRegistry.get(token);
	while (!registration && deferredBeans.length > 0) {
		const deferred = deferredBeans.shift()!;
		deferred();
		registration = containerRegistry.get(token);
	}
	return registration;
}

function tokenToDisplayName(token: InjectionToken): string {
	if (typeof token === 'function' && token.name) return token.name;
	if (isEnumToken(token)) return 'Enum token';
	return 'Unknown token';
}

function isEnumToken(token: InjectionToken): token is object {
	if (typeof token !== 'object' || token == null || Array.isArray(token)) return false;
	const entries = Object.entries(token as Record<string, unknown>);
	if (entries.length === 0) return false;
	return entries.every(([key, value]) => {
		const isEnumKey = /^\d+$/.test(key) || /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key);
		return isEnumKey && (typeof value === 'string' || typeof value === 'number');
	});
}
