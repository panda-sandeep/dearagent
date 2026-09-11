import PostalMime, { type Address as PmAddress, type Email as ParsedEmail } from 'postal-mime';
import { getConfig, newId, type Config, type WaitUntil } from '../env';
import { getInbox, upsertInbox } from '../db/inboxes';
import { findByMessageIdHeader, insertMessageStmts, type NewMessage } from '../db/messages';
import { getThread, insertThreadStmt, touchThreadStmt } from '../db/threads';
import { insertAttachmentStmt, listAttachments } from '../db/attachments';
import type { Mailbox } from '../db/schema';
import { messageJson } from '../api/serialize';
import { dispatchEvent } from '../webhooks/deliver';
import { isAllowedDomain, normalizeAddress, normalizeMessageId, parseReferences, stripReplyPrefixes, ttlSecondsFromAddress, uniqueMailboxes } from './address';
import { resolveThread } from './threading';

/** Flatten postal-mime addresses (which may contain groups) into plain mailboxes. */
export function flattenAddresses(list: PmAddress[] | undefined | null): Mailbox[] {
	const out: Mailbox[] = [];
	for (const entry of list ?? []) {
		if (entry.group) {
			for (const m of entry.group) if (m.address) out.push({ address: normalizeAddress(m.address), ...(m.name ? { name: m.name } : {}) });
		} else if (entry.address) {
			out.push({ address: normalizeAddress(entry.address), ...(entry.name ? { name: entry.name } : {}) });
		}
	}
	return uniqueMailboxes(out);
}

function toArrayBuffer(content: ArrayBuffer | Uint8Array | string): ArrayBuffer {
	if (typeof content === 'string') return new TextEncoder().encode(content).buffer as ArrayBuffer;
	if (content instanceof Uint8Array) return content.buffer.slice(content.byteOffset, content.byteOffset + content.byteLength) as ArrayBuffer;
	return content;
}

function safeFilename(name: string | null, index: number): string {
	const base = (name ?? `attachment-${index + 1}`).replace(/[^\w.\-]+/g, '_').slice(0, 120);
	return base || `attachment-${index + 1}`;
}

export interface IngestResult {
	status: 'stored' | 'duplicate';
	messageId: string;
	threadId: string;
	inboxId: string;
}

/**
 * Store an already-buffered raw email addressed to `recipient`.
 * Shared by the `email()` handler and tests (which cannot construct ForwardableEmailMessage).
 */
export async function ingestEmail(
	env: Env,
	config: Config,
	args: { recipient: string; envelopeFrom: string; raw: ArrayBuffer; ctx?: WaitUntil },
): Promise<IngestResult> {
	const recipient = normalizeAddress(args.recipient);
	const parsed: ParsedEmail = await PostalMime.parse(args.raw, { attachmentEncoding: 'arraybuffer' });

	const { inbox } = await upsertInbox(env.DB, { address: recipient });
	const receivedAt = Date.now();

	const messageIdHeader = normalizeMessageId(parsed.messageId) ?? `<${crypto.randomUUID()}@dearagent.local>`;
	const duplicate = await findByMessageIdHeader(env.DB, inbox.id, messageIdHeader);
	if (duplicate) {
		return { status: 'duplicate', messageId: duplicate.id, threadId: duplicate.thread_id, inboxId: inbox.id };
	}

	const from = flattenAddresses(parsed.from ? [parsed.from] : [])[0] ?? { address: normalizeAddress(args.envelopeFrom) };
	const to = flattenAddresses(parsed.to);
	const cc = flattenAddresses(parsed.cc);
	const bcc = flattenAddresses(parsed.bcc);
	const replyTo = flattenAddresses(parsed.replyTo)[0]?.address ?? null;
	const references = parseReferences(parsed.references);
	const inReplyTo = normalizeMessageId(parsed.inReplyTo);

	const { threadId, isNew } = await resolveThread(env.DB, inbox.id, { inReplyTo, references });
	const participants = uniqueMailboxes([from, ...to, ...cc]).map((m) => m.address);

	const messageId = newId('msg');
	const ttl = ttlSecondsFromAddress(recipient);
	const expiresAt = ttl ? receivedAt + ttl * 1000 : null;

	// Attachments → R2 (bounded by MAX_ATTACHMENT_BYTES).
	const attachmentStmts: D1PreparedStatement[] = [];
	const r2Writes: Promise<unknown>[] = [];
	parsed.attachments.forEach((att, index) => {
		const bytes = toArrayBuffer(att.content);
		const size = bytes.byteLength;
		const attachmentId = newId('att');
		const store = size <= config.maxAttachmentBytes;
		const r2Key = store ? `att/${inbox.id}/${messageId}/${index}-${safeFilename(att.filename, index)}` : null;
		if (r2Key) {
			r2Writes.push(
				env.ATTACHMENTS.put(r2Key, bytes, {
					httpMetadata: { contentType: att.mimeType || 'application/octet-stream' },
					customMetadata: { filename: att.filename ?? '', messageId },
				}),
			);
		}
		attachmentStmts.push(
			insertAttachmentStmt(env.DB, {
				id: attachmentId,
				messageId,
				filename: att.filename,
				mimeType: att.mimeType || null,
				size,
				disposition: att.disposition ?? (att.contentId ? 'inline' : 'attachment'),
				contentId: att.contentId ? att.contentId.replace(/^<|>$/g, '') : null,
				r2Key,
			}),
		);
	});

	let rawR2Key: string | null = null;
	if (config.storeRaw) {
		rawR2Key = `raw/${inbox.id}/${messageId}.eml`;
		r2Writes.push(env.ATTACHMENTS.put(rawR2Key, args.raw, { httpMetadata: { contentType: 'message/rfc822' } }));
	}
	await Promise.all(r2Writes);

	const message: NewMessage = {
		id: messageId,
		inboxId: inbox.id,
		threadId,
		direction: 'inbound',
		messageIdHeader,
		inReplyTo,
		references,
		from,
		to,
		cc,
		bcc,
		replyTo,
		subject: parsed.subject ?? null,
		text: parsed.text ?? null,
		html: parsed.html ?? null,
		receivedAt,
		expiresAt,
		sizeBytes: args.raw.byteLength,
		hasAttachments: parsed.attachments.some((a) => a.disposition === 'attachment' || (!a.disposition && !a.contentId)),
		rawR2Key,
	};

	const existingThread = isNew ? null : await getThread(env.DB, inbox.id, threadId);
	const stmts: D1PreparedStatement[] = [];
	if (isNew) {
		stmts.push(insertThreadStmt(env.DB, { id: threadId, inboxId: inbox.id, subject: stripReplyPrefixes(parsed.subject), participants, at: receivedAt }));
	}
	stmts.push(...insertMessageStmts(env.DB, message));
	stmts.push(...attachmentStmts);
	stmts.push(touchThreadStmt(env.DB, threadId, receivedAt, participants, existingThread));
	await env.DB.batch(stmts);

	// Webhook fan-out. Runs after the response when a ctx is available.
	const fire = async () => {
		const row = await findByMessageIdHeader(env.DB, inbox.id, messageIdHeader);
		if (!row) return;
		const attachments = await listAttachments(env.DB, row.id);
		await dispatchEvent(env, config, {
			type: 'message.received',
			inbox_id: inbox.id,
			thread_id: threadId,
			message: messageJson(row, attachments, { includeBody: true }),
		});
	};
	if (args.ctx) args.ctx.waitUntil(fire());
	else await fire();

	return { status: 'stored', messageId, threadId, inboxId: inbox.id };
}

/** Cloudflare Email Routing entry point. */
export async function handleEmail(message: ForwardableEmailMessage, env: Env, ctx: ExecutionContext): Promise<void> {
	let config: Config;
	try {
		config = getConfig(env);
	} catch (error) {
		console.log({ error: 'configuration error', message: error instanceof Error ? error.message : String(error) });
		// Temporary failure so the sender retries once the deployment is fixed.
		message.setReject('Mailbox temporarily unavailable');
		return;
	}

	const recipient = normalizeAddress(message.to);
	if (!isAllowedDomain(recipient, config)) {
		message.setReject('Recipient domain not handled by this server');
		return;
	}
	if (!config.allowUnknownInbox && !(await getInbox(env.DB, recipient))) {
		message.setReject('No such mailbox');
		return;
	}

	const raw = await new Response(message.raw).arrayBuffer();
	try {
		const result = await ingestEmail(env, config, { recipient, envelopeFrom: message.from, raw, ctx });
		console.log({ event: 'email.ingested', ...result, from: message.from, size: message.rawSize });
	} catch (error) {
		console.log({ error: 'ingest failed', message: error instanceof Error ? error.message : String(error), to: recipient });
		message.setReject('Temporary failure storing message');
	}
}
