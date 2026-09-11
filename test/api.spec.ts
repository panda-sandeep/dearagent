import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { api, apiJson, buildEml, ingest, DOMAIN } from './helpers';

const INBOX = `agent@${DOMAIN}`;
const enc = encodeURIComponent(INBOX);

describe('auth', () => {
	it('serves /health without auth', async () => {
		const { status, body } = await apiJson('/health', { auth: false });
		expect(status).toBe(200);
		expect(body.ok).toBe(true);
	});

	it('rejects missing and wrong bearer tokens', async () => {
		expect((await api('/inboxes', { auth: false })).status).toBe(401);
		expect((await api('/inboxes', { auth: false, headers: { Authorization: 'Bearer nope' } })).status).toBe(401);
		expect((await api('/inboxes', { auth: false, headers: { Authorization: 'Basic abc' } })).status).toBe(401);
	});

	it('accepts the configured key', async () => {
		const { status, body } = await apiJson('/auth/me');
		expect(status).toBe(200);
		expect(body.domains).toEqual(['mail.example.com', 'alt.example.com']);
	});

	it('returns 404 JSON for unknown routes', async () => {
		const { status, body } = await apiJson('/nope');
		expect(status).toBe(404);
		expect(body.error.code).toBe('not_found');
	});
});

describe('inboxes', () => {
	it('creates a random inbox at the default domain', async () => {
		const { status, body } = await apiJson('/inboxes', { method: 'POST', json: {} });
		expect(status).toBe(201);
		expect(body.address).toMatch(new RegExp(`^agent-[a-z0-9]{8}@${DOMAIN.replace('.', '\\.')}$`));
		expect(body.id).toBe(body.address);
	});

	it('creates by local_part + domain and rejects foreign domains', async () => {
		const ok = await apiJson('/inboxes', { method: 'POST', json: { local_part: 'Support', domain: 'alt.example.com', display_name: 'Support Bot' } });
		expect(ok.status).toBe(201);
		expect(ok.body.address).toBe('support@alt.example.com');
		expect(ok.body.display_name).toBe('Support Bot');

		const bad = await apiJson('/inboxes', { method: 'POST', json: { address: 'x@evil.com' } });
		expect(bad.status).toBe(400);
		expect(bad.body.error.message).toContain('EMAIL_DOMAINS');
	});

	it('is idempotent on address (200 on repeat, 201 on first)', async () => {
		const a = await apiJson('/inboxes', { method: 'POST', json: { address: `dup@${DOMAIN}` } });
		const b = await apiJson('/inboxes', { method: 'POST', json: { address: `dup@${DOMAIN}` } });
		expect(a.status).toBe(201);
		expect(b.status).toBe(200);
	});

	it('lists, gets, patches and deletes', async () => {
		await apiJson('/inboxes', { method: 'POST', json: { address: INBOX } });
		const list = await apiJson('/inboxes');
		expect(list.body.inboxes.some((i: any) => i.id === INBOX)).toBe(true);

		const patched = await apiJson(`/inboxes/${enc}`, { method: 'PATCH', json: { display_name: 'Agent', metadata: { owner: 'test' } } });
		expect(patched.body.display_name).toBe('Agent');
		expect(patched.body.metadata).toEqual({ owner: 'test' });

		await ingest(buildEml({ attachments: [{ filename: 'a.txt', contentType: 'text/plain', content: 'hi' }] }));
		const del = await apiJson(`/inboxes/${enc}`, { method: 'DELETE' });
		expect(del.body.deleted).toBe(true);
		expect((await api(`/inboxes/${enc}`)).status).toBe(404);
		const remaining = await env.DB.prepare('SELECT COUNT(*) AS n FROM messages WHERE inbox_id = ?').bind(INBOX).first<{ n: number }>();
		expect(remaining?.n).toBe(0);
		const fts = await env.DB.prepare('SELECT COUNT(*) AS n FROM messages_fts WHERE inbox_id = ?').bind(INBOX).first<{ n: number }>();
		expect(fts?.n).toBe(0);
	});

	it('validates bodies with a structured 400', async () => {
		const { status, body } = await apiJson('/inboxes', { method: 'POST', json: { local_part: 'bad space' } });
		expect(status).toBe(400);
		expect(body.error.code).toBe('bad_request');
		expect(body.error.details).toBeDefined();
	});
});

describe('messages', () => {
	it('lists newest first with snippets, paginates, and returns bodies on get', async () => {
		const ids: string[] = [];
		for (let i = 0; i < 3; i++) {
			const r = await ingest(buildEml({ subject: `Msg ${i}`, text: `Body ${i}` }));
			ids.push(r.messageId);
			await new Promise((res) => setTimeout(res, 2));
		}
		const page1 = await apiJson(`/inboxes/${enc}/messages?limit=2`);
		expect(page1.status).toBe(200);
		expect(page1.body.messages.map((m: any) => m.subject)).toEqual(['Msg 2', 'Msg 1']);
		expect(page1.body.messages[0].text).toBeUndefined();
		expect(page1.body.messages[0].snippet).toBe('Body 2');
		expect(page1.body.next_cursor).toBeTruthy();

		const page2 = await apiJson(`/inboxes/${enc}/messages?limit=2&cursor=${page1.body.next_cursor}`);
		expect(page2.body.messages.map((m: any) => m.subject)).toEqual(['Msg 0']);
		expect(page2.body.next_cursor).toBeNull();

		const one = await apiJson(`/inboxes/${enc}/messages/${ids[0]}`);
		expect(one.body.text.trim()).toBe('Body 0');
		expect(one.body.received_at_ms).toBeTypeOf('number');
	});

	it('supports since / has_attachment / unread filters and latest', async () => {
		const first = await ingest(buildEml({ subject: 'old' }));
		const firstRow = await apiJson(`/inboxes/${enc}/messages/${first.messageId}`);
		await new Promise((res) => setTimeout(res, 5));
		await ingest(buildEml({ subject: 'new', attachments: [{ filename: 'f.txt', contentType: 'text/plain', content: 'x' }] }));

		const since = await apiJson(`/inboxes/${enc}/messages?since=${firstRow.body.received_at_ms}`);
		expect(since.body.messages.map((m: any) => m.subject)).toEqual(['new']);

		const withAtt = await apiJson(`/inboxes/${enc}/messages?has_attachment=true`);
		expect(withAtt.body.messages.map((m: any) => m.subject)).toEqual(['new']);

		const latest = await apiJson(`/inboxes/${enc}/messages/latest`);
		expect(latest.body.subject).toBe('new');
		expect(latest.body.attachments[0].filename).toBe('f.txt');
		expect(latest.body.attachments[0].stored).toBe(true);

		const none = await apiJson(`/inboxes/${enc}/messages/latest?since=${Date.now() + 1000}`);
		expect(none.status).toBe(404);

		await apiJson(`/inboxes/${enc}/messages/${first.messageId}`, { method: 'PATCH', json: { read: true, labels: ['seen'] } });
		const unread = await apiJson(`/inboxes/${enc}/messages?unread=true`);
		expect(unread.body.messages.map((m: any) => m.subject)).toEqual(['new']);
		const labelled = await apiJson(`/inboxes/${enc}/messages?label=seen`);
		expect(labelled.body.messages.map((m: any) => m.subject)).toEqual(['old']);
	});

	it('rejects a bad since value', async () => {
		await ingest(buildEml());
		const { status } = await apiJson(`/inboxes/${enc}/messages?since=yesterday`);
		expect(status).toBe(400);
	});

	it('serves attachments and raw MIME', async () => {
		const r = await ingest(buildEml({ attachments: [{ filename: 'data.csv', contentType: 'text/csv', content: 'a,b' }] }));
		const msg = await apiJson(`/inboxes/${enc}/messages/${r.messageId}`);
		const att = await api(msg.body.attachments[0].url);
		expect(att.status).toBe(200);
		expect(att.headers.get('content-type')).toBe('text/csv');
		expect(att.headers.get('content-disposition')).toContain('data.csv');
		expect(await att.text()).toBe('a,b');

		const raw = await api(`/inboxes/${enc}/messages/${r.messageId}/raw`);
		expect(raw.status).toBe(200);
		expect(raw.headers.get('content-type')).toBe('message/rfc822');
		expect(await raw.text()).toContain('Subject: Hello agent');
	});

	it('full-text searches subject and body', async () => {
		await ingest(buildEml({ subject: 'Invoice 42', text: 'Please pay the invoice by Friday' }));
		await ingest(buildEml({ subject: 'Lunch', text: 'Tacos?' }));
		const hits = await apiJson(`/inboxes/${enc}/messages/search?q=invoice+friday`);
		expect(hits.body.messages.map((m: any) => m.subject)).toEqual(['Invoice 42']);
		const none = await apiJson(`/inboxes/${enc}/messages/search?q=pizza`);
		expect(none.body.messages).toEqual([]);
	});

	it('deletes a message, its attachments, and prunes the empty thread', async () => {
		const r = await ingest(buildEml({ attachments: [{ filename: 'x.bin', contentType: 'application/octet-stream', content: 'zzz' }] }));
		const key = (await env.DB.prepare('SELECT r2_key FROM attachments WHERE message_id = ?').bind(r.messageId).first<{ r2_key: string }>())!.r2_key;
		const del = await apiJson(`/inboxes/${enc}/messages/${r.messageId}`, { method: 'DELETE' });
		expect(del.body.deleted).toBe(true);
		expect(await env.ATTACHMENTS.head(key)).toBeNull();
		expect((await apiJson(`/inboxes/${enc}/threads/${r.threadId}`)).status).toBe(404);
	});

	it('wait returns immediately when a message already exists after since', async () => {
		const before = Date.now() - 1;
		await ingest(buildEml({ subject: 'instant' }));
		const { body } = await apiJson(`/inboxes/${enc}/messages/wait?since=${before}&timeout=1`);
		expect(body.timed_out).toBe(false);
		expect(body.message.subject).toBe('instant');
	});

	it('wait times out cleanly', async () => {
		await ingest(buildEml());
		const { body } = await apiJson(`/inboxes/${enc}/messages/wait?timeout=1`);
		expect(body).toEqual({ message: null, timed_out: true });
	});
});

describe('threads', () => {
	it('lists threads and returns a thread with ordered messages', async () => {
		const root = await ingest(buildEml({ messageId: '<t1@s>', subject: 'Plan' }));
		await ingest(buildEml({ messageId: '<t2@s>', subject: 'Re: Plan', inReplyTo: '<t1@s>', text: 'reply' }));
		await ingest(buildEml({ subject: 'Other' }));

		const list = await apiJson(`/inboxes/${enc}/threads`);
		expect(list.body.threads).toHaveLength(2);
		expect(list.body.threads[0].subject).toBe('Other');

		const thread = await apiJson(`/inboxes/${enc}/threads/${root.threadId}`);
		expect(thread.body.message_count).toBe(2);
		expect(thread.body.messages.map((m: any) => m.message_id)).toEqual(['<t1@s>', '<t2@s>']);
		expect(thread.body.messages[1].text.trim()).toBe('reply');

		const del = await apiJson(`/inboxes/${enc}/threads/${root.threadId}`, { method: 'DELETE' });
		expect(del.body.deleted).toBe(true);
		const after = await apiJson(`/inboxes/${enc}/messages`);
		expect(after.body.messages).toHaveLength(1);
	});
});
