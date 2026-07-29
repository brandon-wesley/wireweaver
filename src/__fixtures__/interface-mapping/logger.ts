import { Service } from '../../container';
import type { ILogger } from './ilogger';

@Service()
export class ConsoleLogger implements ILogger {
	error(_message: string, _e?: Error): void {
		// fixture implementation for plugin discovery tests
	}
}


