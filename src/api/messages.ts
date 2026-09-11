import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from './app';
import { parseBody, parseQuery } from './app';
import { ApiError } from './errors';
import { composeSchema, forwardSchema, listMessagesQuery, parseSince, replySchema, updateMessageSchema } from './schemas';
import { requireInbox } from './inboxes';
import { deleteMessage, getMessage, latestMessage, listMessages, searchMessages, updateMessage, type MessageFilters } from '../db/messages';
import { deleteR2Keys, getAttachment, listAttachments, listAttachmentsForMessages } from '../db/attachments';
import { messageJson } from './serialize';
import { composeMessage, forwardMessage, replyToMessage } from '../email/send';
import { dispatchEvent } from '../webhooks/deliver';
import type { InboxRow, MessageRow } from '../db/schema';
import type { Config, WaitUntil } from '../env';

export async function requireMessage(db: D1Database, inbox: InboxRow, id: string): Promise<MessageRow> {
	const message = await getMessage(db, inbox.id, id);
	if (!message) throw ApiError.notFound('Message');
	return message;
}

export function filtersFromQuery(q: {
	since?: string;
	before?: string;
	unread?: boolean;
	has_attachment?: boolean;
	direction?: 'inbound' | 'outbound';
	thread_id?: string;
	from?: string;
	label?: string;
}): MessageFilters {
	try {
		return {
			since: parseSince(q.since),
			before: parseSince(q.before),
			unread: q.unread,
			hasAttachment: q.has_attachment,
			direction: q.direction,
			threadId: q.thread_id,
			from: q.from,
			label: q.label,
		};
	} catch (error) {
		throw ApiError.badRequest(error instanceof Error ? error.message : String(error));
	}
}

export async function fullMessageJson(db: D1Database, row: MessageRow) {
	return messageJson(row, await listAttachments(db, row.id), { includeBody: true });
}

/** Emit `message.sent` after an outbound message is persisted. */
export async function afterSend(env: Env, config: Config, inbox: InboxRow, ids: { messageId: string; threadId: string }, ctx: WaitUntil) {
	const row = await getMessage(env.DB, inbox.id, ids.messageId);
	if (!row) throw ApiError.upstream('Message was sent but could not be read back');
	const json = await fullMessageJson(env.DB, row);
	ctx.waitUntil(dispatchEvent(env, config, { type: 'message.sent', inbox_id: inbox.id, thread_id: row.thread_id, message: json }));
	return json;
}

/** Poll until a message newer than `since` shows up, or the deadline passes. */
export async function waitForMessage(db: D1Database, inboxId: string, filters: MessageFilters, timeoutMs: number, intervalMs = 1500): Promise<MessageRow | null> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const found = await latestMessage(db, inboxId, filters);
		if (found) return found;
		const remaining = deadline - Date.now();
		if (remaining <= 0) return null;
		await new Promise((r) => setTimeout(r, Math.min(intervalMs, remaining)));
	}
}

export function messageRoutes() {
	const r = new Hono<AppEnv>();

	r.get('/inboxes/:inbox/messages', async (c) => {
		const inbox = await requireInbox(c.env.DB, c.req.param('inbox'));
		const q = parseQuery(c, listMessagesQuery);
		const page = await listMessages(c.env.DB, inbox.id, filtersFromQuery(q), q);
		const attachments = await listAttachmentsForMessages(
			c.env.DB,
			page.items.map((m) => m.id),
		);
		return c.json({
			messages: page.items.map((m) => messageJson(m, attachments.get(m.id) ?? [], { includeBody: q.include_body === true })),
			next_cursor: page.next_cursor,
		});
	});

	// Static sub-paths must be registered before `/:message`.
	r.get('/inboxes/:inbox/messages/latest', async (c) => {
		const inbox = await requireInbox(c.env.DB, c.req.param('inbox'));
		const q = parseQuery(c, listMessagesQuery);
		const row = await latestMessage(c.env.DB, inbox.id, filtersFromQuery(q));
		if (!row) throw ApiError.notFound(q.since ? 'Message newer than `since`' : 'Message');
		return c.json(await fullMessageJson(c.env.DB, row));
	});

	r.get('/inboxes/:inbox/messages/wait', async (c) => {
		const inbox = await requireInbox(c.env.DB, c.req.param('inbox'));
		const q = parseQuery(c, listMessagesQuery.extend({ timeout: z.string().optional() }));
		const timeoutSec = Math.min(Math.max(Number(q.timeout ?? 25) || 25, 1), 25);
		const filters = filtersFromQuery(q);
		if (filters.since == null) filters.since = Date.now();
		const row = await waitForMessage(c.env.DB, inbox.id, filters, timeoutSec * 1000);
		if (!row) return c.json({ message: null, timed_out: true }, 200);
		return c.json({ message: await fullMessageJson(c.env.DB, row), timed_out: false });
	});

	r.get('/inboxes/:inbox/messages/search', async (c) => {
		const inbox = await requireInbox(c.env.DB, c.req.param('inbox'));
		const q = c.req.query('q')?.trim();
		if (!q) throw ApiError.badRequest('Query parameter `q` is required');
		const rows = await searchMessages(c.env.DB, inbox.id, q, { limit: c.req.query('limit') });
		const attachments = await listAttachmentsForMessages(
			c.env.DB,
			rows.map((m) => m.id),
		);
		return c.json({ messages: rows.map((m) => messageJson(m, attachments.get(m.id) ?? [], { includeBody: c.req.query('include_body') === 'true' })) });
	});

	r.post('/inboxes/:inbox/messages', async (c) => {
		const inbox = await requireInbox(c.env.DB, c.req.param('inbox'));
		const body = await parseBody(c, composeSchema);
		const ids = await composeMessage(c.env, c.get('config'), inbox, {
			to: body.to,
			cc: body.cc,
			bcc: body.bcc,
			subject: body.subject,
			text: body.text,
			html: body.html,
			fromName: body.from_name,
			replyTo: body.reply_to,
			headers: body.headers,
			attachments: body.attachments,
			labels: body.labels,
		});
		return c.json(await afterSend(c.env, c.get('config'), inbox, ids, c.executionCtx), 201);
	});

	r.get('/inboxes/:inbox/messages/:message', async (c) => {
		const inbox = await requireInbox(c.env.DB, c.req.param('inbox'));
		const row = await requireMessage(c.env.DB, inbox, c.req.param('message'));
		return c.json(await fullMessageJson(c.env.DB, row));
	});

	r.patch('/inboxes/:inbox/messages/:message', async (c) => {
		const inbox = await requireInbox(c.env.DB, c.req.param('inbox'));
		await requireMessage(c.env.DB, inbox, c.req.param('message'));
		const body = await parseBody(c, updateMessageSchema);
		const row = await updateMessage(c.env.DB, inbox.id, c.req.param('message'), body);
		if (!row) throw ApiError.notFound('Message');
		return c.json(await fullMessageJson(c.env.DB, row));
	});

	r.delete('/inboxes/:inbox/messages/:message', async (c) => {
		const inbox = await requireInbox(c.env.DB, c.req.param('inbox'));
		const result = await deleteMessage(c.env.DB, inbox.id, c.req.param('message'));
		if (!result) throw ApiError.notFound('Message');
		c.executionCtx.waitUntil(deleteR2Keys(c.env.ATTACHMENTS, result.r2Keys));
		return c.json({ deleted: true, id: result.row.id });
	});

	r.get('/inboxes/:inbox/messages/:message/raw', async (c) => {
		const inbox = await requireInbox(c.env.DB, c.req.param('inbox'));
		const row = await requireMessage(c.env.DB, inbox, c.req.param('message'));
		if (!row.raw_r2_key) throw ApiError.notFound('Raw MIME (enable STORE_RAW=true to keep raw messages)');
		const obj = await c.env.ATTACHMENTS.get(row.raw_r2_key);
		if (!obj) throw ApiError.notFound('Raw MIME object');
		return new Response(obj.body, { headers: { 'Content-Type': 'message/rfc822', 'Content-Length': String(obj.size) } });
	});

	r.get('/inboxes/:inbox/messages/:message/attachments/:attachment', async (c) => {
		const inbox = await requireInbox(c.env.DB, c.req.param('inbox'));
		const row = await requireMessage(c.env.DB, inbox, c.req.param('message'));
		const att = await getAttachment(c.env.DB, row.id, c.req.param('attachment'));
		if (!att) throw ApiError.notFound('Attachment');
		if (!att.r2_key) throw ApiError.notFound('Attachment content (exceeded MAX_ATTACHMENT_BYTES; only metadata was kept)');
		const obj = await c.env.ATTACHMENTS.get(att.r2_key);
		if (!obj) throw ApiError.notFound('Attachment object');
		const filename = (att.filename ?? 'attachment').replace(/["\r\n]/g, '');
		return new Response(obj.body, {
			headers: {
				'Content-Type': att.mime_type ?? 'application/octet-stream',
				'Content-Length': String(obj.size),
				'Content-Disposition': `${att.disposition === 'inline' ? 'inline' : 'attachment'}; filename="${filename}"`,
			},
		});
	});

	r.post('/inboxes/:inbox/messages/:message/reply', async (c) => {
		const inbox = await requireInbox(c.env.DB, c.req.param('inbox'));
		const original = await requireMessage(c.env.DB, inbox, c.req.param('message'));
		const body = await parseBody(c, replySchema);
		const ids = await replyToMessage(c.env, c.get('config'), inbox, original, toReplyInput(body), { replyAll: false });
		return c.json(await afterSend(c.env, c.get('config'), inbox, ids, c.executionCtx), 201);
	});

	r.post('/inboxes/:inbox/messages/:message/reply-all', async (c) => {
		const inbox = await requireInbox(c.env.DB, c.req.param('inbox'));
		const original = await requireMessage(c.env.DB, inbox, c.req.param('message'));
		const body = await parseBody(c, replySchema);
		const ids = await replyToMessage(c.env, c.get('config'), inbox, original, toReplyInput(body), { replyAll: true });
		return c.json(await afterSend(c.env, c.get('config'), inbox, ids, c.executionCtx), 201);
	});

	r.post('/inboxes/:inbox/messages/:message/forward', async (c) => {
		const inbox = await requireInbox(c.env.DB, c.req.param('inbox'));
		const original = await requireMessage(c.env.DB, inbox, c.req.param('message'));
		const body = await parseBody(c, forwardSchema);
		const ids = await forwardMessage(c.env, c.get('config'), inbox, original, {
			to: body.to,
			cc: body.cc,
			bcc: body.bcc,
			text: body.text,
			html: body.html,
			subject: body.subject,
			fromName: body.from_name,
			includeAttachments: body.include_attachments,
			labels: body.labels,
		});
		return c.json(await afterSend(c.env, c.get('config'), inbox, ids, c.executionCtx), 201);
	});

	return r;
}

function toReplyInput(body: z.infer<typeof replySchema>) {
	return {
		text: body.text,
		html: body.html,
		quoteOriginal: body.quote_original,
		subject: body.subject,
		fromName: body.from_name,
		cc: body.cc,
		bcc: body.bcc,
		attachments: body.attachments,
		labels: body.labels,
	};
}
