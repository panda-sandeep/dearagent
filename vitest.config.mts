import path from 'node:path';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

export default defineConfig({
	plugins: [
		cloudflareTest(async () => {
			const migrations = await readD1Migrations(path.join(__dirname, 'migrations'));
			return {
				wrangler: { configPath: './wrangler.jsonc' },
				miniflare: {
					bindings: {
						TEST_MIGRATIONS: migrations,
						API_KEY: 'test-api-key',
						EMAIL_DOMAINS: 'mail.example.com,alt.example.com',
						RETENTION_DAYS: '30',
						STORE_RAW: 'true',
					},
					d1Databases: { DB: 'agentmail-test' },
					r2Buckets: ['ATTACHMENTS'],
				},
			};
		}),
	],
	test: {
		setupFiles: ['./test/setup.ts'],
	},
});
