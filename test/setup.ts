import { applyD1Migrations, env, reset } from 'cloudflare:test';
import { beforeEach } from 'vitest';

// Fresh D1 + R2 for every test: wipe all binding storage, then re-apply migrations.
beforeEach(async () => {
	await reset();
	await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});
