import { newId, now } from '../env';
import type { ThreadRow } from './schema';
import { parseJson } from './schema';
import { clampLimit, decodeCursor, toPage, type Page } from './pagination';

export async function getThread(db: D1Database, inboxId: string, threadId: string): Promise<ThreadRow | null> {
	return db.prepare('SELECT * FROM threads WHERE inbox_id = ? AND id = ?').bind(inboxId, threadId).first<ThreadRow>();
}

export async function listThreads(
	db: D1Database,
	inboxId: string,
	opts: { limit?: string | number; cursor?: string | null },
): Promise<Page<ThreadRow>> {
	const limit = clampLimit(opts.limit);
	const cursor = decodeCursor(opts.cursor);
	const stmt = cursor
		? db
				.prepare(
					'SELECT * FROM threads WHERE inbox_id = ? AND ((last_message_at < ?) OR (last_message_at = ? AND id < ?)) ORDER BY last_message_at DESC, id DESC LIMIT ?',
				)
				.bind(inboxId, cursor.t, cursor.t, cursor.id, limit + 1)
		: db.prepare('SELECT * FROM threads WHERE inbox_id = ? ORDER BY last_message_at DESC, id DESC LIMIT ?').bind(inboxId, limit + 1);
	const { results } = await stmt.all<ThreadRow>();
	return toPage(results, limit, (r) => ({ t: r.last_message_at, id: r.id }));
}

/** Statement that creates a thread row. Returned unbound-executed so callers can batch it with the message insert. */
export function insertThreadStmt(
	db: D1Database,
	thread: { id: string; inboxId: string; subject: string | null; participants: string[]; at: number },
): D1PreparedStatement {
	return db
		.prepare(
			'INSERT INTO threads (id, inbox_id, subject, participants, message_count, last_message_at, created_at, updated_at) VALUES (?, ?, ?, ?, 0, ?, ?, ?)',
		)
		.bind(thread.id, thread.inboxId, thread.subject, JSON.stringify(thread.participants), thread.at, thread.at, thread.at);
}

/** Bump counters after a message is added to an existing thread. */
export function touchThreadStmt(
	db: D1Database,
	threadId: string,
	at: number,
	participants: string[],
	existing: ThreadRow | null,
): D1PreparedStatement {
	const merged = new Set<string>(existing ? parseJson<string[]>(existing.participants, []) : []);
	for (const p of participants) merged.add(p);
	return db
		.prepare(
			'UPDATE threads SET message_count = message_count + 1, last_message_at = MAX(last_message_at, ?), participants = ?, updated_at = ? WHERE id = ?',
		)
		.bind(at, JSON.stringify([...merged]), now(), threadId);
}

export function newThreadId(): string {
	return newId('thr');
}

/** Remove a thread if it has no messages left. */
export async function pruneEmptyThread(db: D1Database, threadId: string): Promise<void> {
	await db.prepare('DELETE FROM threads WHERE id = ? AND (SELECT COUNT(*) FROM messages WHERE thread_id = ?) = 0').bind(threadId, threadId).run();
}

export async function deleteThread(db: D1Database, inboxId: string, threadId: string): Promise<{ deleted: boolean; r2Keys: string[] }> {
	const keys = await db.batch<{ k: string }>([
		db
			.prepare('SELECT a.r2_key AS k FROM attachments a JOIN messages m ON m.id = a.message_id WHERE m.thread_id = ? AND a.r2_key IS NOT NULL')
			.bind(threadId),
		db.prepare('SELECT raw_r2_key AS k FROM messages WHERE thread_id = ? AND raw_r2_key IS NOT NULL').bind(threadId),
	]);
	const r2Keys = [...keys[0].results, ...keys[1].results].map((r) => r.k);
	const results = await db.batch([
		db.prepare('DELETE FROM messages_fts WHERE message_id IN (SELECT id FROM messages WHERE thread_id = ?)').bind(threadId),
		db.prepare('DELETE FROM threads WHERE inbox_id = ? AND id = ?').bind(inboxId, threadId),
	]);
	return { deleted: (results[1]?.meta.changes ?? 0) > 0, r2Keys };
}
