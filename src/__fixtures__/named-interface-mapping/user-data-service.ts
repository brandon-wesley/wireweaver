import { Service } from '../../container';
import type { StorageService } from './storage-service';

@Service()
export class UserDataService {
	constructor(
		private localStorageService: StorageService,
		private cloudStorageService: StorageService,
	) {
		void this.localStorageService;
		void this.cloudStorageService;
	}
}

