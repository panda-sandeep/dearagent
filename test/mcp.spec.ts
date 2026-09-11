import { describe, expect, it } from 'vitest';
import { api, buildEml, ingest, DOMAIN } from './helpers';

const INBOX = `agent@${DOMAIN}`;

/** Minimal JSON-RPC client against /mcp (Streamable HTTP). */
async function rpc(method: string, params: unknown = {}, id = 1) {
	const res = await api('/mcp', {
		method: 'POST',
		headers: { Accept: 'application/json, text/event-stream' },
		json: { jsonrpc: '2.0', id, method, params },
	});
	const text = await res.text();
	// Streamable HTTP may answer as JSON or as an SSE stream with a single `data:` frame.
	const jsonText = res.headers.get('content-type')?.includes('text/event-stream')
		? text
				.split('\n')
				.filter((l) => l.startsWith('data:'))
				.map((l) => l.slice(5).trim())
				.join('')
		: text;
	return { status: res.status, body: JSON.parse(jsonText) };
}

describe('mcp endpoint', () => {
	it('rejects unauthenticated requests', async () => {
		const res = await api('/mcp', { method: 'POST', auth: false, json: { jsonrpc: '2.0', id: 1, method: 'ping' } });
		expect(res.status).toBe(401);
	});

	it('initializes and lists tools', async () => {
		const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } });
		expect(init.status).toBe(200);
		expect(init.body.result.serverInfo.name).toBe('dearagent');

		const tools = await rpc('tools/list', {}, 2);
		const names = tools.body.result.tools.map((t: any) => t.name).sort();
		expect(names).toEqual(
			[
				'create_inbox',
				'create_webhook',
				'forward_message',
				'get_attachment',
				'get_latest_message',
				'get_message',
				'get_thread',
				'list_inboxes',
				'list_messages',
				'list_threads',
				'list_webhooks',
				'reply_to_message',
				'search_messages',
				'send_message',
				'wait_for_message',
			].sort(),
		);
		const create = tools.body.result.tools.find((t: any) => t.name === 'create_inbox');
		expect(create.inputSchema.properties.address).toBeDefined();
	});

	it('calls tools end to end', async () => {
		const r = await ingest(buildEml({ subject: 'MCP hello', text: 'from mcp test' }));

		const created = await rpc('tools/call', { name: 'create_inbox', arguments: {} }, 3);
		const inbox = JSON.parse(created.body.result.content[0].text);
		expect(inbox.created).toBe(true);
		expect(inbox.inbox.address).toMatch(new RegExp(`@${DOMAIN.replace('.', '\\.')}$`));

		const latest = await rpc('tools/call', { name: 'get_latest_message', arguments: { inbox_id: INBOX } }, 4);
		const message = JSON.parse(latest.body.result.content[0].text);
		expect(message.id).toBe(r.messageId);
		expect(message.text.trim()).toBe('from mcp test');

		const missing = await rpc('tools/call', { name: 'get_message', arguments: { inbox_id: INBOX, message_id: 'msg_nope' } }, 5);
		expect(missing.body.result.isError).toBe(true);
		expect(missing.body.result.content[0].text).toContain('not_found');

		const search = await rpc('tools/call', { name: 'search_messages', arguments: { inbox_id: INBOX, query: 'hello' } }, 6);
		expect(JSON.parse(search.body.result.content[0].text).messages).toHaveLength(1);
	});

	it('get_attachment returns text for text-like files and base64 otherwise', async () => {
		const r = await ingest(
			buildEml({
				subject: 'with files',
				attachments: [
					{ filename: 'report.csv', contentType: 'text/csv', content: 'a,b\n1,2\n' },
					{ filename: 'blob.bin', contentType: 'application/octet-stream', content: 'BINARY' },
				],
			}),
		);
		const msg = await rpc('tools/call', { name: 'get_message', arguments: { inbox_id: INBOX, message_id: r.messageId } }, 7);
		const atts = JSON.parse(msg.body.result.content[0].text).attachments;
		const csv = atts.find((a: any) => a.filename === 'report.csv');
		const bin = atts.find((a: any) => a.filename === 'blob.bin');

		const text = await rpc('tools/call', { name: 'get_attachment', arguments: { inbox_id: INBOX, message_id: r.messageId, attachment_id: csv.id } }, 8);
		const textBody = JSON.parse(text.body.result.content[0].text);
		expect(textBody.encoding).toBe('text');
		expect(textBody.text).toBe('a,b\n1,2\n');
		expect(textBody.content_type).toBe('text/csv');

		const raw = await rpc('tools/call', { name: 'get_attachment', arguments: { inbox_id: INBOX, message_id: r.messageId, attachment_id: bin.id } }, 9);
		const rawBody = JSON.parse(raw.body.result.content[0].text);
		expect(rawBody.encoding).toBe('base64');
		expect(atob(rawBody.content_base64)).toBe('BINARY');

		const forced = await rpc('tools/call', { name: 'get_attachment', arguments: { inbox_id: INBOX, message_id: r.messageId, attachment_id: csv.id, encoding: 'base64' } }, 10);
		expect(JSON.parse(forced.body.result.content[0].text).encoding).toBe('base64');

		const tooBig = await rpc('tools/call', { name: 'get_attachment', arguments: { inbox_id: INBOX, message_id: r.messageId, attachment_id: bin.id, max_bytes: 2 } }, 11);
		expect(tooBig.body.result.isError).toBe(true);
		expect(tooBig.body.result.content[0].text).toContain('too_large');

		const missing = await rpc('tools/call', { name: 'get_attachment', arguments: { inbox_id: INBOX, message_id: r.messageId, attachment_id: 'att_nope' } }, 12);
		expect(missing.body.result.isError).toBe(true);
		expect(missing.body.result.content[0].text).toContain('not_found');
	});
});
