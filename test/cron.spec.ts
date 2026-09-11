import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { buildEml, ingest, DOMAIN } from './helpers';
import { runRetention } from '../src/cron';

describe('retention', () => {
	it('purges expired and old messages, their blobs, and empty threads', async () => {
		const fresh = await ingest(buildEml({ subject: 'fresh' }));
		const expired = await ingest(buildEml({ to: `x.ttl.1@${DOMAIN}`, attachments: [{ filename: 'a.txt', contentType: 'text/plain', content: 'a' }] }), `x.ttl.1@${DOMAIN}`);
		const old = await ingest(buildEml({ subject: 'old' }));
		// Backdate beyond RETENTION_DAYS (30) and push the ttl one into the past.
		await env.DB.prepare('UPDATE messages SET received_at = ? WHERE id = ?').bind(Date.now() - 40 * 86_400_000, old.messageId).run();
		await env.DB.prepare('UPDATE messages SET expires_at = ? WHERE id = ?').bind(Date.now() - 1000, expired.messageId).run();
		const attKey = (await env.DB.prepare('SELECT r2_key FROM attachments WHERE message_id = ?').bind(expired.messageId).first<{ r2_key: string }>())!.r2_key;

		const { deleted } = await runRetention(env);
		expect(deleted).toBe(2);

		const remaining = await env.DB.prepare('SELECT id FROM messages').all<{ id: string }>();
		expect(remaining.results.map((r) => r.id)).toEqual([fresh.messageId]);
		expect(await env.ATTACHMENTS.head(attKey)).toBeNull();
		const threads = await env.DB.prepare('SELECT id FROM threads').all<{ id: string }>();
		expect(threads.results.map((t) => t.id)).toEqual([fresh.threadId]);
		const fts = await env.DB.prepare('SELECT COUNT(*) AS n FROM messages_fts').first<{ n: number }>();
		expect(fts?.n).toBe(1);
	});

	it('keeps everything when RETENTION_DAYS=0 except explicit ttl expiries', async () => {
		const prev = (env as any).RETENTION_DAYS;
		(env as any).RETENTION_DAYS = '0';
		try {
			const old = await ingest(buildEml());
			await env.DB.prepare('UPDATE messages SET received_at = ? WHERE id = ?').bind(Date.now() - 400 * 86_400_000, old.messageId).run();
			const { deleted } = await runRetention(env);
			expect(deleted).toBe(0);
		} finally {
			(env as any).RETENTION_DAYS = prev;
		}
	});
});
