import { env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { apiJson, buildEml, ingest, mockFetch, DOMAIN } from './helpers';
import { buildPrompt } from '../src/ai/extract';
import { getMessage } from '../src/db/messages';

const INBOX = `agent@${DOMAIN}`;
const enc = encodeURIComponent(INBOX);

let net: ReturnType<typeof mockFetch>;
beforeEach(() => {
	net = mockFetch();
});
afterEach(() => net.restore());

function mockAi(handler: (model: string, input: any) => unknown) {
	const original = (env as any).AI;
	(env as any).AI = { run: async (model: string, input: unknown) => handler(model, input) };
	return () => {
		(env as any).AI = original;
	};
}

describe('extract', () => {
	it('uses Workers AI by default with a JSON schema and unwraps the result', async () => {
		const r = await ingest(buildEml({ subject: 'Verify', text: 'Your code is 493021. It expires soon.' }));
		let seen: any = null;
		const restore = mockAi((model, input) => {
			seen = { model, input };
			return { response: { result: '493021' } };
		});
		try {
			const { status, body } = await apiJson(`/inboxes/${enc}/extract`, { method: 'POST', json: { prompt: 'Return the 6 digit code' } });
			expect(status).toBe(200);
			expect(body.result).toBe('493021');
			expect(body.provider).toBe('workers-ai');
			expect(body.message_id).toBe(r.messageId);
			expect(seen.model).toBe('@cf/meta/llama-3.3-70b-instruct-fp8-fast');
			expect(seen.input.response_format.type).toBe('json_schema');
			expect(seen.input.messages[1].content).toContain('Your code is 493021');
			expect(seen.input.messages[1].content).toContain('Instructions: Return the 6 digit code');
		} finally {
			restore();
		}
	});

	it('parses string responses (including fenced JSON) and returns whole objects for custom schemas', async () => {
		await ingest(buildEml({ text: 'Order #77 shipped to Paris' }));
		const restore = mockAi(() => ({ response: '```json\n{"order":"77","city":"Paris"}\n```' }));
		try {
			const schema = { type: 'object', properties: { order: { type: 'string' }, city: { type: 'string' } }, required: ['order', 'city'] };
			const { body } = await apiJson(`/inboxes/${enc}/extract`, { method: 'POST', json: { prompt: 'extract', schema } });
			expect(body.result).toEqual({ order: '77', city: 'Paris' });
		} finally {
			restore();
		}
	});

	it('targets a specific message and honours since', async () => {
		const first = await ingest(buildEml({ text: 'first' }));
		await new Promise((r) => setTimeout(r, 3));
		const second = await ingest(buildEml({ text: 'second' }));
		const restore = mockAi((_m, input) => ({ response: { result: /Body:\n(\w+)/.exec(input.messages[1].content)![1] } }));
		try {
			const byId = await apiJson(`/inboxes/${enc}/messages/${first.messageId}/extract`, { method: 'POST', json: { prompt: 'x' } });
			expect(byId.body.result).toBe('first');
			const latest = await apiJson(`/inboxes/${enc}/extract`, { method: 'POST', json: { prompt: 'x' } });
			expect(latest.body.result).toBe('second');
			expect(latest.body.message_id).toBe(second.messageId);
			const secondRow = await getMessage(env.DB, INBOX, second.messageId);
			const none = await apiJson(`/inboxes/${enc}/extract`, { method: 'POST', json: { prompt: 'x', since: secondRow!.received_at } });
			expect(none.status).toBe(404);
		} finally {
			restore();
		}
	});

	it('calls OpenAI when AI_PROVIDER=openai', async () => {
		await ingest(buildEml({ text: 'link: https://x.test/verify?t=abc' }));
		const prevProvider = (env as any).AI_PROVIDER;
		(env as any).AI_PROVIDER = 'openai';
		(env as any).OPENAI_API_KEY = 'sk-test';
		net.on('https://api.openai.com/v1/responses', () => Response.json({ output_text: JSON.stringify({ result: 'https://x.test/verify?t=abc' }) }));
		try {
			const { body } = await apiJson(`/inboxes/${enc}/extract`, { method: 'POST', json: { prompt: 'link' } });
			expect(body.provider).toBe('openai');
			expect(body.model).toBe('gpt-5-mini');
			expect(body.result).toBe('https://x.test/verify?t=abc');
			expect(net.calls).toHaveLength(1);
			expect(net.calls[0].headers.authorization).toBe('Bearer sk-test');
			const sent = JSON.parse(net.calls[0].body);
			expect(sent.text.format.type).toBe('json_schema');
			expect(sent.model).toBe('gpt-5-mini');
		} finally {
			(env as any).AI_PROVIDER = prevProvider;
			delete (env as any).OPENAI_API_KEY;
		}
	});

	it('returns 503 when openai is selected without a key', async () => {
		await ingest(buildEml({ text: 'x' }));
		const prev = (env as any).AI_PROVIDER;
		(env as any).AI_PROVIDER = 'openai';
		try {
			const { status, body } = await apiJson(`/inboxes/${enc}/extract`, { method: 'POST', json: { prompt: 'x' } });
			expect(status).toBe(503);
			expect(body.error.code).toBe('not_configured');
		} finally {
			(env as any).AI_PROVIDER = prev;
		}
	});

	it('strips HTML into the prompt when there is no text part', () => {
		const prompt = buildPrompt(
			{
				from_address: 'a@b.c',
				from_name: null,
				subject: 'S',
				received_at: 0,
				text: null,
				html: '<div><p>Click <a href="https://x.test/go">here</a></p><style>x{}</style></div>',
			} as any,
			'find link',
		);
		expect(prompt.user).toContain('https://x.test/go');
		expect(prompt.user).not.toContain('<style>');
	});
});
