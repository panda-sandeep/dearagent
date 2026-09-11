import type { AttachmentRow, InboxRow, MessageRow, ThreadRow, WebhookDeliveryRow, WebhookRow, Mailbox } from '../db/schema';
import { parseJson } from '../db/schema';

const iso = (ms: number | null | undefined) => (ms == null ? null : new Date(ms).toISOString());

export interface InboxJson {
	id: string;
	address: string;
	display_name: string | null;
	metadata: Record<string, unknown>;
	created_at: string;
	updated_at: string;
}

export function inboxJson(row: InboxRow): InboxJson {
	return {
		id: row.id,
		address: row.address,
		display_name: row.display_name,
		metadata: parseJson<Record<string, unknown>>(row.metadata, {}),
		created_at: iso(row.created_at)!,
		updated_at: iso(row.updated_at)!,
	};
}

export interface ThreadJson {
	id: string;
	inbox_id: string;
	subject: string | null;
	participants: string[];
	message_count: number;
	last_message_at: string;
	created_at: string;
	updated_at: string;
}

export function threadJson(row: ThreadRow): ThreadJson {
	return {
		id: row.id,
		inbox_id: row.inbox_id,
		subject: row.subject,
		participants: parseJson<string[]>(row.participants, []),
		message_count: row.message_count,
		last_message_at: iso(row.last_message_at)!,
		created_at: iso(row.created_at)!,
		updated_at: iso(row.updated_at)!,
	};
}

export interface AttachmentJson {
	id: string;
	filename: string | null;
	content_type: string | null;
	size: number;
	disposition: string | null;
	content_id: string | null;
	/** False when the blob exceeded MAX_ATTACHMENT_BYTES and only metadata was kept. */
	stored: boolean;
	url: string;
}

export function attachmentJson(row: AttachmentRow, inboxId: string): AttachmentJson {
	return {
		id: row.id,
		filename: row.filename,
		content_type: row.mime_type,
		size: row.size,
		disposition: row.disposition,
		content_id: row.content_id,
		stored: row.r2_key !== null,
		url: `/inboxes/${encodeURIComponent(inboxId)}/messages/${row.message_id}/attachments/${row.id}`,
	};
}

export interface MessageJson {
	id: string;
	inbox_id: string;
	thread_id: string;
	direction: 'inbound' | 'outbound';
	message_id: string | null;
	in_reply_to: string | null;
	references: string[];
	from: Mailbox | null;
	to: Mailbox[];
	cc: Mailbox[];
	bcc: Mailbox[];
	reply_to: string | null;
	subject: string | null;
	snippet: string | null;
	text?: string | null;
	html?: string | null;
	attachments: AttachmentJson[];
	has_attachments: boolean;
	labels: string[];
	read: boolean;
	size_bytes: number;
	received_at: string;
	/** Same instant as received_at, as epoch milliseconds, for cheap `since` comparisons. */
	received_at_ms: number;
	expires_at: string | null;
}

export function messageJson(row: MessageRow, attachments: AttachmentRow[], opts: { includeBody: boolean }): MessageJson {
	const out: MessageJson = {
		id: row.id,
		inbox_id: row.inbox_id,
		thread_id: row.thread_id,
		direction: row.direction,
		message_id: row.message_id_header,
		in_reply_to: row.in_reply_to,
		references: row.references_hdr ? row.references_hdr.split(/\s+/).filter(Boolean) : [],
		from: row.from_address ? { address: row.from_address, ...(row.from_name ? { name: row.from_name } : {}) } : null,
		to: parseJson<Mailbox[]>(row.to_json, []),
		cc: parseJson<Mailbox[]>(row.cc_json, []),
		bcc: parseJson<Mailbox[]>(row.bcc_json, []),
		reply_to: row.reply_to,
		subject: row.subject,
		snippet: row.snippet,
		attachments: attachments.map((a) => attachmentJson(a, row.inbox_id)),
		has_attachments: row.has_attachments === 1,
		labels: parseJson<string[]>(row.labels, []),
		read: row.read === 1,
		size_bytes: row.size_bytes,
		received_at: iso(row.received_at)!,
		received_at_ms: row.received_at,
		expires_at: iso(row.expires_at),
	};
	if (opts.includeBody) {
		out.text = row.text;
		out.html = row.html;
	}
	return out;
}

export interface WebhookJson {
	id: string;
	inbox_id: string | null;
	url: string;
	events: string[];
	enabled: boolean;
	secret?: string;
	created_at: string;
	updated_at: string;
}

export function webhookJson(row: WebhookRow, opts: { includeSecret: boolean }): WebhookJson {
	return {
		id: row.id,
		inbox_id: row.inbox_id,
		url: row.url,
		events: parseJson<string[]>(row.events, []),
		enabled: row.enabled === 1,
		...(opts.includeSecret ? { secret: row.secret } : {}),
		created_at: iso(row.created_at)!,
		updated_at: iso(row.updated_at)!,
	};
}

export function deliveryJson(row: WebhookDeliveryRow) {
	return {
		id: row.id,
		webhook_id: row.webhook_id,
		event_type: row.event_type,
		message_id: row.message_id,
		status: row.status,
		http_status: row.http_status,
		attempts: row.attempts,
		last_error: row.last_error,
		created_at: iso(row.created_at)!,
	};
}
