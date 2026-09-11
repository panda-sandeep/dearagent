import { getConfig } from './env';
import { deleteR2Keys } from './db/attachments';

const BATCH = 200;

/** Purge expired messages (per-address TTL) and messages older than RETENTION_DAYS. */
export async function runRetention(env: Env): Promise<{ deleted: number }> {
	const config = getConfig(env);
	const now = Date.now();
	const retentionCutoff = config.retentionDays > 0 ? now - config.retentionDays * 86_400_000 : null;
	let deleted = 0;

	for (let round = 0; round < 50; round++) {
		const where = retentionCutoff === null ? '(expires_at IS NOT NULL AND expires_at < ?)' : '(expires_at IS NOT NULL AND expires_at < ?) OR received_at < ?';
		const params = retentionCutoff === null ? [now] : [now, retentionCutoff];
		const { results } = await env.DB.prepare(`SELECT id, thread_id, raw_r2_key FROM messages WHERE ${where} LIMIT ?`)
			.bind(...params, BATCH)
			.all<{ id: string; thread_id: string; raw_r2_key: string | null }>();
		if (results.length === 0) break;

		const ids = results.map((r) => r.id);
		const placeholders = ids.map(() => '?').join(',');
		const { results: atts } = await env.DB.prepare(`SELECT r2_key FROM attachments WHERE message_id IN (${placeholders}) AND r2_key IS NOT NULL`)
			.bind(...ids)
			.all<{ r2_key: string }>();
		const keys = [...atts.map((a) => a.r2_key), ...results.map((r) => r.raw_r2_key).filter((k): k is string => Boolean(k))];
		await deleteR2Keys(env.ATTACHMENTS, keys);

		const threadIds = [...new Set(results.map((r) => r.thread_id))];
		await env.DB.batch([
			env.DB.prepare(`DELETE FROM messages_fts WHERE message_id IN (${placeholders})`).bind(...ids),
			env.DB.prepare(`DELETE FROM messages WHERE id IN (${placeholders})`).bind(...ids),
			...threadIds.map((t) =>
				env.DB.prepare('UPDATE threads SET message_count = (SELECT COUNT(*) FROM messages WHERE thread_id = ?), updated_at = ? WHERE id = ?').bind(t, now, t),
			),
			env.DB.prepare('DELETE FROM threads WHERE message_count = 0'),
		]);
		deleted += ids.length;
		if (results.length < BATCH) break;
	}

	// Keep the delivery log bounded (30 days).
	await env.DB.prepare('DELETE FROM webhook_deliveries WHERE created_at < ?').bind(now - 30 * 86_400_000).run();

	console.log({ event: 'retention.run', deleted, retentionDays: config.retentionDays });
	return { deleted };
}
