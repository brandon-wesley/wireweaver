import { describe, it, expect, beforeEach } from 'vitest';
import { Service, Component, Bean, Instance, getService, resolve, resetRegistry } from '../src/container.js';

beforeEach(() => resetRegistry());



describe('@Service / getService', () => {
	it('gets a service with no dependencies', () => {
		@Service()
		class Logger {
		}

		expect(getService(Logger)).toBeInstanceOf(Logger);
	});

	it('returns the same singleton instance on repeated calls', () => {
		@Service()
		class Logger {
		}

		expect(getService(Logger)).toBe(getService(Logger));
	});

	it('recursively resolves constructor dependencies', () => {
		@Service()
		class Repository {
		}

		@Service()
		class ServiceOne {
			constructor(public repository: Repository) {
			}
		}

		const serviceInstance = getService(ServiceOne);
		expect(serviceInstance).toBeInstanceOf(ServiceOne);
		expect(serviceInstance.repository).toBeInstanceOf(Repository);
	});
	
	it('resolves implementations of interfaces', () => {
		interface StoreService {
			save(key: string, value: unknown): void;
		}

		@Service()
		class S3StorageService implements StoreService {
			save(key: string, value: unknown) {}
		}
		
		const service = resolve<StoreService>();
		expect(service).toBeInstanceOf(S3StorageService);
	});
	
	it('resolves beans in the correct order', () => {
		interface IDatabaseConnection {
			connect(url: string): Promise<void>;
		}

		class DatabaseConnection implements IDatabaseConnection {
			connect(url: string): Promise<void> {
				return Promise.resolve();
			}
		}

		// @Component registered before @Bean — ordering must not matter
		@Component()
		class UserRepository {
			constructor(public readonly database: IDatabaseConnection) {}
			save(data: unknown): Promise<void> {
				return Promise.resolve(undefined);
			}
		}

		class AppConfig {
			@Bean()
			static databaseConnection(): IDatabaseConnection {
				return new DatabaseConnection();
			}
		}

		const repository = resolve(UserRepository);
		expect(repository.database).toBeInstanceOf(DatabaseConnection);
	});
	
	it('resolves nested dependencies', () => {
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
			constructor(
				public readonly localStorageService: StorageService,
				public readonly cloudStorageService: StorageService,
			) {}
		}
		
		const service = resolve(UserDataService);
		expect(service).toBeInstanceOf(UserDataService);
		expect(service.localStorageService).toBeInstanceOf(LocalStorageService);
		expect(service.cloudStorageService).toBeInstanceOf(CloudStorageService);
	});

	it('shares singleton instances across the graph', () => {
		@Service()
		class Database {
		}

		@Service()
		class RepositoryA {
			constructor(public database: Database) {
			}
		}

		@Service()
		class RepositoryB {
			constructor(public database: Database) {
			}
		}

		@Service()
		class App {
			constructor(public repositoryA: RepositoryA, public repositoryB: RepositoryB) {
			}
		}

		const app = getService(App);
		expect(app.repositoryA.database).toBe(app.repositoryB.database); // same Database instance
	});

	it('throws when resolving an unregistered class', () => {
		class Unknown {
		}

		expect(() => getService(Unknown)).toThrow('Unknown is not registered');
	});

	it('uses explicitly provided dependencies array (no emitDecoratorMetadata needed)', () => {
		@Service()
		class Repository {
		}

		@Service([Repository])
		class ServiceWithExplicitDependencies {
			constructor(public repository: Repository) {
			}
		}

		expect(getService(ServiceWithExplicitDependencies).repository).toBeInstanceOf(Repository);
	});

	it('detects circular dependencies', () => {
		@Service()
		class A {
			constructor(public b: object) {}
		}

		// Simulate a cycle by pre-seeding the resolving set with A
		expect(() => getService(A, new Set([A]))).toThrow('Circular dependency detected: A');
	});

	it('supports resolve as an alias for getService', () => {
		@Service()
		class Logger {
		}

		expect(resolve(Logger)).toBe(getService(Logger));
	});

	it('supports @Component as an alias for @Service', () => {
		@Component()
		class Logger {
		}

		expect(getService(Logger)).toBeInstanceOf(Logger);
	});

	it('supports @Component with explicit dependencies', () => {
		@Service()
		class Repository {
		}

		@Component([Repository])
		class ComponentWithExplicitDependencies {
			constructor(public repository: Repository) {
			}
		}

		expect(getService(ComponentWithExplicitDependencies).repository).toBeInstanceOf(Repository);
	});

	it('injects enum values registered via @Bean(enumToken)', () => {
		enum LogLevel {
			DEBUG = 'debug',
			INFO = 'info',
			WARN = 'warn',
		}

		@Component([LogLevel])
		class Logger {
			constructor(public readonly logLevel: LogLevel = LogLevel.INFO) {}
		}

		class AppConfig {
			@Bean(LogLevel)
			static loggerLogLevel(): LogLevel {
				return LogLevel.WARN;
			}
		}

		const logger = resolve(Logger);
		expect(logger.logLevel).toBe(LogLevel.WARN);
	});

	it('falls back to default enum value when enum bean is not defined', () => {
		enum LogLevel {
			DEBUG = 'debug',
			INFO = 'info',
			WARN = 'warn',
		}

		@Component([LogLevel])
		class Logger {
			constructor(public readonly logLevel: LogLevel = LogLevel.INFO) {}
		}

		const logger = resolve(Logger);
		expect(logger.logLevel).toBe(LogLevel.INFO);
	});
});

describe('@Bean / @Instance', () => {
	it('registers the factory return value and resolves it', () => {
		class Logger {}

		class AppConfig {
			@Bean(Logger)
			static createLogger(): Logger {
				return new Logger();
			}
		}

		expect(resolve(Logger)).toBeInstanceOf(Logger);
	});

	it('returns the same singleton instance on repeated resolves', () => {
		class Logger {}

		class AppConfig {
			@Bean(Logger)
			static createLogger(): Logger {
				return new Logger();
			}
		}

		expect(resolve(Logger)).toBe(resolve(Logger));
	});

	it('infers registration key from instance.constructor when no arg is given', () => {
		class Logger {}

		class AppConfig {
			@Bean()
			static createLogger(): Logger {
				return new Logger();
			}
		}

		expect(resolve(Logger)).toBeInstanceOf(Logger);
	});

	it('@Instance() is an alias for @Bean()', () => {
		class Logger {}

		class AppConfig {
			@Instance(Logger)
			static createLogger(): Logger {
				return new Logger();
			}
		}

		expect(resolve(Logger)).toBeInstanceOf(Logger);
	});

	it('@Bean() instance is injected as a constructor dependency', () => {
		class Database {}

		class AppConfig {
			@Bean(Database)
			static createDatabase(): Database {
				return new Database();
			}
		}

		@Service([Database])
		class Repository {
			constructor(public db: Database) {}
		}

		expect(resolve(Repository).db).toBeInstanceOf(Database);
	});

	it('lazily instantiates so cross-bean dependencies resolve regardless of declaration order', () => {
		class DatabaseConnection {}

		class UserRepository {
			constructor(public db: DatabaseConnection) {}
		}

		// Repository bean is declared BEFORE the database bean it depends on
		class AppConfig {
			@Bean()
			static userRepository(): UserRepository {
				return new UserRepository(resolve(DatabaseConnection));
			}

			@Bean()
			static databaseConnection(): DatabaseConnection {
				return new DatabaseConnection();
			}
		}

		// Both are registered lazily — neither factory has run yet.
		// Resolving userRepository triggers databaseConnection first via resolve().
		const repo = resolve(UserRepository);
		expect(repo).toBeInstanceOf(UserRepository);
		expect(repo.db).toBeInstanceOf(DatabaseConnection);
	});

	it('@Bean() factory can call resolve() on a dependency whose @Bean is declared in a later-imported module', () => {
		class Config {}
		class Database {
			constructor(public config: Config) {}
		}

		// DatabaseConfig is "imported first" — its factory calls resolve(Config),
		// which hasn't been registered yet at decoration time.
		class DatabaseConfig {
			@Bean()
			static createDatabase(): Database {
				return new Database(resolve(Config));
			}
		}

		// Config @Bean is declared afterward (simulates a later-imported module)
		class AppConfig {
			@Bean()
			static createConfig(): Config {
				return new Config();
			}
		}

		const db = resolve(Database);
		expect(db).toBeInstanceOf(Database);
		expect(db.config).toBeInstanceOf(Config);
	});

		it('throws when applied to an instance method', () => {
		expect(() => {
			class AppConfig {
				@Bean()
				createLogger() {
					return {};
				}
			}
		}).toThrow('@Bean() is only supported on static methods');
	});
});
