import { env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { apiJson, buildEml, ingest, mockEmailBinding, DOMAIN } from './helpers';

const INBOX = `agent@${DOMAIN}`;
const enc = encodeURIComponent(INBOX);

describe('sending', () => {
	let mock: ReturnType<typeof mockEmailBinding>;
	beforeEach(() => {
		mock = mockEmailBinding();
	});
	afterEach(() => mock.restore());

	it('composes a new message, persists it as outbound, and starts a thread', async () => {
		await apiJson('/inboxes', { method: 'POST', json: { address: INBOX, display_name: 'Agent Smith' } });
		const { status, body } = await apiJson(`/inboxes/${enc}/messages`, {
			method: 'POST',
			json: { to: 'Bob <bob@example.org>', cc: ['carol@example.org'], subject: 'Hi', text: 'Hello Bob', labels: ['outreach'] },
		});
		expect(status).toBe(201);
		expect(body.direction).toBe('outbound');
		expect(body.from).toEqual({ address: INBOX, name: 'Agent Smith' });
		expect(body.to).toEqual([{ address: 'bob@example.org', name: 'Bob' }]);
		expect(body.read).toBe(true);
		expect(body.labels).toEqual(['outreach']);
		expect(body.message_id).toBe(`<out-1@${DOMAIN}>`);

		expect(mock.sent).toHaveLength(1);
		const sent = mock.sent[0];
		expect(sent.from).toEqual({ email: INBOX, name: 'Agent Smith' });
		expect(sent.to).toEqual([{ email: 'bob@example.org', name: 'Bob' }]);
		expect(sent.cc).toEqual(['carol@example.org']);
		expect(sent.subject).toBe('Hi');
		expect(sent.text).toBe('Hello Bob');
		// text-only input still goes out multipart: an HTML part is derived.
		expect(sent.html).toContain('<p>Hello Bob</p>');
		expect(body.html).toContain('<p>Hello Bob</p>');

		const thread = await apiJson(`/inboxes/${enc}/threads/${body.thread_id}`);
		expect(thread.body.message_count).toBe(1);
		expect(thread.body.participants).toEqual(expect.arrayContaining([INBOX, 'bob@example.org', 'carol@example.org']));
	});

	it('requires a recipient and a body', async () => {
		await apiJson('/inboxes', { method: 'POST', json: { address: INBOX } });
		const noRcpt = await apiJson(`/inboxes/${enc}/messages`, { method: 'POST', json: { subject: 'x', text: 'y' } });
		expect(noRcpt.status).toBe(400);
		const noBody = await apiJson(`/inboxes/${enc}/messages`, { method: 'POST', json: { to: 'a@b.co', subject: 'x' } });
		expect(noBody.status).toBe(400);
		expect(mock.sent).toHaveLength(0);
	});

	it('replies with threading headers into the same thread', async () => {
		const original = await ingest(
			buildEml({ from: 'Alice <alice@sender.test>', messageId: '<orig@sender.test>', references: '<older@sender.test>', subject: 'Question', cc: 'dave@sender.test' }),
		);
		const { status, body } = await apiJson(`/inboxes/${enc}/messages/${original.messageId}/reply`, { method: 'POST', json: { text: 'Answer' } });
		expect(status).toBe(201);
		expect(body.thread_id).toBe(original.threadId);
		expect(body.subject).toBe('Re: Question');
		expect(body.in_reply_to).toBe('<orig@sender.test>');
		expect(body.references).toEqual(['<older@sender.test>', '<orig@sender.test>']);
		expect(body.to).toEqual([{ address: 'alice@sender.test', name: 'Alice' }]);
		expect(body.cc).toEqual([]);

		const sent = mock.sent[0];
		expect(sent.headers).toEqual({ 'In-Reply-To': '<orig@sender.test>', References: '<older@sender.test> <orig@sender.test>' });
		expect(sent.to).toEqual([{ email: 'alice@sender.test', name: 'Alice' }]);

		const thread = await apiJson(`/inboxes/${enc}/threads/${original.threadId}`);
		expect(thread.body.message_count).toBe(2);
		expect(thread.body.messages.map((m: any) => m.direction)).toEqual(['inbound', 'outbound']);
	});

	it('quotes the original below the reply in both text and html', async () => {
		const original = await ingest(
			buildEml({ from: 'Alice <alice@sender.test>', subject: 'Question', text: 'Line one\nLine two', html: '<p>Line one<br>Line two</p>' }),
		);
		const { body } = await apiJson(`/inboxes/${enc}/messages/${original.messageId}/reply`, { method: 'POST', json: { text: 'Answer' } });
		const sent = mock.sent[0];
		expect(sent.text).toMatch(/^Answer\n\nOn .+, Alice <alice@sender.test> wrote:\n> Line one\n> Line two/);
		expect(sent.html).toContain('<p>Answer</p>');
		expect(sent.html).toContain('class="gmail_quote"');
		expect(sent.html).toContain('<p>Line one<br>Line two</p>');
		expect(sent.html).toContain('Alice &lt;alice@sender.test&gt; wrote:');
		// Stored copy matches what was sent.
		expect(body.text).toBe(sent.text);
		expect(body.html).toBe(sent.html);
	});

	it('omits the quote when quote_original is false, and derives text from html-only replies', async () => {
		const original = await ingest(buildEml({ text: 'Original' }));
		const plain = await apiJson(`/inboxes/${enc}/messages/${original.messageId}/reply`, { method: 'POST', json: { text: 'Bare', quote_original: false } });
		expect(plain.body.text).toBe('Bare');
		expect(plain.body.html).toBe(mock.sent[0].html);
		expect(mock.sent[0].html).not.toContain('gmail_quote');

		await apiJson(`/inboxes/${enc}/messages/${original.messageId}/reply`, {
			method: 'POST',
			json: { html: '<p>Rich <a href="https://x.test">link</a></p>', quote_original: false },
		});
		expect(mock.sent[1].text).toBe('Rich link (https://x.test)');
		expect(mock.sent[1].html).toBe('<p>Rich <a href="https://x.test">link</a></p>');
	});

	it('reply-all copies other recipients but not the inbox itself; honours Reply-To', async () => {
		const original = await ingest(buildEml({ from: 'alice@sender.test', replyTo: 'alice-reply@sender.test', to: `${INBOX}, bob@sender.test`, cc: 'carol@sender.test' }));
		const { body } = await apiJson(`/inboxes/${enc}/messages/${original.messageId}/reply-all`, { method: 'POST', json: { text: 'All' } });
		expect(body.to).toEqual([{ address: 'alice-reply@sender.test' }]);
		expect(body.cc.map((m: any) => m.address).sort()).toEqual(['bob@sender.test', 'carol@sender.test']);
	});

	it('forwards with quoted body and original attachments in a new thread', async () => {
		const original = await ingest(
			buildEml({ subject: 'Docs', text: 'See attached', attachments: [{ filename: 'doc.txt', contentType: 'text/plain', content: 'contents' }] }),
		);
		const { status, body } = await apiJson(`/inboxes/${enc}/messages/${original.messageId}/forward`, { method: 'POST', json: { to: 'erin@example.org', text: 'FYI' } });
		expect(status).toBe(201);
		expect(body.subject).toBe('Fwd: Docs');
		expect(body.thread_id).not.toBe(original.threadId);
		expect(body.text).toContain('FYI');
		expect(body.text).toContain('---------- Forwarded message ----------');
		expect(body.text).toContain('See attached');
		expect(body.html).toContain('Forwarded message');
		expect(body.html).toContain('<p>FYI</p>');
		expect(body.attachments).toHaveLength(1);

		const sent = mock.sent[0];
		expect(sent.attachments).toHaveLength(1);
		const att = sent.attachments![0];
		expect(att.filename).toBe('doc.txt');
		expect(new TextDecoder().decode(att.content as ArrayBuffer)).toBe('contents');
	});

	it('sends base64 attachments and stores them', async () => {
		await apiJson('/inboxes', { method: 'POST', json: { address: INBOX } });
		const { body } = await apiJson(`/inboxes/${enc}/messages`, {
			method: 'POST',
			json: { to: 'x@y.co', subject: 's', text: 'b', attachments: [{ filename: 'n.txt', content_type: 'text/plain', content_base64: btoa('note') }] },
		});
		expect(body.attachments[0].filename).toBe('n.txt');
		const key = (await env.DB.prepare('SELECT r2_key FROM attachments WHERE message_id = ?').bind(body.id).first<{ r2_key: string }>())!.r2_key;
		expect(await (await env.ATTACHMENTS.get(key))!.text()).toBe('note');
	});

	it('maps binding errors to 4xx/502', async () => {
		await apiJson('/inboxes', { method: 'POST', json: { address: INBOX } });
		(env as any).EMAIL = {
			async send() {
				throw Object.assign(new Error('bad recipient'), { code: 'E_INVALID_RECIPIENT' });
			},
		};
		const bad = await apiJson(`/inboxes/${enc}/messages`, { method: 'POST', json: { to: 'x@y.co', subject: 's', text: 'b' } });
		expect(bad.status).toBe(400);
		(env as any).EMAIL = {
			async send() {
				throw Object.assign(new Error('quota'), { code: 'E_RATE_LIMITED' });
			},
		};
		const upstream = await apiJson(`/inboxes/${enc}/messages`, { method: 'POST', json: { to: 'x@y.co', subject: 's', text: 'b' } });
		expect(upstream.status).toBe(502);
		// Nothing persisted on failure.
		const n = await env.DB.prepare('SELECT COUNT(*) AS n FROM messages WHERE inbox_id = ?').bind(INBOX).first<{ n: number }>();
		expect(n?.n).toBe(0);
	});
});
