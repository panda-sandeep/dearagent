import { Hono } from 'hono';
import type { AppEnv } from './app';
import { parseBody } from './app';
import { ApiError } from './errors';
import { createWebhookSchema, updateWebhookSchema } from './schemas';
import { requireInbox } from './inboxes';
import { createWebhook, deleteWebhook, getWebhook, listDeliveries, listWebhooks, updateWebhook } from '../db/webhooks';
import { deliveryJson, webhookJson } from './serialize';

export function webhookRoutes() {
	const r = new Hono<AppEnv>();

	// Global (all inboxes) ---------------------------------------------------
	r.get('/webhooks', async (c) => {
		const scope = c.req.query('scope'); // "global" | undefined (all)
		const rows = await listWebhooks(c.env.DB, scope === 'global' ? null : undefined);
		return c.json({ webhooks: rows.map((w) => webhookJson(w, { includeSecret: false })) });
	});

	r.post('/webhooks', async (c) => {
		const body = await parseBody(c, createWebhookSchema);
		let inboxId: string | null = null;
		if (body.inbox_id) inboxId = (await requireInbox(c.env.DB, body.inbox_id)).id;
		const row = await createWebhook(c.env.DB, { inboxId, url: body.url, events: body.events, secret: body.secret, enabled: body.enabled });
		return c.json(webhookJson(row, { includeSecret: true }), 201);
	});

	r.get('/webhooks/:webhook', async (c) => {
		const row = await getWebhook(c.env.DB, c.req.param('webhook'));
		if (!row) throw ApiError.notFound('Webhook');
		return c.json(webhookJson(row, { includeSecret: c.req.query('include_secret') === 'true' }));
	});

	r.patch('/webhooks/:webhook', async (c) => {
		const body = await parseBody(c, updateWebhookSchema);
		const row = await updateWebhook(c.env.DB, c.req.param('webhook'), body);
		if (!row) throw ApiError.notFound('Webhook');
		return c.json(webhookJson(row, { includeSecret: body.secret !== undefined }));
	});

	r.delete('/webhooks/:webhook', async (c) => {
		const ok = await deleteWebhook(c.env.DB, c.req.param('webhook'));
		if (!ok) throw ApiError.notFound('Webhook');
		return c.json({ deleted: true, id: c.req.param('webhook') });
	});

	r.get('/webhooks/:webhook/deliveries', async (c) => {
		const row = await getWebhook(c.env.DB, c.req.param('webhook'));
		if (!row) throw ApiError.notFound('Webhook');
		const rows = await listDeliveries(c.env.DB, row.id, Number(c.req.query('limit') ?? 50));
		return c.json({ deliveries: rows.map(deliveryJson) });
	});

	// Inbox-scoped -----------------------------------------------------------
	r.get('/inboxes/:inbox/webhooks', async (c) => {
		const inbox = await requireInbox(c.env.DB, c.req.param('inbox'));
		const rows = await listWebhooks(c.env.DB, inbox.id);
		return c.json({ webhooks: rows.map((w) => webhookJson(w, { includeSecret: false })) });
	});

	r.post('/inboxes/:inbox/webhooks', async (c) => {
		const inbox = await requireInbox(c.env.DB, c.req.param('inbox'));
		const body = await parseBody(c, createWebhookSchema);
		const row = await createWebhook(c.env.DB, { inboxId: inbox.id, url: body.url, events: body.events, secret: body.secret, enabled: body.enabled });
		return c.json(webhookJson(row, { includeSecret: true }), 201);
	});

	return r;
}
