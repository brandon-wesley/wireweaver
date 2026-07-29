# Philosophy

This library is intended to be simpler than TSyringe, Inversify and other DI libraries.

## Goals:
- provider-side declaration only
- no injection-site tokens
- minimal boilerplate
- constructor injection only
- interface-oriented DI
- avoid manual registration
- strongly typed
- minimal runtime magic


## Non-goals

This library intentionally does NOT support:
- property injection
- method injection
- interception
- AOP
- child containers
- middleware
- request scopes
- dynamic module systems
- Angular/Nest-style modules

# Desired API
```ts
// ilogger.ts
interface ILogger {
	error(message: string, e?: Error);
}

// logger.ts
@Service()
class ConsoleLogger implements ILogger {
	// ... implementation
}

// app.ts
@Service()
class AppService {
	constructor(private logger: ILogger) {}
}
```
No `@Inject()` should be required in consumers.
Notice, there are no tokens, so I would like to use a compile-time transformer step to perform the injection. I would like the @Service() decorator to register the ConsoleLogger and AppService components in the core DI container behind the scenes.