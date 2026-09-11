import { newId, type Config } from '../env';
import { ApiError } from '../api/errors';
import { insertMessageStmts, type NewMessage } from '../db/messages';
import { getThread, insertThreadStmt, newThreadId, touchThreadStmt } from '../db/threads';
import { insertAttachmentStmt, listAttachments } from '../db/attachments';
import type { InboxRow, Mailbox, MessageRow } from '../db/schema';
import { parseJson } from '../db/schema';
import { forwardSubject, isAllowedDomain, isValidAddress, normalizeAddress, normalizeMessageId, replySubject, stripReplyPrefixes, toEmailAddress, uniqueMailboxes } from './address';

export interface OutgoingAttachment {
	filename: string;
	content_type: string;
	/** Base64-encoded bytes. */
	content_base64: string;
	disposition?: 'attachment' | 'inline';
	content_id?: string;
}

export interface ComposeInput {
	to: Mailbox[];
	cc?: Mailbox[];
	bcc?: Mailbox[];
	subject: string;
	text?: string | null;
	html?: string | null;
	fromName?: string | null;
	replyTo?: string | null;
	headers?: Record<string, string>;
	attachments?: OutgoingAttachment[];
	labels?: string[];
}

const MAX_RECIPIENTS = 50;
const MAX_MESSAGE_BYTES = 25 * 1024 * 1024;

export function escapeHtml(s: string): string {
	return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Minimal text → HTML so every outbound message is multipart/alternative (better for spam filters and clients). */
export function textToHtml(text: string): string {
	const paragraphs = text.replace(/\r\n/g, '\n').split(/\n{2,}/);
	const body = paragraphs.map((p) => `<p>${escapeHtml(p).replace(/\n/g, '<br>')}</p>`).join('\n');
	return `<div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;font-size:14px;line-height:1.5">${body}</div>`;
}

/** Ensure both text and html bodies exist, deriving one from the other when only one is given. */
export function completeBodies(text?: string | null, html?: string | null): { text: string | null; html: string | null } {
	if (text && !html) return { text, html: textToHtml(text) };
	if (html && !text) return { text: htmlToText(html), html };
	return { text: text ?? null, html: html ?? null };
}

function htmlToText(html: string): string {
	return html
		.replace(/<style[\s\S]*?<\/style>/gi, '')
		.replace(/<script[\s\S]*?<\/script>/gi, '')
		.replace(/<br\s*\/?>/gi, '\n')
		.replace(/<\/(p|div|li|tr|h\d|blockquote)>/gi, '\n')
		.replace(/<a\s[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, '$2 ($1)')
		.replace(/<[^>]+>/g, '')
		.replace(/&nbsp;/g, ' ')
		.replace(/&amp;/g, '&')
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/[ \t]+\n/g, '\n')
		.replace(/\n{3,}/g, '\n\n')
		.trim();
}

function attributionLine(original: MessageRow): string {
	const who = original.from_name ? `${original.from_name} <${original.from_address}>` : (original.from_address ?? 'unknown sender');
	const when = new Date(original.received_at).toUTCString();
	return `On ${when}, ${who} wrote:`;
}

/** Append the original message below a reply, the way mail clients do. */
export function quoteOriginal(reply: { text: string | null; html: string | null }, original: MessageRow): { text: string | null; html: string | null } {
	const attribution = attributionLine(original);
	const origText = original.text ?? (original.html ? htmlToText(original.html) : '');
	const text = reply.text != null ? `${reply.text}\n\n${attribution}\n${origText.split('\n').map((l) => `> ${l}`).join('\n')}` : null;
	const origHtml = original.html ?? `<pre style="white-space:pre-wrap;font:inherit">${escapeHtml(origText)}</pre>`;
	const html =
		reply.html != null
			? `${reply.html}\n<br><div class="gmail_quote"><div dir="ltr" style="color:#555">${escapeHtml(attribution)}</div><blockquote style="margin:0 0 0 .8ex;border-left:1px solid #ccc;padding-left:1ex">${origHtml}</blockquote></div>`
			: null;
	return { text, html };
}

function decodeBase64(b64: string): ArrayBuffer {
	const clean = b64.replace(/^data:[^,]*,/, '').replace(/\s+/g, '');
	const bin = atob(clean);
	const bytes = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
	return bytes.buffer;
}

function toBindingAttachment(a: OutgoingAttachment): EmailAttachment {
	const content = decodeBase64(a.content_base64);
	if (a.disposition === 'inline') {
		if (!a.content_id) throw ApiError.badRequest(`Inline attachment "${a.filename}" requires content_id`);
		return { disposition: 'inline', contentId: a.content_id, filename: a.filename, type: a.content_type, content };
	}
	return { disposition: 'attachment', filename: a.filename, type: a.content_type, content };
}

function validateRecipients(...lists: Mailbox[][]): void {
	const all = lists.flat();
	if (all.length === 0) throw ApiError.badRequest('At least one recipient (to, cc or bcc) is required');
	if (all.length > MAX_RECIPIENTS) throw ApiError.badRequest(`At most ${MAX_RECIPIENTS} recipients per message`);
	for (const m of all) if (!isValidAddress(m.address)) throw ApiError.badRequest(`Invalid recipient address: ${m.address}`);
}

async function deliver(env: Env, builder: EmailMessageBuilder): Promise<string> {
	try {
		const result = await env.EMAIL.send(builder);
		return normalizeMessageId(result.messageId) ?? `<${crypto.randomUUID()}@dearagent.local>`;
	} catch (error) {
		const err = error as { code?: string; message?: string };
		const code = err?.code ?? 'E_SEND_FAILED';
		const message = err?.message ?? String(error);
		console.log({ error: 'email send failed', code, message });
		if (code === 'E_VALIDATION_ERROR' || code === 'E_FIELD_MISSING' || code === 'E_INVALID_RECIPIENT' || code === 'E_INVALID_FROM') {
			throw ApiError.badRequest(`Email rejected: ${message}`, { code });
		}
		throw ApiError.upstream(`Email service error: ${message}`, { code });
	}
}

interface PersistArgs {
	env: Env;
	inbox: InboxRow;
	threadId: string | null; // null → create thread
	messageIdHeader: string;
	inReplyTo: string | null;
	references: string[];
	from: Mailbox;
	to: Mailbox[];
	cc: Mailbox[];
	bcc: Mailbox[];
	replyTo: string | null;
	subject: string;
	text: string | null;
	html: string | null;
	sizeBytes: number;
	attachments: OutgoingAttachment[];
	labels: string[];
}

async function persistOutbound(a: PersistArgs): Promise<{ messageId: string; threadId: string }> {
	const at = Date.now();
	const messageId = newId('msg');
	const participants = uniqueMailboxes([a.from, ...a.to, ...a.cc]).map((m) => m.address);
	let threadStmt: D1PreparedStatement | null = null;
	let threadId = a.threadId;
	let existing = null;
	if (!threadId) {
		threadId = newThreadId();
		threadStmt = insertThreadStmt(a.env.DB, { id: threadId, inboxId: a.inbox.id, subject: stripReplyPrefixes(a.subject), participants, at });
	} else {
		existing = await getThread(a.env.DB, a.inbox.id, threadId);
	}

	// Outbound attachments are kept in R2 too, so forwards/threads render consistently.
	const r2Writes: Promise<unknown>[] = [];
	const attachmentStmts: D1PreparedStatement[] = [];
	a.attachments.forEach((att, index) => {
		const content = decodeBase64(att.content_base64);
		const key = `att/${a.inbox.id}/${messageId}/${index}-${att.filename.replace(/[^\w.\-]+/g, '_').slice(0, 120)}`;
		r2Writes.push(a.env.ATTACHMENTS.put(key, content, { httpMetadata: { contentType: att.content_type } }));
		attachmentStmts.push(
			insertAttachmentStmt(a.env.DB, {
				id: newId('att'),
				messageId,
				filename: att.filename,
				mimeType: att.content_type,
				size: content.byteLength,
				disposition: att.disposition ?? 'attachment',
				contentId: att.content_id ?? null,
				r2Key: key,
			}),
		);
	});
	await Promise.all(r2Writes);

	const message: NewMessage = {
		id: messageId,
		inboxId: a.inbox.id,
		threadId,
		direction: 'outbound',
		messageIdHeader: a.messageIdHeader,
		inReplyTo: a.inReplyTo,
		references: a.references,
		from: a.from,
		to: a.to,
		cc: a.cc,
		bcc: a.bcc,
		replyTo: a.replyTo,
		subject: a.subject,
		text: a.text,
		html: a.html,
		receivedAt: at,
		expiresAt: null,
		sizeBytes: a.sizeBytes,
		hasAttachments: a.attachments.some((x) => (x.disposition ?? 'attachment') === 'attachment'),
		labels: a.labels,
		read: true,
		rawR2Key: null,
	};
	// Order matters for foreign keys: thread → message → attachments → counters.
	const ordered: D1PreparedStatement[] = [];
	if (threadStmt) ordered.push(threadStmt);
	ordered.push(...insertMessageStmts(a.env.DB, message));
	ordered.push(...attachmentStmts);
	ordered.push(touchThreadStmt(a.env.DB, threadId, at, participants, existing));
	await a.env.DB.batch(ordered);
	return { messageId, threadId };
}

function fromMailbox(inbox: InboxRow, config: Config, fromName?: string | null): Mailbox {
	if (!isAllowedDomain(inbox.address, config)) {
		throw ApiError.badRequest(`Inbox domain is not in EMAIL_DOMAINS; cannot send from ${inbox.address}`);
	}
	const name = fromName ?? inbox.display_name ?? config.defaultFromName;
	return { address: inbox.address, ...(name ? { name } : {}) };
}

function approxSize(input: { text?: string | null; html?: string | null; attachments?: OutgoingAttachment[] }): number {
	const bodies = (input.text?.length ?? 0) + (input.html?.length ?? 0);
	const atts = (input.attachments ?? []).reduce((n, a) => n + Math.ceil((a.content_base64.length * 3) / 4), 0);
	return bodies + atts;
}

function ensureBody(text?: string | null, html?: string | null): void {
	if (!text && !html) throw ApiError.badRequest('Either text or html body is required');
}

/** Start a new thread from an inbox. */
export async function composeMessage(env: Env, config: Config, inbox: InboxRow, input: ComposeInput): Promise<{ messageId: string; threadId: string }> {
	const to = uniqueMailboxes(input.to);
	const cc = uniqueMailboxes(input.cc ?? []);
	const bcc = uniqueMailboxes(input.bcc ?? []);
	validateRecipients(to, cc, bcc);
	ensureBody(input.text, input.html);
	const bodies = completeBodies(input.text, input.html);
	if (approxSize({ ...bodies, attachments: input.attachments }) > MAX_MESSAGE_BYTES) throw ApiError.tooLarge('Message exceeds 25 MiB');
	const from = fromMailbox(inbox, config, input.fromName);

	const builder: EmailMessageBuilder = {
		from: toEmailAddress(from),
		to: to.map(toEmailAddress),
		...(cc.length ? { cc: cc.map(toEmailAddress) } : {}),
		...(bcc.length ? { bcc: bcc.map(toEmailAddress) } : {}),
		subject: input.subject,
		...(bodies.text ? { text: bodies.text } : {}),
		...(bodies.html ? { html: bodies.html } : {}),
		...(input.replyTo ? { replyTo: input.replyTo } : {}),
		...(input.headers && Object.keys(input.headers).length ? { headers: input.headers } : {}),
		...(input.attachments?.length ? { attachments: input.attachments.map(toBindingAttachment) } : {}),
	};
	const messageIdHeader = await deliver(env, builder);
	return persistOutbound({
		env,
		inbox,
		threadId: null,
		messageIdHeader,
		inReplyTo: null,
		references: [],
		from,
		to,
		cc,
		bcc,
		replyTo: input.replyTo ?? null,
		subject: input.subject,
		text: bodies.text,
		html: bodies.html,
		sizeBytes: approxSize({ ...bodies, attachments: input.attachments }),
		attachments: input.attachments ?? [],
		labels: input.labels ?? [],
	});
}

export interface ReplyInput {
	text?: string | null;
	html?: string | null;
	/** Append the original message below the reply body. Default true. */
	quoteOriginal?: boolean;
	subject?: string | null;
	fromName?: string | null;
	attachments?: OutgoingAttachment[];
	labels?: string[];
	/** Extra recipients beyond the automatic ones. */
	cc?: Mailbox[];
	bcc?: Mailbox[];
}

/** Reply (or reply-all) to a stored message, preserving threading headers. */
export async function replyToMessage(
	env: Env,
	config: Config,
	inbox: InboxRow,
	original: MessageRow,
	input: ReplyInput,
	opts: { replyAll: boolean },
): Promise<{ messageId: string; threadId: string }> {
	ensureBody(input.text, input.html);
	let bodies = completeBodies(input.text, input.html);
	if (input.quoteOriginal !== false) bodies = quoteOriginal(bodies, original);
	if (approxSize({ ...bodies, attachments: input.attachments }) > MAX_MESSAGE_BYTES) throw ApiError.tooLarge('Message exceeds 25 MiB');
	const from = fromMailbox(inbox, config, input.fromName);

	// Primary recipient: Reply-To if set, else the original sender. For outbound originals, reply to the original recipients.
	let to: Mailbox[];
	if (original.direction === 'outbound') {
		to = parseJson<Mailbox[]>(original.to_json, []);
	} else if (original.reply_to) {
		to = [{ address: normalizeAddress(original.reply_to) }];
	} else if (original.from_address) {
		to = [{ address: original.from_address, ...(original.from_name ? { name: original.from_name } : {}) }];
	} else {
		throw ApiError.badRequest('Original message has no sender address to reply to');
	}

	let cc: Mailbox[] = input.cc ?? [];
	if (opts.replyAll) {
		const others = [...parseJson<Mailbox[]>(original.to_json, []), ...parseJson<Mailbox[]>(original.cc_json, [])].filter(
			(m) => m.address !== inbox.address && !to.some((t) => t.address === m.address),
		);
		cc = [...others, ...cc];
	}
	to = uniqueMailboxes(to);
	cc = uniqueMailboxes(cc).filter((m) => !to.some((t) => t.address === m.address));
	const bcc = uniqueMailboxes(input.bcc ?? []);
	validateRecipients(to, cc, bcc);

	const inReplyTo = original.message_id_header;
	const references = [...(original.references_hdr ? original.references_hdr.split(/\s+/).filter(Boolean) : []), ...(inReplyTo ? [inReplyTo] : [])].slice(-100);
	const subject = input.subject ?? replySubject(original.subject);
	const headers: Record<string, string> = {};
	if (inReplyTo) headers['In-Reply-To'] = inReplyTo;
	if (references.length) headers['References'] = references.join(' ');

	const builder: EmailMessageBuilder = {
		from: toEmailAddress(from),
		to: to.map(toEmailAddress),
		...(cc.length ? { cc: cc.map(toEmailAddress) } : {}),
		...(bcc.length ? { bcc: bcc.map(toEmailAddress) } : {}),
		subject,
		...(bodies.text ? { text: bodies.text } : {}),
		...(bodies.html ? { html: bodies.html } : {}),
		...(Object.keys(headers).length ? { headers } : {}),
		...(input.attachments?.length ? { attachments: input.attachments.map(toBindingAttachment) } : {}),
	};
	const messageIdHeader = await deliver(env, builder);
	return persistOutbound({
		env,
		inbox,
		threadId: original.thread_id,
		messageIdHeader,
		inReplyTo,
		references,
		from,
		to,
		cc,
		bcc,
		replyTo: null,
		subject,
		text: bodies.text,
		html: bodies.html,
		sizeBytes: approxSize({ ...bodies, attachments: input.attachments }),
		attachments: input.attachments ?? [],
		labels: input.labels ?? [],
	});
}

export interface ForwardInput {
	to: Mailbox[];
	cc?: Mailbox[];
	bcc?: Mailbox[];
	text?: string | null;
	html?: string | null;
	subject?: string | null;
	fromName?: string | null;
	includeAttachments?: boolean;
	labels?: string[];
}

function bufferToBase64(buf: ArrayBuffer): string {
	const bytes = new Uint8Array(buf);
	let bin = '';
	for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
	return btoa(bin);
}

/** Forward a stored message (quoted body + original attachments) to new recipients. Starts a new thread. */
export async function forwardMessage(env: Env, config: Config, inbox: InboxRow, original: MessageRow, input: ForwardInput): Promise<{ messageId: string; threadId: string }> {
	const to = uniqueMailboxes(input.to);
	const cc = uniqueMailboxes(input.cc ?? []);
	const bcc = uniqueMailboxes(input.bcc ?? []);
	validateRecipients(to, cc, bcc);
	const from = fromMailbox(inbox, config, input.fromName);

	const header = [
		'---------- Forwarded message ----------',
		`From: ${original.from_name ? `${original.from_name} <${original.from_address}>` : original.from_address ?? ''}`,
		`Date: ${new Date(original.received_at).toUTCString()}`,
		`Subject: ${original.subject ?? ''}`,
		`To: ${parseJson<Mailbox[]>(original.to_json, [])
			.map((m) => m.address)
			.join(', ')}`,
		'',
	].join('\n');
	const intro = input.text ?? (input.html ? htmlToText(input.html) : '');
	const origText = original.text ?? (original.html ? htmlToText(original.html) : '');
	const text = `${intro ? `${intro}\n\n` : ''}${header}\n${origText}`.trimEnd();
	const introHtml = input.html ?? (intro ? textToHtml(intro) : '');
	const origHtml = original.html ?? `<pre style="white-space:pre-wrap;font:inherit">${escapeHtml(origText)}</pre>`;
	const html = `${introHtml}<br><div class="gmail_quote"><pre style="white-space:pre-wrap;font:inherit;color:#555">${escapeHtml(header)}</pre><blockquote style="margin:0 0 0 .8ex;border-left:1px solid #ccc;padding-left:1ex">${origHtml}</blockquote></div>`;

	const attachments: OutgoingAttachment[] = [];
	if (input.includeAttachments !== false) {
		for (const att of await listAttachments(env.DB, original.id)) {
			if (!att.r2_key) continue;
			const obj = await env.ATTACHMENTS.get(att.r2_key);
			if (!obj) continue;
			attachments.push({
				filename: att.filename ?? 'attachment',
				content_type: att.mime_type ?? 'application/octet-stream',
				content_base64: bufferToBase64(await obj.arrayBuffer()),
				disposition: att.disposition === 'inline' && att.content_id ? 'inline' : 'attachment',
				...(att.disposition === 'inline' && att.content_id ? { content_id: att.content_id } : {}),
			});
		}
	}
	const subject = input.subject ?? forwardSubject(original.subject);
	if (approxSize({ text, html, attachments }) > MAX_MESSAGE_BYTES) throw ApiError.tooLarge('Forwarded message exceeds 25 MiB');

	const builder: EmailMessageBuilder = {
		from: toEmailAddress(from),
		to: to.map(toEmailAddress),
		...(cc.length ? { cc: cc.map(toEmailAddress) } : {}),
		...(bcc.length ? { bcc: bcc.map(toEmailAddress) } : {}),
		subject,
		text,
		html,
		...(attachments.length ? { attachments: attachments.map(toBindingAttachment) } : {}),
	};
	const messageIdHeader = await deliver(env, builder);
	return persistOutbound({
		env,
		inbox,
		threadId: null,
		messageIdHeader,
		inReplyTo: null,
		references: [],
		from,
		to,
		cc,
		bcc,
		replyTo: null,
		subject,
		text,
		html,
		sizeBytes: approxSize({ text, html, attachments }),
		attachments,
		labels: input.labels ?? [],
	});
}
