import { now } from '../env';
import type { InboxRow } from './schema';
import { clampLimit, decodeCursor, toPage, type Page } from './pagination';

export function inboxIdFor(address: string): string {
	return address.trim().toLowerCase();
}

export async function getInbox(db: D1Database, idOrAddress: string): Promise<InboxRow | null> {
	const id = inboxIdFor(idOrAddress);
	return db.prepare('SELECT * FROM inboxes WHERE id = ?').bind(id).first<InboxRow>();
}

export interface CreateInboxInput {
	address: string;
	displayName?: string | null;
	metadata?: Record<string, unknown>;
}

/** Insert if missing; returns the (possibly pre-existing) row and whether it was created. */
export async function upsertInbox(db: D1Database, input: CreateInboxInput): Promise<{ inbox: InboxRow; created: boolean }> {
	const id = inboxIdFor(input.address);
	const existing = await getInbox(db, id);
	if (existing) return { inbox: existing, created: false };
	const ts = now();
	const row: InboxRow = {
		id,
		address: id,
		display_name: input.displayName ?? null,
		metadata: JSON.stringify(input.metadata ?? {}),
		created_at: ts,
		updated_at: ts,
	};
	await db
		.prepare('INSERT OR IGNORE INTO inboxes (id, address, display_name, metadata, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
		.bind(row.id, row.address, row.display_name, row.metadata, row.created_at, row.updated_at)
		.run();
	// Re-read in case of a concurrent insert winning the race.
	const inbox = (await getInbox(db, id)) ?? row;
	return { inbox, created: inbox.created_at === ts };
}

export async function updateInbox(
	db: D1Database,
	id: string,
	patch: { displayName?: string | null; metadata?: Record<string, unknown> },
): Promise<InboxRow | null> {
	const current = await getInbox(db, id);
	if (!current) return null;
	const displayName = patch.displayName === undefined ? current.display_name : patch.displayName;
	const metadata = patch.metadata === undefined ? current.metadata : JSON.stringify(patch.metadata);
	await db
		.prepare('UPDATE inboxes SET display_name = ?, metadata = ?, updated_at = ? WHERE id = ?')
		.bind(displayName, metadata, now(), current.id)
		.run();
	return getInbox(db, current.id);
}

export async function listInboxes(db: D1Database, opts: { limit?: string | number; cursor?: string | null }): Promise<Page<InboxRow>> {
	const limit = clampLimit(opts.limit);
	const cursor = decodeCursor(opts.cursor);
	const stmt = cursor
		? db
				.prepare('SELECT * FROM inboxes WHERE (created_at < ?) OR (created_at = ? AND id < ?) ORDER BY created_at DESC, id DESC LIMIT ?')
				.bind(cursor.t, cursor.t, cursor.id, limit + 1)
		: db.prepare('SELECT * FROM inboxes ORDER BY created_at DESC, id DESC LIMIT ?').bind(limit + 1);
	const { results } = await stmt.all<InboxRow>();
	return toPage(results, limit, (r) => ({ t: r.created_at, id: r.id }));
}

/** Collect every R2 key owned by an inbox so the caller can delete blobs before the rows cascade. */
export async function collectInboxR2Keys(db: D1Database, inboxId: string): Promise<string[]> {
	const [att, raw] = await db.batch<{ k: string }>([
		db
			.prepare('SELECT a.r2_key AS k FROM attachments a JOIN messages m ON m.id = a.message_id WHERE m.inbox_id = ? AND a.r2_key IS NOT NULL')
			.bind(inboxId),
		db.prepare('SELECT raw_r2_key AS k FROM messages WHERE inbox_id = ? AND raw_r2_key IS NOT NULL').bind(inboxId),
	]);
	return [...att.results, ...raw.results].map((r) => r.k);
}

export async function deleteInbox(db: D1Database, inboxId: string): Promise<boolean> {
	// FTS rows are not covered by FK cascade.
	const results = await db.batch([
		db.prepare('DELETE FROM messages_fts WHERE inbox_id = ?').bind(inboxId),
		db.prepare('DELETE FROM inboxes WHERE id = ?').bind(inboxId),
	]);
	return (results[1]?.meta.changes ?? 0) > 0;
}
