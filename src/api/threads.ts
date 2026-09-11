import { Hono } from 'hono';
import type { AppEnv } from './app';
import { parseQuery } from './app';
import { ApiError } from './errors';
import { pageQuery } from './schemas';
import { requireInbox } from './inboxes';
import { deleteThread, getThread, listThreads } from '../db/threads';
import { listThreadMessages } from '../db/messages';
import { listAttachmentsForMessages, deleteR2Keys } from '../db/attachments';
import { messageJson, threadJson } from './serialize';

export function threadRoutes() {
	const r = new Hono<AppEnv>();

	r.get('/inboxes/:inbox/threads', async (c) => {
		const inbox = await requireInbox(c.env.DB, c.req.param('inbox'));
		const q = parseQuery(c, pageQuery);
		const page = await listThreads(c.env.DB, inbox.id, q);
		return c.json({ threads: page.items.map(threadJson), next_cursor: page.next_cursor });
	});

	r.get('/inboxes/:inbox/threads/:thread', async (c) => {
		const inbox = await requireInbox(c.env.DB, c.req.param('inbox'));
		const thread = await getThread(c.env.DB, inbox.id, c.req.param('thread'));
		if (!thread) throw ApiError.notFound('Thread');
		const messages = await listThreadMessages(c.env.DB, thread.id);
		const attachments = await listAttachmentsForMessages(
			c.env.DB,
			messages.map((m) => m.id),
		);
		return c.json({
			...threadJson(thread),
			messages: messages.map((m) => messageJson(m, attachments.get(m.id) ?? [], { includeBody: true })),
		});
	});

	r.delete('/inboxes/:inbox/threads/:thread', async (c) => {
		const inbox = await requireInbox(c.env.DB, c.req.param('inbox'));
		const { deleted, r2Keys } = await deleteThread(c.env.DB, inbox.id, c.req.param('thread'));
		if (!deleted) throw ApiError.notFound('Thread');
		c.executionCtx.waitUntil(deleteR2Keys(c.env.ATTACHMENTS, r2Keys));
		return c.json({ deleted: true, id: c.req.param('thread') });
	});

	return r;
}
