import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import worker from '../src/index';
import { getConfig } from '../src/env';
import { ingestEmail } from '../src/email/receive';

export const API_KEY = 'test-api-key';
export const DOMAIN = 'mail.example.com';

export interface EmlOptions {
	from?: string;
	to?: string;
	cc?: string;
	subject?: string;
	text?: string;
	html?: string;
	messageId?: string;
	inReplyTo?: string;
	references?: string;
	replyTo?: string;
	attachments?: Array<{ filename: string; contentType: string; content: string; inline?: boolean; contentId?: string }>;
}

/** Build a raw RFC 5322 message. Multipart when html or attachments are present. */
export function buildEml(opts: EmlOptions = {}): string {
	const from = opts.from ?? 'Alice <alice@sender.test>';
	const to = opts.to ?? `agent@${DOMAIN}`;
	const subject = opts.subject ?? 'Hello agent';
	const text = opts.text ?? 'Plain body';
	const messageId = opts.messageId ?? `<${crypto.randomUUID()}@sender.test>`;
	const headers = [
		`From: ${from}`,
		`To: ${to}`,
		...(opts.cc ? [`Cc: ${opts.cc}`] : []),
		...(opts.replyTo ? [`Reply-To: ${opts.replyTo}`] : []),
		`Subject: ${subject}`,
		`Date: ${new Date().toUTCString()}`,
		`Message-ID: ${messageId}`,
		...(opts.inReplyTo ? [`In-Reply-To: ${opts.inReplyTo}`] : []),
		...(opts.references ? [`References: ${opts.references}`] : []),
		'MIME-Version: 1.0',
	];
	const hasParts = Boolean(opts.html || opts.attachments?.length);
	if (!hasParts) {
		return [...headers, 'Content-Type: text/plain; charset=utf-8', '', text, ''].join('\r\n');
	}
	const boundary = `----=_Part_${Math.random().toString(36).slice(2)}`;
	const parts: string[] = [];
	parts.push(['Content-Type: text/plain; charset=utf-8', '', text].join('\r\n'));
	if (opts.html) parts.push(['Content-Type: text/html; charset=utf-8', '', opts.html].join('\r\n'));
	for (const a of opts.attachments ?? []) {
		parts.push(
			[
				`Content-Type: ${a.contentType}; name="${a.filename}"`,
				'Content-Transfer-Encoding: base64',
				`Content-Disposition: ${a.inline ? 'inline' : 'attachment'}; filename="${a.filename}"`,
				...(a.contentId ? [`Content-ID: <${a.contentId}>`] : []),
				'',
				btoa(a.content),
			].join('\r\n'),
		);
	}
	return [
		...headers,
		`Content-Type: multipart/mixed; boundary="${boundary}"`,
		'',
		...parts.flatMap((p) => [`--${boundary}`, p]),
		`--${boundary}--`,
		'',
	].join('\r\n');
}

export async function ingest(eml: string, recipient = `agent@${DOMAIN}`, envelopeFrom = 'alice@sender.test') {
	const raw = new TextEncoder().encode(eml).buffer as ArrayBuffer;
	return ingestEmail(env, getConfig(env), { recipient, envelopeFrom, raw });
}

export async function api(path: string, init: RequestInit & { json?: unknown; auth?: boolean } = {}) {
	const headers = new Headers(init.headers);
	if (init.auth !== false) headers.set('Authorization', `Bearer ${API_KEY}`);
	let body = init.body;
	if (init.json !== undefined) {
		headers.set('Content-Type', 'application/json');
		body = JSON.stringify(init.json);
	}
	const request = new Request(`https://dearagent.test${path}`, { ...init, headers, body });
	const ctx = createExecutionContext();
	const response = await worker.fetch(request, env, ctx);
	await waitOnExecutionContext(ctx);
	return response;
}

export async function apiJson<T = any>(path: string, init: RequestInit & { json?: unknown; auth?: boolean } = {}): Promise<{ status: number; body: T }> {
	const res = await api(path, init);
	const text = await res.text();
	let parsed: unknown = text;
	try {
		parsed = JSON.parse(text);
	} catch {
		/* non-JSON */
	}
	return { status: res.status, body: parsed as T };
}

/** Swap env.EMAIL with a recorder; returns the recorded sends and a restore function. */
export function mockEmailBinding() {
	const sent: EmailMessageBuilder[] = [];
	const original = (env as { EMAIL?: SendEmail }).EMAIL;
	let counter = 0;
	(env as { EMAIL: unknown }).EMAIL = {
		async send(msg: EmailMessageBuilder) {
			sent.push(msg);
			counter++;
			return { messageId: `<out-${counter}@${DOMAIN}>` };
		},
	};
	return {
		sent,
		restore() {
			(env as { EMAIL?: unknown }).EMAIL = original;
		},
	};
}

export interface FetchCall {
	url: string;
	method: string;
	headers: Record<string, string>;
	body: string;
}

/**
 * Replace global fetch for the duration of a test. Handlers match on URL prefix and
 * can be limited to N calls; unmatched requests throw so nothing leaks to the network.
 */
export function mockFetch() {
	const calls: FetchCall[] = [];
	const handlers: Array<{ prefix: string; remaining: number; respond: (req: Request, call: FetchCall) => Response | Promise<Response> }> = [];
	const original = globalThis.fetch;
	globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const req = new Request(input, init);
		const call: FetchCall = {
			url: req.url,
			method: req.method,
			headers: Object.fromEntries([...req.headers.entries()].map(([k, v]) => [k.toLowerCase(), v])),
			body: await req.clone().text(),
		};
		calls.push(call);
		const handler = handlers.find((h) => req.url.startsWith(h.prefix) && h.remaining !== 0);
		if (!handler) throw new Error(`Unexpected fetch: ${req.method} ${req.url}`);
		if (handler.remaining > 0) handler.remaining--;
		return handler.respond(req, call);
	}) as typeof fetch;
	return {
		calls,
		/** `times` < 0 means unlimited. */
		on(prefix: string, respond: (req: Request, call: FetchCall) => Response | Promise<Response>, times = -1) {
			handlers.push({ prefix, remaining: times, respond });
			return this;
		},
		restore() {
			globalThis.fetch = original;
		},
	};
}
