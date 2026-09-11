/**
 * MCP (Model Context Protocol) endpoint at /mcp — Streamable HTTP, stateless.
 * Every tool is a thin wrapper over the same functions the REST API uses.
 *
 * Connect from Claude Code:
 *   claude mcp add --transport http agentmail https://<worker>/mcp --header "Authorization: Bearer <API_KEY>"
 */
import { Hono } from 'hono';
import { z } from 'zod';
import { McpServer, createMcpHandler, type McpHttpHandler } from '@modelcontextprotocol/server';
import type { AppEnv } from '../api/app';
import { ApiError } from '../api/errors';
import type { Config, WaitUntil } from '../env';
import { getInbox, listInboxes, upsertInbox } from '../db/inboxes';
import { getThread, listThreads } from '../db/threads';
import { getMessage, latestMessage, listMessages, listThreadMessages, searchMessages, updateMessage } from '../db/messages';
import { listAttachments, listAttachmentsForMessages } from '../db/attachments';
import { createWebhook, listWebhooks } from '../db/webhooks';
import { inboxJson, messageJson, threadJson, webhookJson } from '../api/serialize';
import { resolveNewInboxAddress } from '../api/inboxes';
import { afterSend, waitForMessage } from '../api/messages';
import { pickMessage } from '../api/extract';
import { composeMessage, replyToMessage, forwardMessage } from '../email/send';
import { extractFromMessage } from '../ai/extract';
import { mailboxListSchema, attachmentSchema, parseSince } from '../api/schemas';
import type { InboxRow } from '../db/schema';

type ToolResult = { content: Array<{ type: 'text'; text: string }>; isError?: boolean };

function ok(data: unknown): ToolResult {
	return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
}

function fail(error: unknown): ToolResult {
	const message = error instanceof ApiError ? `${error.code}: ${error.message}` : error instanceof Error ? error.message : String(error);
	return { content: [{ type: 'text', text: message }], isError: true };
}

async function requireInbox(db: D1Database, id: string): Promise<InboxRow> {
	const inbox = await getInbox(db, id);
	if (!inbox) throw ApiError.notFound(`Inbox "${id}"`);
	return inbox;
}

const inboxIdArg = z.string().describe('Inbox id, which is the lowercased email address, e.g. "agent-x7k2@mail.example.com"');
const sinceArg = z
	.union([z.number(), z.string()])
	.optional()
	.describe('Only messages received after this instant. Epoch milliseconds or ISO-8601. Tip: pass received_at_ms of the last message you saw.');

export function buildMcpServer(env: Env, config: Config, ctx: WaitUntil): McpServer {
	const server = new McpServer({ name: 'agentmail', version: '0.1.0' });
	const db = env.DB;

	const wrap =
		<A>(fn: (args: A) => Promise<unknown>) =>
		async (args: A): Promise<ToolResult> => {
			try {
				return ok(await fn(args));
			} catch (error) {
				return fail(error);
			}
		};

	server.registerTool(
		'list_inboxes',
		{ description: 'List email inboxes on this server (newest first).', inputSchema: z.object({ limit: z.number().int().min(1).max(100).optional(), cursor: z.string().optional() }) },
		wrap(async ({ limit, cursor }) => {
			const page = await listInboxes(db, { limit, cursor });
			return { inboxes: page.items.map(inboxJson), next_cursor: page.next_cursor };
		}),
	);

	server.registerTool(
		'create_inbox',
		{
			description: `Create an inbox (email address) that this agent can receive mail at. Omit all fields to get a random address at ${config.domains[0]}. Mail sent to any address at a configured domain is accepted even without creating an inbox first (when ALLOW_UNKNOWN_INBOX is true).`,
			inputSchema: z.object({
				address: z.string().optional().describe('Full address. Domain must be one of: ' + config.domains.join(', ')),
				local_part: z.string().optional().describe('Part before the @. Ignored when address is given.'),
				domain: z.string().optional().describe('Defaults to the first configured domain.'),
				display_name: z.string().optional(),
			}),
		},
		wrap(async (input) => {
			const address = resolveNewInboxAddress(config, input);
			const { inbox, created } = await upsertInbox(db, { address, displayName: input.display_name ?? null });
			return { created, inbox: inboxJson(inbox) };
		}),
	);

	server.registerTool(
		'list_threads',
		{ description: 'List conversation threads in an inbox, most recent activity first.', inputSchema: z.object({ inbox_id: inboxIdArg, limit: z.number().int().min(1).max(100).optional(), cursor: z.string().optional() }) },
		wrap(async ({ inbox_id, limit, cursor }) => {
			const inbox = await requireInbox(db, inbox_id);
			const page = await listThreads(db, inbox.id, { limit, cursor });
			return { threads: page.items.map(threadJson), next_cursor: page.next_cursor };
		}),
	);

	server.registerTool(
		'get_thread',
		{ description: 'Get a thread with all of its messages (full bodies), oldest first.', inputSchema: z.object({ inbox_id: inboxIdArg, thread_id: z.string() }) },
		wrap(async ({ inbox_id, thread_id }) => {
			const inbox = await requireInbox(db, inbox_id);
			const thread = await getThread(db, inbox.id, thread_id);
			if (!thread) throw ApiError.notFound('Thread');
			const messages = await listThreadMessages(db, thread.id);
			const atts = await listAttachmentsForMessages(
				db,
				messages.map((m) => m.id),
			);
			return { ...threadJson(thread), messages: messages.map((m) => messageJson(m, atts.get(m.id) ?? [], { includeBody: true })) };
		}),
	);

	server.registerTool(
		'list_messages',
		{
			description: 'List messages in an inbox, newest first. Returns snippets; use get_message for full bodies.',
			inputSchema: z.object({
				inbox_id: inboxIdArg,
				since: sinceArg,
				unread: z.boolean().optional(),
				has_attachment: z.boolean().optional(),
				direction: z.enum(['inbound', 'outbound']).optional(),
				from: z.string().optional().describe('Exact sender address'),
				limit: z.number().int().min(1).max(100).optional(),
				cursor: z.string().optional(),
			}),
		},
		wrap(async (a) => {
			const inbox = await requireInbox(db, a.inbox_id);
			const page = await listMessages(
				db,
				inbox.id,
				{ since: parseSince(a.since), unread: a.unread, hasAttachment: a.has_attachment, direction: a.direction, from: a.from },
				{ limit: a.limit, cursor: a.cursor },
			);
			const atts = await listAttachmentsForMessages(
				db,
				page.items.map((m) => m.id),
			);
			return { messages: page.items.map((m) => messageJson(m, atts.get(m.id) ?? [], { includeBody: false })), next_cursor: page.next_cursor };
		}),
	);

	server.registerTool(
		'get_message',
		{ description: 'Get one message with full text/html bodies and attachment metadata.', inputSchema: z.object({ inbox_id: inboxIdArg, message_id: z.string(), mark_read: z.boolean().optional() }) },
		wrap(async ({ inbox_id, message_id, mark_read }) => {
			const inbox = await requireInbox(db, inbox_id);
			let row = await getMessage(db, inbox.id, message_id);
			if (!row) throw ApiError.notFound('Message');
			if (mark_read && !row.read) row = (await updateMessage(db, inbox.id, row.id, { read: true })) ?? row;
			return messageJson(row, await listAttachments(db, row.id), { includeBody: true });
		}),
	);

	server.registerTool(
		'get_latest_message',
		{
			description: 'Return the newest message in an inbox (optionally only if newer than `since`), with full body. Returns null when there is none.',
			inputSchema: z.object({ inbox_id: inboxIdArg, since: sinceArg, has_attachment: z.boolean().optional(), from: z.string().optional() }),
		},
		wrap(async (a) => {
			const inbox = await requireInbox(db, a.inbox_id);
			const row = await latestMessage(db, inbox.id, { since: parseSince(a.since), hasAttachment: a.has_attachment, from: a.from });
			return row ? messageJson(row, await listAttachments(db, row.id), { includeBody: true }) : null;
		}),
	);

	server.registerTool(
		'wait_for_message',
		{
			description:
				'Block up to timeout_seconds (max 25) waiting for a message newer than `since` (defaults to now). Use this instead of polling after triggering an email, e.g. a verification code. Returns { message, timed_out }.',
			inputSchema: z.object({ inbox_id: inboxIdArg, since: sinceArg, timeout_seconds: z.number().min(1).max(25).optional(), from: z.string().optional(), has_attachment: z.boolean().optional() }),
		},
		wrap(async (a) => {
			const inbox = await requireInbox(db, a.inbox_id);
			const since = parseSince(a.since) ?? Date.now();
			const row = await waitForMessage(db, inbox.id, { since, from: a.from, hasAttachment: a.has_attachment }, (a.timeout_seconds ?? 25) * 1000);
			return row ? { timed_out: false, message: messageJson(row, await listAttachments(db, row.id), { includeBody: true }) } : { timed_out: true, message: null };
		}),
	);

	server.registerTool(
		'search_messages',
		{ description: 'Full-text search over subject, body and sender within an inbox.', inputSchema: z.object({ inbox_id: inboxIdArg, query: z.string().min(1), limit: z.number().int().min(1).max(100).optional() }) },
		wrap(async ({ inbox_id, query, limit }) => {
			const inbox = await requireInbox(db, inbox_id);
			const rows = await searchMessages(db, inbox.id, query, { limit });
			const atts = await listAttachmentsForMessages(
				db,
				rows.map((m) => m.id),
			);
			return { messages: rows.map((m) => messageJson(m, atts.get(m.id) ?? [], { includeBody: false })) };
		}),
	);

	server.registerTool(
		'send_message',
		{
			description: 'Send a new email from an inbox (starts a new thread). Requires Email Sending to be enabled for the inbox domain.',
			inputSchema: z.object({
				inbox_id: inboxIdArg,
				to: mailboxListSchema,
				cc: mailboxListSchema.optional(),
				bcc: mailboxListSchema.optional(),
				subject: z.string(),
				text: z.string().optional(),
				html: z.string().optional(),
				from_name: z.string().optional(),
				attachments: z.array(attachmentSchema).optional(),
			}),
		},
		wrap(async (a) => {
			const inbox = await requireInbox(db, a.inbox_id);
			const ids = await composeMessage(env, config, inbox, { to: a.to, cc: a.cc, bcc: a.bcc, subject: a.subject, text: a.text, html: a.html, fromName: a.from_name, attachments: a.attachments });
			return afterSend(env, config, inbox, ids, ctx);
		}),
	);

	server.registerTool(
		'reply_to_message',
		{
			description: 'Reply to a message in the same thread (sets In-Reply-To/References). reply_all also copies the other original recipients.',
			inputSchema: z.object({ inbox_id: inboxIdArg, message_id: z.string(), text: z.string().optional(), html: z.string().optional(), reply_all: z.boolean().optional(), attachments: z.array(attachmentSchema).optional() }),
		},
		wrap(async (a) => {
			const inbox = await requireInbox(db, a.inbox_id);
			const original = await getMessage(db, inbox.id, a.message_id);
			if (!original) throw ApiError.notFound('Message');
			const ids = await replyToMessage(env, config, inbox, original, { text: a.text, html: a.html, attachments: a.attachments }, { replyAll: a.reply_all === true });
			return afterSend(env, config, inbox, ids, ctx);
		}),
	);

	server.registerTool(
		'forward_message',
		{ description: 'Forward a message (with its attachments) to new recipients.', inputSchema: z.object({ inbox_id: inboxIdArg, message_id: z.string(), to: mailboxListSchema, text: z.string().optional().describe('Optional note above the forwarded content') }) },
		wrap(async (a) => {
			const inbox = await requireInbox(db, a.inbox_id);
			const original = await getMessage(db, inbox.id, a.message_id);
			if (!original) throw ApiError.notFound('Message');
			const ids = await forwardMessage(env, config, inbox, original, { to: a.to, text: a.text });
			return afterSend(env, config, inbox, ids, ctx);
		}),
	);

	server.registerTool(
		'extract_from_message',
		{
			description:
				'Use an LLM to pull specific data out of an email (e.g. "the 6-digit verification code", "the confirmation link"). Targets message_id, or the newest message (after `since`) when omitted. Optionally pass a JSON Schema to get structured output.',
			inputSchema: z.object({ inbox_id: inboxIdArg, prompt: z.string(), message_id: z.string().optional(), since: sinceArg, schema: z.record(z.string(), z.unknown()).optional() }),
		},
		wrap(async (a) => {
			const inbox = await requireInbox(db, a.inbox_id);
			const message = await pickMessage(db, inbox, { message_id: a.message_id, since: a.since });
			const out = await extractFromMessage(env, config, message, { prompt: a.prompt, schema: a.schema });
			return { ...out, message_id: message.id, thread_id: message.thread_id };
		}),
	);

	server.registerTool(
		'list_webhooks',
		{ description: 'List webhooks (global and per-inbox).', inputSchema: z.object({ inbox_id: inboxIdArg.optional() }) },
		wrap(async ({ inbox_id }) => {
			const rows = await listWebhooks(db, inbox_id ? (await requireInbox(db, inbox_id)).id : undefined);
			return { webhooks: rows.map((w) => webhookJson(w, { includeSecret: false })) };
		}),
	);

	server.registerTool(
		'create_webhook',
		{
			description: 'Register a URL to be POSTed when mail arrives (message.received) or is sent (message.sent). Omit inbox_id for a global webhook. The returned secret signs payloads (see README).',
			inputSchema: z.object({ url: z.url(), inbox_id: inboxIdArg.optional(), events: z.array(z.enum(['message.received', 'message.sent'])).optional() }),
		},
		wrap(async ({ url, inbox_id, events }) => {
			const inboxId = inbox_id ? (await requireInbox(db, inbox_id)).id : null;
			const row = await createWebhook(db, { inboxId, url, events });
			return webhookJson(row, { includeSecret: true });
		}),
	);

	return server;
}

// One handler per isolate; the factory reads env/config/ctx for the current request from a holder.
let handler: McpHttpHandler | null = null;
let current: { env: Env; config: Config; ctx: WaitUntil } | null = null;

function getHandler(): McpHttpHandler {
	if (!handler) {
		handler = createMcpHandler(
			() => {
				if (!current) throw new Error('MCP request context missing');
				return buildMcpServer(current.env, current.config, current.ctx);
			},
			{ onerror: (error) => console.log({ error: 'mcp', message: error.message }) },
		);
	}
	return handler;
}

export function mcpRoutes() {
	const r = new Hono<AppEnv>();
	r.all('/mcp', async (c) => {
		current = { env: c.env, config: c.get('config'), ctx: c.executionCtx };
		try {
			return await getHandler().fetch(c.req.raw);
		} finally {
			current = null;
		}
	});
	return r;
}
