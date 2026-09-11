import { Hono } from 'hono';
import type { AppEnv } from './app';
import { parseBody } from './app';
import { ApiError } from './errors';
import { extractSchema, parseSince } from './schemas';
import { requireInbox } from './inboxes';
import { requireMessage } from './messages';
import { latestMessage } from '../db/messages';
import { extractFromMessage } from '../ai/extract';
import type { InboxRow, MessageRow } from '../db/schema';

/** Pick the message to extract from: explicit id, else newest (optionally after `since`). */
export async function pickMessage(db: D1Database, inbox: InboxRow, input: { message_id?: string; since?: string | number }): Promise<MessageRow> {
	if (input.message_id) return requireMessage(db, inbox, input.message_id);
	let since: number | undefined;
	try {
		since = parseSince(input.since);
	} catch (error) {
		throw ApiError.badRequest(error instanceof Error ? error.message : String(error));
	}
	const row = await latestMessage(db, inbox.id, { since });
	if (!row) throw ApiError.notFound(since !== undefined ? 'Message newer than `since`' : 'Message');
	return row;
}

export function extractRoutes() {
	const r = new Hono<AppEnv>();

	r.post('/inboxes/:inbox/extract', async (c) => {
		const inbox = await requireInbox(c.env.DB, c.req.param('inbox'));
		const body = await parseBody(c, extractSchema);
		const message = await pickMessage(c.env.DB, inbox, body);
		const out = await extractFromMessage(c.env, c.get('config'), message, { prompt: body.prompt, schema: body.schema });
		return c.json({ ...out, message_id: message.id, thread_id: message.thread_id });
	});

	r.post('/inboxes/:inbox/messages/:message/extract', async (c) => {
		const inbox = await requireInbox(c.env.DB, c.req.param('inbox'));
		const message = await requireMessage(c.env.DB, inbox, c.req.param('message'));
		const body = await parseBody(c, extractSchema.omit({ message_id: true, since: true }));
		const out = await extractFromMessage(c.env, c.get('config'), message, { prompt: body.prompt, schema: body.schema });
		return c.json({ ...out, message_id: message.id, thread_id: message.thread_id });
	});

	return r;
}
