import type { AttachmentRow } from './schema';

export interface NewAttachment {
	id: string;
	messageId: string;
	filename: string | null;
	mimeType: string | null;
	size: number;
	disposition: string | null;
	contentId: string | null;
	r2Key: string | null;
}

export function insertAttachmentStmt(db: D1Database, a: NewAttachment): D1PreparedStatement {
	return db
		.prepare('INSERT INTO attachments (id, message_id, filename, mime_type, size, disposition, content_id, r2_key) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
		.bind(a.id, a.messageId, a.filename, a.mimeType, a.size, a.disposition, a.contentId, a.r2Key);
}

export async function listAttachments(db: D1Database, messageId: string): Promise<AttachmentRow[]> {
	const { results } = await db.prepare('SELECT * FROM attachments WHERE message_id = ? ORDER BY rowid ASC').bind(messageId).all<AttachmentRow>();
	return results;
}

export async function listAttachmentsForMessages(db: D1Database, messageIds: string[]): Promise<Map<string, AttachmentRow[]>> {
	const map = new Map<string, AttachmentRow[]>();
	if (messageIds.length === 0) return map;
	// D1 caps bound parameters at 100; chunk to stay safe.
	for (let i = 0; i < messageIds.length; i += 90) {
		const chunk = messageIds.slice(i, i + 90);
		const { results } = await db
			.prepare(`SELECT * FROM attachments WHERE message_id IN (${chunk.map(() => '?').join(',')}) ORDER BY rowid ASC`)
			.bind(...chunk)
			.all<AttachmentRow>();
		for (const row of results) {
			const list = map.get(row.message_id) ?? [];
			list.push(row);
			map.set(row.message_id, list);
		}
	}
	return map;
}

export async function getAttachment(db: D1Database, messageId: string, attachmentId: string): Promise<AttachmentRow | null> {
	return db.prepare('SELECT * FROM attachments WHERE message_id = ? AND id = ?').bind(messageId, attachmentId).first<AttachmentRow>();
}

/** Best-effort R2 cleanup; never throws. */
export async function deleteR2Keys(bucket: R2Bucket, keys: string[]): Promise<void> {
	const unique = [...new Set(keys.filter(Boolean))];
	for (let i = 0; i < unique.length; i += 1000) {
		try {
			await bucket.delete(unique.slice(i, i + 1000));
		} catch (error) {
			console.log({ warn: 'r2 delete failed', error: String(error) });
		}
	}
}
