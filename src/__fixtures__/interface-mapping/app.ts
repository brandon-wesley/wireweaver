import { Service } from '../../container';
import type { ILogger } from './ilogger';

@Service()
export class AppService {
	constructor(private logger: ILogger) {
		void this.logger;
	}
}

