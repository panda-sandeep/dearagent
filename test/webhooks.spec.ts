import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { apiJson, buildEml, ingest, mockFetch, DOMAIN } from './helpers';
import { signPayload, verifySignature } from '../src/webhooks/deliver';

const INBOX = `agent@${DOMAIN}`;
const enc = encodeURIComponent(INBOX);

let net: ReturnType<typeof mockFetch>;
beforeEach(() => {
	net = mockFetch();
});
afterEach(() => net.restore());

describe('webhooks', () => {
	it('creates global and inbox-scoped webhooks; secret only on create', async () => {
		const created = await apiJson('/webhooks', { method: 'POST', json: { url: 'https://hooks.example.org/in' } });
		expect(created.status).toBe(201);
		expect(created.body.secret).toMatch(/^whsec_[0-9a-f]{64}$/);
		expect(created.body.events).toEqual(['message.received']);
		expect(created.body.inbox_id).toBeNull();

		const fetched = await apiJson(`/webhooks/${created.body.id}`);
		expect(fetched.body.secret).toBeUndefined();
		const withSecret = await apiJson(`/webhooks/${created.body.id}?include_secret=true`);
		expect(withSecret.body.secret).toBe(created.body.secret);

		await apiJson('/inboxes', { method: 'POST', json: { address: INBOX } });
		const scoped = await apiJson(`/inboxes/${enc}/webhooks`, { method: 'POST', json: { url: 'https://hooks.example.org/inbox', events: ['message.received', 'message.sent'] } });
		expect(scoped.body.inbox_id).toBe(INBOX);

		const list = await apiJson('/webhooks');
		expect(list.body.webhooks).toHaveLength(2);
		const globalOnly = await apiJson('/webhooks?scope=global');
		expect(globalOnly.body.webhooks).toHaveLength(1);
		const inboxOnly = await apiJson(`/inboxes/${enc}/webhooks`);
		expect(inboxOnly.body.webhooks).toHaveLength(1);

		const bad = await apiJson('/webhooks', { method: 'POST', json: { url: 'ftp://nope' } });
		expect(bad.status).toBe(400);
	});

	it('delivers a signed message.received payload and records the delivery', async () => {
		const created = await apiJson('/webhooks', { method: 'POST', json: { url: 'https://hooks.example.org/in' } });
		const secret: string = created.body.secret;
		net.on('https://hooks.example.org/in', () => new Response('ok', { status: 200 }));

		const result = await ingest(buildEml({ subject: 'Ping', text: 'pong' }));

		expect(net.calls).toHaveLength(1);
		const { headers, body, method } = net.calls[0];
		expect(method).toBe('POST');
		expect(headers['x-agentmail-event']).toBe('message.received');
		expect(headers['content-type']).toBe('application/json');
		expect(headers['x-agentmail-delivery']).toBeTruthy();
		expect(await verifySignature(secret, headers['x-agentmail-timestamp'], body, headers['x-agentmail-signature'])).toBe(true);
		expect(await verifySignature('wrong', headers['x-agentmail-timestamp'], body, headers['x-agentmail-signature'])).toBe(false);

		const payload = JSON.parse(body);
		expect(payload.type).toBe('message.received');
		expect(payload.inbox_id).toBe(INBOX);
		expect(payload.thread_id).toBe(result.threadId);
		expect(payload.message.id).toBe(result.messageId);
		expect(payload.message.subject).toBe('Ping');
		expect(payload.message.text.trim()).toBe('pong');
		expect(payload.message.body_truncated).toBe(false);

		const deliveries = await apiJson(`/webhooks/${created.body.id}/deliveries`);
		expect(deliveries.body.deliveries).toHaveLength(1);
		expect(deliveries.body.deliveries[0]).toMatchObject({ status: 'delivered', http_status: 200, attempts: 1, message_id: result.messageId });
	});

	it('retries on 5xx and records failure after exhausting attempts', async () => {
		const created = await apiJson('/webhooks', { method: 'POST', json: { url: 'https://hooks.example.org/flaky' } });
		net.on('https://hooks.example.org/flaky', () => new Response('boom', { status: 500 }));

		await ingest(buildEml());

		expect(net.calls).toHaveLength(3);
		const deliveries = await apiJson(`/webhooks/${created.body.id}/deliveries`);
		expect(deliveries.body.deliveries[0]).toMatchObject({ status: 'failed', http_status: 500, attempts: 3, last_error: 'HTTP 500' });
	}, 15_000);

	it('does not retry 4xx', async () => {
		const created = await apiJson('/webhooks', { method: 'POST', json: { url: 'https://hooks.example.org/gone' } });
		net.on('https://hooks.example.org/gone', () => new Response('gone', { status: 410 }));
		await ingest(buildEml());
		expect(net.calls).toHaveLength(1);
		const deliveries = await apiJson(`/webhooks/${created.body.id}/deliveries`);
		expect(deliveries.body.deliveries[0]).toMatchObject({ status: 'failed', http_status: 410, attempts: 1 });
	});

	it('records network errors', async () => {
		const created = await apiJson('/webhooks', { method: 'POST', json: { url: 'https://hooks.example.org/down' } });
		net.on('https://hooks.example.org/down', () => {
			throw new TypeError('connection refused');
		});
		await ingest(buildEml());
		const deliveries = await apiJson(`/webhooks/${created.body.id}/deliveries`);
		expect(deliveries.body.deliveries[0]).toMatchObject({ status: 'failed', http_status: null, attempts: 3, last_error: 'connection refused' });
	}, 15_000);

	it('only fires inbox-scoped hooks for their inbox and respects event filters + enabled flag', async () => {
		await apiJson('/inboxes', { method: 'POST', json: { address: INBOX } });
		await apiJson('/inboxes', { method: 'POST', json: { address: `other@${DOMAIN}` } });
		const scoped = await apiJson(`/inboxes/${enc}/webhooks`, { method: 'POST', json: { url: 'https://hooks.example.org/scoped' } });
		const sentOnly = await apiJson('/webhooks', { method: 'POST', json: { url: 'https://hooks.example.org/sent', events: ['message.sent'] } });
		const disabled = await apiJson('/webhooks', { method: 'POST', json: { url: 'https://hooks.example.org/off', enabled: false } });
		net.on('https://hooks.example.org/', () => new Response(null, { status: 204 }));

		await ingest(buildEml({ to: `other@${DOMAIN}` }), `other@${DOMAIN}`);
		await ingest(buildEml());

		expect(net.calls.map((c) => c.url)).toEqual(['https://hooks.example.org/scoped']);
		expect((await apiJson(`/webhooks/${scoped.body.id}/deliveries`)).body.deliveries).toHaveLength(1);
		expect((await apiJson(`/webhooks/${sentOnly.body.id}/deliveries`)).body.deliveries).toHaveLength(0);
		expect((await apiJson(`/webhooks/${disabled.body.id}/deliveries`)).body.deliveries).toHaveLength(0);
	});

	it('patches and deletes', async () => {
		const created = await apiJson('/webhooks', { method: 'POST', json: { url: 'https://hooks.example.org/a' } });
		const patched = await apiJson(`/webhooks/${created.body.id}`, { method: 'PATCH', json: { enabled: false, events: ['message.sent'] } });
		expect(patched.body.enabled).toBe(false);
		expect(patched.body.events).toEqual(['message.sent']);
		const del = await apiJson(`/webhooks/${created.body.id}`, { method: 'DELETE' });
		expect(del.body.deleted).toBe(true);
		expect((await apiJson(`/webhooks/${created.body.id}`)).status).toBe(404);
	});

	it('signature helper is deterministic', async () => {
		const sig = await signPayload('s', '1', '{}');
		expect(sig).toMatch(/^sha256=[0-9a-f]{64}$/);
		expect(await signPayload('s', '1', '{}')).toBe(sig);
	});
});
