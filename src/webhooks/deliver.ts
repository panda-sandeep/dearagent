import type { Config } from '../env';
import { recordDelivery, webhooksForEvent, type WebhookEventType } from '../db/webhooks';
import type { WebhookRow } from '../db/schema';
import type { MessageJson } from '../api/serialize';

/** Bodies above this are omitted from the webhook payload; the client fetches them via the API. */
const MAX_BODY_BYTES = 32 * 1024;
const RETRY_DELAYS_MS = [0, 1_000, 4_000];

export interface WebhookEvent {
	type: WebhookEventType;
	inbox_id: string;
	thread_id: string;
	message: MessageJson;
}

function trimBody(message: MessageJson): MessageJson & { body_truncated: boolean } {
	const copy: MessageJson & { body_truncated: boolean } = { ...message, body_truncated: false };
	for (const key of ['text', 'html'] as const) {
		const value = copy[key];
		if (typeof value === 'string' && value.length > MAX_BODY_BYTES) {
			copy[key] = null;
			copy.body_truncated = true;
		}
	}
	return copy;
}

async function hmacHex(secret: string, data: string): Promise<string> {
	const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
	const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data));
	return Array.from(new Uint8Array(sig), (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Signature scheme (documented in README):
 *   X-DearAgent-Timestamp: <unix seconds>
 *   X-DearAgent-Signature: sha256=<hex hmac(secret, `${timestamp}.${rawBody}`)>
 */
export async function signPayload(secret: string, timestamp: string, body: string): Promise<string> {
	return `sha256=${await hmacHex(secret, `${timestamp}.${body}`)}`;
}

/** Verify helper for consumers (and tests). Tolerates ±5 minutes of clock skew. */
export async function verifySignature(secret: string, timestamp: string, body: string, signature: string, nowSeconds = Math.floor(Date.now() / 1000)): Promise<boolean> {
	const ts = Number(timestamp);
	if (!Number.isFinite(ts) || Math.abs(nowSeconds - ts) > 300) return false;
	const expected = await signPayload(secret, timestamp, body);
	if (expected.length !== signature.length) return false;
	let diff = 0;
	for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
	return diff === 0;
}

async function deliverOne(env: Env, config: Config, webhook: WebhookRow, event: WebhookEvent, body: string): Promise<void> {
	const deliveryId = crypto.randomUUID();
	const timestamp = String(Math.floor(Date.now() / 1000));
	const signature = await signPayload(webhook.secret, timestamp, body);
	let lastError: string | null = null;
	let httpStatus: number | null = null;
	let attempts = 0;

	for (const delay of RETRY_DELAYS_MS) {
		if (delay) await new Promise((r) => setTimeout(r, delay));
		attempts++;
		try {
			const res = await fetch(webhook.url, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					'User-Agent': 'dearagent-webhooks/1',
					'X-DearAgent-Event': event.type,
					'X-DearAgent-Delivery': deliveryId,
					'X-DearAgent-Timestamp': timestamp,
					'X-DearAgent-Signature': signature,
				},
				body,
				signal: AbortSignal.timeout(config.webhookTimeoutMs),
			});
			httpStatus = res.status;
			if (res.ok) {
				await recordDelivery(env.DB, {
					webhook_id: webhook.id,
					event_type: event.type,
					message_id: event.message.id,
					status: 'delivered',
					http_status: httpStatus,
					attempts,
					last_error: null,
				});
				return;
			}
			lastError = `HTTP ${res.status}`;
			// 4xx other than 408/429 will not succeed on retry.
			if (res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429) break;
		} catch (error) {
			lastError = error instanceof Error ? error.message : String(error);
		}
	}

	console.log({ warn: 'webhook delivery failed', webhook: webhook.id, url: webhook.url, attempts, lastError });
	await recordDelivery(env.DB, {
		webhook_id: webhook.id,
		event_type: event.type,
		message_id: event.message.id,
		status: 'failed',
		http_status: httpStatus,
		attempts,
		last_error: lastError,
	});
}

/** Fan out an event to every matching webhook. Intended to run inside `ctx.waitUntil`. Never throws. */
export async function dispatchEvent(env: Env, config: Config, event: WebhookEvent): Promise<void> {
	try {
		const hooks = await webhooksForEvent(env.DB, event.inbox_id, event.type);
		if (hooks.length === 0) return;
		const payload = {
			id: `evt_${crypto.randomUUID().replace(/-/g, '')}`,
			type: event.type,
			created_at: new Date().toISOString(),
			inbox_id: event.inbox_id,
			thread_id: event.thread_id,
			message: trimBody(event.message),
		};
		const body = JSON.stringify(payload);
		await Promise.allSettled(hooks.map((hook) => deliverOne(env, config, hook, event, body)));
	} catch (error) {
		console.log({ error: 'webhook dispatch failed', message: error instanceof Error ? error.message : String(error) });
	}
}
