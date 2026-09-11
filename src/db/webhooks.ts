import { newId, now } from '../env';
import type { WebhookDeliveryRow, WebhookRow } from './schema';
import { parseJson } from './schema';

export const WEBHOOK_EVENTS = ['message.received', 'message.sent'] as const;
export type WebhookEventType = (typeof WEBHOOK_EVENTS)[number];

function randomSecret(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(32));
	return `whsec_${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
}

export interface CreateWebhookInput {
	inboxId: string | null;
	url: string;
	events?: WebhookEventType[];
	secret?: string;
	enabled?: boolean;
}

export async function createWebhook(db: D1Database, input: CreateWebhookInput): Promise<WebhookRow> {
	const ts = now();
	const row: WebhookRow = {
		id: newId('wh'),
		inbox_id: input.inboxId,
		url: input.url,
		secret: input.secret ?? randomSecret(),
		events: JSON.stringify(input.events?.length ? input.events : ['message.received']),
		enabled: input.enabled === false ? 0 : 1,
		created_at: ts,
		updated_at: ts,
	};
	await db
		.prepare('INSERT INTO webhooks (id, inbox_id, url, secret, events, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
		.bind(row.id, row.inbox_id, row.url, row.secret, row.events, row.enabled, row.created_at, row.updated_at)
		.run();
	return row;
}

export async function getWebhook(db: D1Database, id: string): Promise<WebhookRow | null> {
	return db.prepare('SELECT * FROM webhooks WHERE id = ?').bind(id).first<WebhookRow>();
}

export async function listWebhooks(db: D1Database, inboxId?: string | null): Promise<WebhookRow[]> {
	const stmt =
		inboxId === undefined
			? db.prepare('SELECT * FROM webhooks ORDER BY created_at DESC')
			: inboxId === null
				? db.prepare('SELECT * FROM webhooks WHERE inbox_id IS NULL ORDER BY created_at DESC')
				: db.prepare('SELECT * FROM webhooks WHERE inbox_id = ? ORDER BY created_at DESC').bind(inboxId);
	const { results } = await stmt.all<WebhookRow>();
	return results;
}

/** Enabled webhooks that should fire for an event on a given inbox (inbox-scoped + global). */
export async function webhooksForEvent(db: D1Database, inboxId: string, event: WebhookEventType): Promise<WebhookRow[]> {
	const { results } = await db
		.prepare('SELECT * FROM webhooks WHERE enabled = 1 AND (inbox_id IS NULL OR inbox_id = ?)')
		.bind(inboxId)
		.all<WebhookRow>();
	return results.filter((w) => parseJson<string[]>(w.events, []).includes(event));
}

export async function updateWebhook(
	db: D1Database,
	id: string,
	patch: { url?: string; events?: WebhookEventType[]; enabled?: boolean; secret?: string },
): Promise<WebhookRow | null> {
	const current = await getWebhook(db, id);
	if (!current) return null;
	const url = patch.url ?? current.url;
	const events = patch.events === undefined ? current.events : JSON.stringify(patch.events);
	const enabled = patch.enabled === undefined ? current.enabled : patch.enabled ? 1 : 0;
	const secret = patch.secret ?? current.secret;
	await db.prepare('UPDATE webhooks SET url = ?, events = ?, enabled = ?, secret = ?, updated_at = ? WHERE id = ?').bind(url, events, enabled, secret, now(), id).run();
	return getWebhook(db, id);
}

export async function deleteWebhook(db: D1Database, id: string): Promise<boolean> {
	const res = await db.prepare('DELETE FROM webhooks WHERE id = ?').bind(id).run();
	return (res.meta.changes ?? 0) > 0;
}

export async function recordDelivery(db: D1Database, d: Omit<WebhookDeliveryRow, 'id' | 'created_at'>): Promise<void> {
	await db
		.prepare(
			'INSERT INTO webhook_deliveries (id, webhook_id, event_type, message_id, status, http_status, attempts, last_error, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
		)
		.bind(newId('whd'), d.webhook_id, d.event_type, d.message_id, d.status, d.http_status, d.attempts, d.last_error, now())
		.run();
}

export async function listDeliveries(db: D1Database, webhookId: string, limit = 50): Promise<WebhookDeliveryRow[]> {
	const { results } = await db
		.prepare('SELECT * FROM webhook_deliveries WHERE webhook_id = ? ORDER BY created_at DESC LIMIT ?')
		.bind(webhookId, Math.min(Math.max(limit, 1), 200))
		.all<WebhookDeliveryRow>();
	return results;
}
