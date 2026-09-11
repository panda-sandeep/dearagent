import { Hono } from 'hono';
import type { AppEnv } from './app';
import { parseBody, parseQuery } from './app';
import { ApiError } from './errors';
import { createInboxSchema, pageQuery, updateInboxSchema } from './schemas';
import { collectInboxR2Keys, deleteInbox, getInbox, listInboxes, updateInbox, upsertInbox } from '../db/inboxes';
import { deleteR2Keys } from '../db/attachments';
import { inboxJson } from './serialize';
import { domainOf, isAllowedDomain, isValidAddress, normalizeAddress, randomLocalPart } from '../email/address';
import type { InboxRow } from '../db/schema';
import type { Config } from '../env';

/** Shared with MCP: resolve the address for a new inbox from partial input. */
export function resolveNewInboxAddress(config: Config, input: { address?: string; local_part?: string; domain?: string }): string {
	if (input.address) {
		const addr = normalizeAddress(input.address);
		if (!isValidAddress(addr)) throw ApiError.badRequest(`Invalid address: ${input.address}`);
		if (!isAllowedDomain(addr, config)) throw ApiError.badRequest(`Domain ${domainOf(addr)} is not in EMAIL_DOMAINS (${config.domains.join(', ')})`);
		return addr;
	}
	const domain = (input.domain ?? config.domains[0]).toLowerCase();
	if (!config.domains.includes(domain)) throw ApiError.badRequest(`Domain ${domain} is not in EMAIL_DOMAINS (${config.domains.join(', ')})`);
	const local = (input.local_part ?? randomLocalPart()).toLowerCase();
	return `${local}@${domain}`;
}

export async function requireInbox(db: D1Database, id: string): Promise<InboxRow> {
	const inbox = await getInbox(db, decodeURIComponent(id));
	if (!inbox) throw ApiError.notFound('Inbox');
	return inbox;
}

export function inboxRoutes() {
	const r = new Hono<AppEnv>();

	r.get('/inboxes', async (c) => {
		const q = parseQuery(c, pageQuery);
		const page = await listInboxes(c.env.DB, q);
		return c.json({ inboxes: page.items.map(inboxJson), next_cursor: page.next_cursor });
	});

	r.post('/inboxes', async (c) => {
		const body = await parseBody(c, createInboxSchema);
		const address = resolveNewInboxAddress(c.get('config'), body);
		const { inbox, created } = await upsertInbox(c.env.DB, { address, displayName: body.display_name ?? null, metadata: body.metadata });
		if (!created && (body.display_name !== undefined || body.metadata !== undefined)) {
			const updated = await updateInbox(c.env.DB, inbox.id, { displayName: body.display_name, metadata: body.metadata });
			return c.json(inboxJson(updated ?? inbox), 200);
		}
		return c.json(inboxJson(inbox), created ? 201 : 200);
	});

	r.get('/inboxes/:inbox', async (c) => {
		const inbox = await requireInbox(c.env.DB, c.req.param('inbox'));
		return c.json(inboxJson(inbox));
	});

	r.patch('/inboxes/:inbox', async (c) => {
		const inbox = await requireInbox(c.env.DB, c.req.param('inbox'));
		const body = await parseBody(c, updateInboxSchema);
		const updated = await updateInbox(c.env.DB, inbox.id, { displayName: body.display_name, metadata: body.metadata });
		return c.json(inboxJson(updated ?? inbox));
	});

	r.delete('/inboxes/:inbox', async (c) => {
		const inbox = await requireInbox(c.env.DB, c.req.param('inbox'));
		const keys = await collectInboxR2Keys(c.env.DB, inbox.id);
		await deleteInbox(c.env.DB, inbox.id);
		c.executionCtx.waitUntil(deleteR2Keys(c.env.ATTACHMENTS, keys));
		return c.json({ deleted: true, id: inbox.id });
	});

	return r;
}
