import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { buildEml, ingest, DOMAIN } from './helpers';
import { getMessage, listThreadMessages } from '../src/db/messages';
import { getInbox } from '../src/db/inboxes';
import { getThread } from '../src/db/threads';
import { listAttachments } from '../src/db/attachments';

describe('ingestEmail', () => {
	it('stores a plain-text email and auto-creates the inbox', async () => {
		const result = await ingest(buildEml({ subject: 'Welcome', text: 'Hi there' }));
		expect(result.status).toBe('stored');
		expect(result.inboxId).toBe(`agent@${DOMAIN}`);

		const inbox = await getInbox(env.DB, `agent@${DOMAIN}`);
		expect(inbox?.address).toBe(`agent@${DOMAIN}`);

		const row = await getMessage(env.DB, result.inboxId, result.messageId);
		expect(row?.subject).toBe('Welcome');
		expect(row?.text?.trim()).toBe('Hi there');
		expect(row?.from_address).toBe('alice@sender.test');
		expect(row?.from_name).toBe('Alice');
		expect(row?.direction).toBe('inbound');
		expect(row?.message_id_header).toMatch(/^<.+>$/);
		expect(row?.raw_r2_key).toBeTruthy(); // STORE_RAW=true in tests

		const thread = await getThread(env.DB, result.inboxId, result.threadId);
		expect(thread?.message_count).toBe(1);
		expect(thread?.subject).toBe('Welcome');
		expect(JSON.parse(thread!.participants)).toEqual(expect.arrayContaining(['alice@sender.test', `agent@${DOMAIN}`]));
	});

	it('is idempotent on Message-ID', async () => {
		const eml = buildEml({ messageId: '<dup-1@sender.test>' });
		const first = await ingest(eml);
		const second = await ingest(eml);
		expect(first.status).toBe('stored');
		expect(second.status).toBe('duplicate');
		expect(second.messageId).toBe(first.messageId);
	});

	it('lowercases the recipient into the inbox id', async () => {
		const result = await ingest(buildEml({ to: `Mixed.Case@${DOMAIN}` }), `Mixed.Case@${DOMAIN}`);
		expect(result.inboxId).toBe(`mixed.case@${DOMAIN}`);
	});

	it('threads replies via In-Reply-To and References', async () => {
		const root = await ingest(buildEml({ messageId: '<root@sender.test>', subject: 'Deal' }));
		const reply = await ingest(buildEml({ messageId: '<r1@sender.test>', subject: 'Re: Deal', inReplyTo: '<root@sender.test>' }));
		// Third message references only the root, not the immediate parent.
		const grand = await ingest(buildEml({ messageId: '<r2@sender.test>', subject: 'RE: Re: Deal', references: '<root@sender.test>' }));
		expect(reply.threadId).toBe(root.threadId);
		expect(grand.threadId).toBe(root.threadId);

		const thread = await getThread(env.DB, root.inboxId, root.threadId);
		expect(thread?.message_count).toBe(3);
		expect(thread?.subject).toBe('Deal');
		const messages = await listThreadMessages(env.DB, root.threadId);
		expect(messages.map((m) => m.message_id_header)).toEqual(['<root@sender.test>', '<r1@sender.test>', '<r2@sender.test>']);
	});

	it('does not merge threads by subject alone', async () => {
		const a = await ingest(buildEml({ subject: 'Your code' }));
		const b = await ingest(buildEml({ subject: 'Your code' }));
		expect(a.threadId).not.toBe(b.threadId);
	});

	it('stores attachments in R2 and records inline vs attachment disposition', async () => {
		const result = await ingest(
			buildEml({
				html: '<p>See <img src="cid:logo"> attached</p>',
				attachments: [
					{ filename: 'report.csv', contentType: 'text/csv', content: 'a,b\n1,2\n' },
					{ filename: 'logo.png', contentType: 'image/png', content: 'PNGDATA', inline: true, contentId: 'logo' },
				],
			}),
		);
		const row = await getMessage(env.DB, result.inboxId, result.messageId);
		expect(row?.has_attachments).toBe(1);
		expect(row?.html).toContain('cid:logo');

		const atts = await listAttachments(env.DB, result.messageId);
		expect(atts).toHaveLength(2);
		const csv = atts.find((a) => a.filename === 'report.csv')!;
		expect(csv.disposition).toBe('attachment');
		expect(csv.size).toBe('a,b\n1,2\n'.length);
		const obj = await env.ATTACHMENTS.get(csv.r2_key!);
		expect(await obj?.text()).toBe('a,b\n1,2\n');

		const logo = atts.find((a) => a.filename === 'logo.png')!;
		expect(logo.disposition).toBe('inline');
		expect(logo.content_id).toBe('logo');
	});

	it('only counts real attachments toward has_attachments (inline images excluded)', async () => {
		const result = await ingest(
			buildEml({
				html: '<img src="cid:sig">',
				attachments: [{ filename: 'sig.png', contentType: 'image/png', content: 'x', inline: true, contentId: 'sig' }],
			}),
		);
		const row = await getMessage(env.DB, result.inboxId, result.messageId);
		expect(row?.has_attachments).toBe(0);
	});

	it('honours ttl.<seconds> in the address as expires_at', async () => {
		const to = `signup.ttl.600@${DOMAIN}`;
		const before = Date.now();
		const result = await ingest(buildEml({ to }), to);
		const row = await getMessage(env.DB, result.inboxId, result.messageId);
		expect(row?.expires_at).toBeGreaterThanOrEqual(before + 600_000);
		expect(row?.expires_at).toBeLessThan(before + 600_000 + 10_000);
	});

	it('falls back to the envelope sender when From is missing', async () => {
		const eml = ['To: agent@mail.example.com', 'Subject: no from', 'Message-ID: <nofrom@x>', '', 'body', ''].join('\r\n');
		const result = await ingest(eml, `agent@${DOMAIN}`, 'bounce@relay.test');
		const row = await getMessage(env.DB, result.inboxId, result.messageId);
		expect(row?.from_address).toBe('bounce@relay.test');
	});
});
