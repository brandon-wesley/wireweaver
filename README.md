# WireWeaver

A lightweight TypeScript dependency injection (DI) library. Constructor injection only, no tokens, no boilerplate.

[![npm version](https://img.shields.io/npm/v/wireweaver.svg)](https://www.npmjs.com/package/wireweaver) [![license](https://img.shields.io/npm/l/wireweaver.svg)](./LICENSE)

## Table of Contents

-   [Philosophy](#philosophy)
-   [Features](#features)
-   [Installation and Usage](#installation-and-usage)
    -   [1. Install the package](#1-install-the-package)
    -   [2. Setup the build plugin (Vite is recommended)](#2-setup-the-build-plugin-vite-is-recommended)
    -   [3. Start declaring and injecting dependencies](#3-start-declaring-and-injecting-dependencies)
    -   [Example Usage](#example-usage)
    -   [Resolving by interface](#resolving-by-interface)
-   [Factories](#factories)
-   [Enum beans (config tokens)](#enum-beans-config-tokens)
-   [esbuild Plugin](#esbuild-plugin)
-   [Usage Without Plugin](#usage-without-plugin)

## Philosophy

Inspired by the simplicity of Spring Framework's DI container and aspects of TSyringe, WireWeaver is designed with one core idea: code should be as simple as possible.

It should be optimized for maximum readability so that it's easy to understand and easy to change, without sacrificing features. Complexity should be handled behind the scenes so that the developer is free to write clean code without extra boilerplate or unnecessary repetition.

Many other TypeScript DI libraries require extra code which we find unnecessary:

-   ❌ Manual construction of dependencies
-   ❌ Manual registration of dependencies, e.g. `container.register(...)`
-   ❌ Lack of support for interface registration, or requiring string or symbol tokens for it
-   ❌ Using `@Inject()` or other decorators at the injection site

## Features

-   ✅ Auto-instantiation and registration of dependencies
    -   no `new` calls, no `container.register()`, no `@Inject()` decorators.
-   ✅ Auto-injection of dependencies
    -   no `@Inject()` decorators are required
-   ✅ Simple interface injection
    -   dependencies are resolved by type, not by string or symbol tokens.
    -   specific instances of interfaces having multiple implementations are resolved by constructor parameter name (e.g. `localStorageService` resolves to `LocalStorageService`).
-   ✅ Support for factories
    -   Use `@Bean()` / `@Instance()` decorators to register manually constructed instances (useful for third-party classes, env-driven config, or any value requiring custom construction logic).
-   ✅ Support for enum values as beans (config tokens)

A build-time transformer (Vite or esbuild plugin) rewrites `@Service()` / `@Component()` decorators to perform injection without needing `emitDecoratorMetadata`, `reflect-metadata`, or interface tokens. All instances are singletons. Calling `resolve()` multiple times returns the same instance. No scopes or child containers are supported at this time.

## Installation and Usage

### 1. Install the package

```sh
npm install wireweaver
```

### 2. Setup the build plugin (Vite is recommended)

If your app uses Vite (including [Quasar](https://quasar.dev/), Nuxt, SvelteKit, etc.), add the wireweaver plugin to your `vite.config.ts`. Alternatively, you may use the [esbuild Plugin](#esbuild-plugin).

```ts
// vite.config.ts
import { defineConfig } from 'vite';
import { wireWeaverPlugin } from 'wireweaver/vite-plugin';

export default defineConfig({
	plugins: [
		wireWeaverPlugin(),
	],
});
```

### 3. Start declaring and injecting dependencies

Decorate your classes with `@Service()`. `@Component()` is available as a semantic alias for `@Service()`. Call `resolve()` (or `getService()`) to get an instance. Dependencies are injected automatically. That's it. The plugin handles all the hard work.

### Example Usage

```ts
interface StorageService {
	save(key: string, value: unknown): void;
}

@Service()
class LocalStorageService implements StorageService {
	save(key: string, value: unknown) {}
}

@Service()
class CloudStorageService implements StorageService {
	save(key: string, value: unknown) {}
}


@Service()
class UserDataService {
	// When multiple services implement the same interface, use descriptive constructor parameter names so the DI container can correctly resolve each implementation.
  constructor(
		private localStorageService: StorageService,
		private cloudStorageService: StorageService,
	) {}
}

const userDataService = resolve(UserDataService);
```

```ts
import { Service, Component, resolve } from 'wireweaver';
// The difference between @Service() and @Component() is purely semantic.

@Component()
interface IUserRepository {}

@Component()
class UserRepository implements IUserRepository {}

@Service()
class UserService {
	constructor(private repository: IUserRepository) {}
}

const userService = resolve(UserService);
const userRepository = resolve(UserRepository);
```

### Resolving by interface

When using the Vite or esbuild plugin, you can also call `resolve` with an interface type parameter and no runtime argument. The plugin rewrites the call to pass the concrete class at build time:

```ts
// Rewritten by the plugin to resolve(UserRepository) at build time
const repo = resolve<IUserRepository>();
```

If multiple classes implement the same interface, use `resolve(ConcreteClass)` directly to disambiguate.

## Factories

Use `@Bean()` (or its alias `@Instance()`) on **static methods** of any class to manually construct and register an instance. This is useful for third-party classes, environment-driven configuration, or anything that needs custom construction logic.

```ts
// app-config.ts
import { Bean, resolve } from 'wireweaver';

export class AppConfig {
    @Bean()
    static databaseConnection(): DatabaseConnection {
        return new DatabaseConnection(process.env.DB_URL);
    }

    @Bean()
    static userRepository(): IUserRepository {
        return new UserRepository(resolve(DatabaseConnection));
    }
}
```

```ts
// main.ts
import './app-config'; // Import your configuration files early to ensure @Bean() decorators are evaluated and instances are registered
```

The `@Bean()` decorators fire when the module is first imported. The factory method itself is called **lazily** on the first `resolve()` of that type, so declaration order within the class does not matter — cross-bean dependencies are resolved correctly at runtime.

The Vite/esbuild plugin rewrites `@Bean()` to `@Bean(ConcreteClass)` at build time. For concrete return types this also works **without the plugin** since the key is inferred from `instance.constructor`.

## Enum beans (config tokens)

You can also register enum values as beans by using the enum object itself as the token. This is useful for app-level config like log levels.

```ts
// logger.ts
import { Component } from 'wireweaver';

export enum LogLevel {
	DEBUG = 'debug',
	INFO = 'info',
	WARN = 'warn',
}

@Component()
export class Logger {
	constructor(private readonly level: LogLevel = LogLevel.INFO) {}
}
```

```ts
// app-config.ts (consumer app)
import { Bean } from 'wireweaver';
import { LogLevel } from './logger';

export class AppConfig {
	@Bean()
	static loggerLogLevel(): LogLevel {
		return LogLevel.WARN;
	}
```

If no `@Bean(LogLevel)` is registered, enum dependencies are injected as `undefined`, so constructor defaults (like `LogLevel.INFO`) apply automatically.

## esbuild Plugin

For non-Vite pipelines that use esbuild directly, use `wireWeaverEsbuildPlugin`:

```ts
// esbuild.config.ts
import { build } from 'esbuild';
import { wireWeaverEsbuildPlugin } from 'wireweaver/vite-plugin';

await build({
    ...,
	plugins: [
		wireWeaverEsbuildPlugin(),
	],
});
```

The esbuild plugin provides the same compile-time transforms as the Vite plugin:

-   Rewrites `@Service()` / `@Component()` decorators with resolved constructor dependencies.
-   Rewrites `resolve<IFoo>()` / `getService<IFoo>()` calls to pass the concrete implementation class.

## Usage Without Plugin

If you are not using the Vite or esbuild plugin, you can declare dependencies explicitly:

```ts
@Service()
class UserRepository implements IUserRepository {}

@Service([UserRepository])
class UserService {
	constructor(private repository: IUserRepository) {}
}
```

Or, for tsc-based pipelines, enable `emitDecoratorMetadata` in your `tsconfig.json` and import `reflect-metadata` in your app entry point:

```ts
// main.ts
import 'reflect-metadata';
```

```json
{
	"compilerOptions": {
		"experimentalDecorators": true,
		"emitDecoratorMetadata": true
	}
}
```