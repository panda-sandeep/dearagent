import { z } from 'zod';

/** Accepts "a@b.com", "Name <a@b.com>", or { address, name }. */
export const mailboxSchema = z
	.union([
		z.string().min(3),
		z.object({ address: z.string().min(3), name: z.string().max(200).optional() }),
	])
	.transform((v) => {
		if (typeof v !== 'string') return { address: v.address.trim().toLowerCase(), ...(v.name ? { name: v.name } : {}) };
		const m = /^\s*(?:"?([^"<]*?)"?\s*)?<([^<>\s]+)>\s*$/.exec(v);
		if (m) return { address: m[2].toLowerCase(), ...(m[1]?.trim() ? { name: m[1].trim() } : {}) };
		return { address: v.trim().toLowerCase() };
	});

export const mailboxListSchema = z
	.union([mailboxSchema, z.array(mailboxSchema)])
	.transform((v) => (Array.isArray(v) ? v : [v]));

export const attachmentSchema = z.object({
	filename: z.string().min(1).max(255),
	content_type: z.string().min(1).max(200),
	content_base64: z.string().min(1),
	disposition: z.enum(['attachment', 'inline']).optional(),
	content_id: z.string().max(200).optional(),
});

export const labelsSchema = z.array(z.string().min(1).max(64)).max(50);

export const composeSchema = z.object({
	to: mailboxListSchema.optional().default([]),
	cc: mailboxListSchema.optional(),
	bcc: mailboxListSchema.optional(),
	subject: z.string().max(998),
	text: z.string().optional(),
	html: z.string().optional(),
	from_name: z.string().max(200).optional(),
	reply_to: z.string().optional(),
	headers: z.record(z.string(), z.string()).optional(),
	attachments: z.array(attachmentSchema).max(20).optional(),
	labels: labelsSchema.optional(),
});

export const replySchema = z.object({
	text: z.string().optional(),
	html: z.string().optional(),
	/** Append the original message below the reply (default true). */
	quote_original: z.boolean().optional(),
	subject: z.string().max(998).optional(),
	from_name: z.string().max(200).optional(),
	cc: mailboxListSchema.optional(),
	bcc: mailboxListSchema.optional(),
	attachments: z.array(attachmentSchema).max(20).optional(),
	labels: labelsSchema.optional(),
});

export const forwardSchema = z.object({
	to: mailboxListSchema,
	cc: mailboxListSchema.optional(),
	bcc: mailboxListSchema.optional(),
	text: z.string().optional(),
	html: z.string().optional(),
	subject: z.string().max(998).optional(),
	from_name: z.string().max(200).optional(),
	include_attachments: z.boolean().optional(),
	labels: labelsSchema.optional(),
});

export const createInboxSchema = z.object({
	address: z.string().min(3).max(320).optional(),
	local_part: z.string().min(1).max(64).regex(/^[a-zA-Z0-9._+-]+$/, 'local_part may contain letters, digits, . _ + -').optional(),
	domain: z.string().min(3).max(253).optional(),
	display_name: z.string().max(200).nullable().optional(),
	metadata: z.record(z.string(), z.unknown()).optional(),
});

export const updateInboxSchema = z.object({
	display_name: z.string().max(200).nullable().optional(),
	metadata: z.record(z.string(), z.unknown()).optional(),
});

export const updateMessageSchema = z.object({
	read: z.boolean().optional(),
	labels: labelsSchema.optional(),
});

export const webhookEventsSchema = z.array(z.enum(['message.received', 'message.sent'])).min(1);

export const createWebhookSchema = z.object({
	url: z.url({ protocol: /^https?$/ }),
	events: webhookEventsSchema.optional(),
	secret: z.string().min(16).max(200).optional(),
	enabled: z.boolean().optional(),
	/** Only meaningful on POST /webhooks (global). Scope to one inbox instead of firing for all. */
	inbox_id: z.string().optional(),
});

export const updateWebhookSchema = z.object({
	url: z.url({ protocol: /^https?$/ }).optional(),
	events: webhookEventsSchema.optional(),
	secret: z.string().min(16).max(200).optional(),
	enabled: z.boolean().optional(),
});

const boolParam = z
	.enum(['true', 'false', '1', '0'])
	.transform((v) => v === 'true' || v === '1')
	.optional();

/** `since` accepts epoch ms, epoch seconds (< 1e11), or an ISO date. Returns epoch ms. */
export function parseSince(value: string | number | undefined | null): number | undefined {
	if (value === undefined || value === null || value === '') return undefined;
	if (typeof value === 'number' || /^\d+$/.test(value)) {
		const n = Number(value);
		return n < 1e11 ? n * 1000 : n;
	}
	const ms = Date.parse(value);
	if (Number.isNaN(ms)) throw new Error('`since` must be epoch milliseconds or an ISO-8601 date');
	return ms;
}

export const listMessagesQuery = z.object({
	limit: z.string().optional(),
	cursor: z.string().optional(),
	since: z.string().optional(),
	before: z.string().optional(),
	unread: boolParam,
	has_attachment: boolParam,
	direction: z.enum(['inbound', 'outbound']).optional(),
	thread_id: z.string().optional(),
	from: z.string().optional(),
	label: z.string().optional(),
	include_body: boolParam,
});

export const pageQuery = z.object({
	limit: z.string().optional(),
	cursor: z.string().optional(),
});
