import { Service } from '../../container';
import type { StorageService } from './storage-service';

@Service()
export class CloudStorageService implements StorageService {
	save(_key: string, _value: unknown): void {
		// fixture implementation for named interface mapping tests
	}
}

