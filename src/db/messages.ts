import type { MessageRow, Direction, Mailbox } from './schema';
import { clampLimit, decodeCursor, toPage, type Page } from './pagination';

export interface NewMessage {
	id: string;
	inboxId: string;
	threadId: string;
	direction: Direction;
	messageIdHeader: string | null;
	inReplyTo: string | null;
	references: string[];
	from: Mailbox | null;
	to: Mailbox[];
	cc: Mailbox[];
	bcc: Mailbox[];
	replyTo: string | null;
	subject: string | null;
	text: string | null;
	html: string | null;
	receivedAt: number;
	expiresAt: number | null;
	sizeBytes: number;
	hasAttachments: boolean;
	labels?: string[];
	read?: boolean;
	rawR2Key: string | null;
}

const SNIPPET_LEN = 200;

export function makeSnippet(text: string | null, html: string | null): string | null {
	let source = text;
	if (!source && html) {
		source = html
			.replace(/<style[\s\S]*?<\/style>/gi, ' ')
			.replace(/<script[\s\S]*?<\/script>/gi, ' ')
			.replace(/<[^>]+>/g, ' ')
			.replace(/&nbsp;/g, ' ')
			.replace(/&amp;/g, '&')
			.replace(/&lt;/g, '<')
			.replace(/&gt;/g, '>');
	}
	if (!source) return null;
	const collapsed = source.replace(/\s+/g, ' ').trim();
	return collapsed.length > SNIPPET_LEN ? `${collapsed.slice(0, SNIPPET_LEN)}…` : collapsed;
}

export function insertMessageStmts(db: D1Database, m: NewMessage): D1PreparedStatement[] {
	const snippet = makeSnippet(m.text, m.html);
	const insert = db
		.prepare(
			`INSERT INTO messages (
				id, inbox_id, thread_id, direction, message_id_header, in_reply_to, references_hdr,
				from_address, from_name, to_json, cc_json, bcc_json, reply_to, subject, text, html, snippet,
				received_at, expires_at, size_bytes, has_attachments, labels, read, raw_r2_key
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		)
		.bind(
			m.id,
			m.inboxId,
			m.threadId,
			m.direction,
			m.messageIdHeader,
			m.inReplyTo,
			m.references.length ? m.references.join(' ') : null,
			m.from?.address ?? null,
			m.from?.name ?? null,
			JSON.stringify(m.to),
			JSON.stringify(m.cc),
			JSON.stringify(m.bcc),
			m.replyTo,
			m.subject,
			m.text,
			m.html,
			snippet,
			m.receivedAt,
			m.expiresAt,
			m.sizeBytes,
			m.hasAttachments ? 1 : 0,
			JSON.stringify(m.labels ?? []),
			m.read ? 1 : 0,
			m.rawR2Key,
		);
	// FTS body: prefer text, fall back to a stripped HTML snippet source (bounded to keep the index small).
	const body = (m.text ?? makeSnippet(null, m.html) ?? '').slice(0, 64 * 1024);
	const fts = db
		.prepare('INSERT INTO messages_fts (message_id, inbox_id, subject, body, from_address) VALUES (?, ?, ?, ?, ?)')
		.bind(m.id, m.inboxId, m.subject ?? '', body, m.from?.address ?? '');
	return [insert, fts];
}

export async function getMessage(db: D1Database, inboxId: string, messageId: string): Promise<MessageRow | null> {
	return db.prepare('SELECT * FROM messages WHERE inbox_id = ? AND id = ?').bind(inboxId, messageId).first<MessageRow>();
}

export async function findByMessageIdHeader(db: D1Database, inboxId: string, header: string): Promise<MessageRow | null> {
	return db.prepare('SELECT * FROM messages WHERE inbox_id = ? AND message_id_header = ?').bind(inboxId, header).first<MessageRow>();
}

/** Resolve a thread id from any known Message-ID among the candidates (In-Reply-To + References). */
export async function findThreadByMessageIds(db: D1Database, inboxId: string, candidates: string[]): Promise<string | null> {
	const ids = [...new Set(candidates.filter(Boolean))].slice(0, 50);
	if (ids.length === 0) return null;
	const placeholders = ids.map(() => '?').join(',');
	const row = await db
		.prepare(`SELECT thread_id FROM messages WHERE inbox_id = ? AND message_id_header IN (${placeholders}) ORDER BY received_at DESC LIMIT 1`)
		.bind(inboxId, ...ids)
		.first<{ thread_id: string }>();
	return row?.thread_id ?? null;
}

export interface MessageFilters {
	since?: number | null; // exclusive lower bound on received_at
	before?: number | null; // exclusive upper bound
	unread?: boolean | null;
	hasAttachment?: boolean | null;
	direction?: Direction | null;
	threadId?: string | null;
	from?: string | null; // exact address match (lowercased)
	label?: string | null;
}

function buildWhere(inboxId: string, f: MessageFilters): { sql: string; params: unknown[] } {
	const clauses = ['inbox_id = ?'];
	const params: unknown[] = [inboxId];
	if (f.since != null) {
		clauses.push('received_at > ?');
		params.push(f.since);
	}
	if (f.before != null) {
		clauses.push('received_at < ?');
		params.push(f.before);
	}
	if (f.unread === true) clauses.push('read = 0');
	if (f.unread === false) clauses.push('read = 1');
	if (f.hasAttachment === true) clauses.push('has_attachments = 1');
	if (f.hasAttachment === false) clauses.push('has_attachments = 0');
	if (f.direction) {
		clauses.push('direction = ?');
		params.push(f.direction);
	}
	if (f.threadId) {
		clauses.push('thread_id = ?');
		params.push(f.threadId);
	}
	if (f.from) {
		clauses.push('from_address = ?');
		params.push(f.from.toLowerCase());
	}
	if (f.label) {
		clauses.push('EXISTS (SELECT 1 FROM json_each(messages.labels) WHERE json_each.value = ?)');
		params.push(f.label);
	}
	return { sql: clauses.join(' AND '), params };
}

export async function listMessages(
	db: D1Database,
	inboxId: string,
	filters: MessageFilters,
	opts: { limit?: string | number; cursor?: string | null },
): Promise<Page<MessageRow>> {
	const limit = clampLimit(opts.limit);
	const cursor = decodeCursor(opts.cursor);
	const { sql, params } = buildWhere(inboxId, filters);
	let where = sql;
	if (cursor) {
		where += ' AND ((received_at < ?) OR (received_at = ? AND id < ?))';
		params.push(cursor.t, cursor.t, cursor.id);
	}
	const { results } = await db
		.prepare(`SELECT * FROM messages WHERE ${where} ORDER BY received_at DESC, id DESC LIMIT ?`)
		.bind(...params, limit + 1)
		.all<MessageRow>();
	return toPage(results, limit, (r) => ({ t: r.received_at, id: r.id }));
}

/** Newest message matching the filters, or null. Mirrors the "latest email after <since>" polling pattern. */
export async function latestMessage(db: D1Database, inboxId: string, filters: MessageFilters): Promise<MessageRow | null> {
	const { sql, params } = buildWhere(inboxId, filters);
	return db
		.prepare(`SELECT * FROM messages WHERE ${sql} ORDER BY received_at DESC, id DESC LIMIT 1`)
		.bind(...params)
		.first<MessageRow>();
}

export async function listThreadMessages(db: D1Database, threadId: string): Promise<MessageRow[]> {
	const { results } = await db.prepare('SELECT * FROM messages WHERE thread_id = ? ORDER BY received_at ASC, id ASC').bind(threadId).all<MessageRow>();
	return results;
}

/** Escape user input into an FTS5 query: every whitespace-separated token becomes a quoted phrase (implicit AND). */
export function toFtsQuery(q: string): string {
	return q
		.split(/\s+/)
		.map((t) => t.replace(/"/g, '').trim())
		.filter(Boolean)
		.map((t) => `"${t}"`)
		.join(' ');
}

export async function searchMessages(
	db: D1Database,
	inboxId: string,
	q: string,
	opts: { limit?: string | number },
): Promise<MessageRow[]> {
	const limit = clampLimit(opts.limit);
	const fts = toFtsQuery(q);
	if (!fts) return [];
	const { results } = await db
		.prepare(
			`SELECT m.* FROM messages_fts f JOIN messages m ON m.id = f.message_id
			 WHERE f.inbox_id = ? AND messages_fts MATCH ?
			 ORDER BY bm25(messages_fts), m.received_at DESC LIMIT ?`,
		)
		.bind(inboxId, fts, limit)
		.all<MessageRow>();
	return results;
}

export async function updateMessage(
	db: D1Database,
	inboxId: string,
	messageId: string,
	patch: { read?: boolean; labels?: string[] },
): Promise<MessageRow | null> {
	const current = await getMessage(db, inboxId, messageId);
	if (!current) return null;
	const read = patch.read === undefined ? current.read : patch.read ? 1 : 0;
	const labels = patch.labels === undefined ? current.labels : JSON.stringify(patch.labels);
	await db.prepare('UPDATE messages SET read = ?, labels = ? WHERE id = ?').bind(read, labels, current.id).run();
	return getMessage(db, inboxId, messageId);
}

export function markReadStmt(db: D1Database, messageId: string): D1PreparedStatement {
	return db.prepare('UPDATE messages SET read = 1 WHERE id = ?').bind(messageId);
}

export async function deleteMessage(db: D1Database, inboxId: string, messageId: string): Promise<{ row: MessageRow; r2Keys: string[] } | null> {
	const row = await getMessage(db, inboxId, messageId);
	if (!row) return null;
	const { results } = await db.prepare('SELECT r2_key FROM attachments WHERE message_id = ? AND r2_key IS NOT NULL').bind(row.id).all<{ r2_key: string }>();
	const r2Keys = results.map((r) => r.r2_key);
	if (row.raw_r2_key) r2Keys.push(row.raw_r2_key);
	await db.batch([
		db.prepare('DELETE FROM messages_fts WHERE message_id = ?').bind(row.id),
		db.prepare('DELETE FROM messages WHERE id = ?').bind(row.id),
		db.prepare('UPDATE threads SET message_count = MAX(message_count - 1, 0), updated_at = ? WHERE id = ?').bind(Date.now(), row.thread_id),
		db.prepare('DELETE FROM threads WHERE id = ? AND (SELECT COUNT(*) FROM messages WHERE thread_id = ?) = 0').bind(row.thread_id, row.thread_id),
	]);
	return { row, r2Keys };
}
