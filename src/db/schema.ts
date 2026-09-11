/** Row shapes as returned by D1. JSON columns are strings here; use the serializers in api/serialize.ts. */

export interface InboxRow {
	id: string;
	address: string;
	display_name: string | null;
	metadata: string;
	created_at: number;
	updated_at: number;
}

export interface ThreadRow {
	id: string;
	inbox_id: string;
	subject: string | null;
	participants: string;
	message_count: number;
	last_message_at: number;
	created_at: number;
	updated_at: number;
}

export type Direction = 'inbound' | 'outbound';

export interface MessageRow {
	id: string;
	inbox_id: string;
	thread_id: string;
	direction: Direction;
	message_id_header: string | null;
	in_reply_to: string | null;
	references_hdr: string | null;
	from_address: string | null;
	from_name: string | null;
	to_json: string;
	cc_json: string;
	bcc_json: string;
	reply_to: string | null;
	subject: string | null;
	text: string | null;
	html: string | null;
	snippet: string | null;
	received_at: number;
	expires_at: number | null;
	size_bytes: number;
	has_attachments: number;
	labels: string;
	read: number;
	raw_r2_key: string | null;
}

export interface AttachmentRow {
	id: string;
	message_id: string;
	filename: string | null;
	mime_type: string | null;
	size: number;
	disposition: string | null;
	content_id: string | null;
	r2_key: string | null;
}

export interface WebhookRow {
	id: string;
	inbox_id: string | null;
	url: string;
	secret: string;
	events: string;
	enabled: number;
	created_at: number;
	updated_at: number;
}

export interface WebhookDeliveryRow {
	id: string;
	webhook_id: string;
	event_type: string;
	message_id: string | null;
	status: 'delivered' | 'failed';
	http_status: number | null;
	attempts: number;
	last_error: string | null;
	created_at: number;
}

export interface Mailbox {
	address: string;
	name?: string;
}

export function parseJson<T>(value: string | null | undefined, fallback: T): T {
	if (!value) return fallback;
	try {
		return JSON.parse(value) as T;
	} catch {
		return fallback;
	}
}
