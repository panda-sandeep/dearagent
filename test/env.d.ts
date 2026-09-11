import type { D1Migration } from '@cloudflare/vitest-pool-workers';

declare module 'cloudflare:test' {
	interface ProvidedEnv extends Env {
		TEST_MIGRATIONS: D1Migration[];
		API_KEY: string;
	}
}
