import { describe, expect, it } from 'vitest';
import { normalizeMessageId, parseReferences, replySubject, stripReplyPrefixes, ttlSecondsFromAddress, forwardSubject } from '../src/email/address';
import { toFtsQuery, makeSnippet } from '../src/db/messages';
import { decodeCursor, encodeCursor } from '../src/db/pagination';
import { parseSince, mailboxSchema } from '../src/api/schemas';

describe('address helpers', () => {
	it('normalizes Message-IDs to include angle brackets', () => {
		expect(normalizeMessageId('abc@x')).toBe('<abc@x>');
		expect(normalizeMessageId('<abc@x>')).toBe('<abc@x>');
		expect(normalizeMessageId('  ')).toBeNull();
		expect(normalizeMessageId(null)).toBeNull();
	});

	it('parses References headers', () => {
		expect(parseReferences('<a@x> <b@x>\r\n <c@x>')).toEqual(['<a@x>', '<b@x>', '<c@x>']);
		expect(parseReferences(['<a@x>', '<b@x>'])).toEqual(['<a@x>', '<b@x>']);
		expect(parseReferences(null)).toEqual([]);
	});

	it('strips reply/forward prefixes', () => {
		expect(stripReplyPrefixes('Re: RE: Fwd: Hello')).toBe('Hello');
		expect(stripReplyPrefixes('Re[2]: Hello')).toBe('Hello');
		expect(stripReplyPrefixes('Hello')).toBe('Hello');
		expect(stripReplyPrefixes('')).toBeNull();
		expect(replySubject('Re: Hello')).toBe('Re: Hello');
		expect(replySubject(null)).toBe('Re:');
		expect(forwardSubject('Re: Hello')).toBe('Fwd: Hello');
	});

	it('extracts ttl tokens', () => {
		expect(ttlSecondsFromAddress('x.ttl.3600@d.com')).toBe(3600);
		expect(ttlSecondsFromAddress('ttl.60@d.com')).toBe(60);
		expect(ttlSecondsFromAddress('battle.ship@d.com')).toBeNull();
		expect(ttlSecondsFromAddress('x.ttl.0@d.com')).toBeNull();
	});
});

describe('misc helpers', () => {
	it('quotes FTS tokens', () => {
		expect(toFtsQuery('verify your "account" NOW')).toBe('"verify" "your" "account" "NOW"');
		expect(toFtsQuery('   ')).toBe('');
	});

	it('builds snippets from html when text is absent', () => {
		expect(makeSnippet(null, '<style>p{}</style><p>Hello <b>world</b></p>')).toBe('Hello world');
		expect(makeSnippet('x'.repeat(300), null)!.length).toBe(201);
	});

	it('round-trips cursors and rejects garbage', () => {
		const c = { t: 1700000000000, id: 'msg_abc' };
		expect(decodeCursor(encodeCursor(c))).toEqual(c);
		expect(decodeCursor('not-a-cursor')).toBeNull();
	});

	it('parses since as ms, seconds, or ISO', () => {
		expect(parseSince(1700000000000)).toBe(1700000000000);
		expect(parseSince('1700000000')).toBe(1700000000000);
		expect(parseSince('2024-01-01T00:00:00Z')).toBe(Date.parse('2024-01-01T00:00:00Z'));
		expect(parseSince(undefined)).toBeUndefined();
		expect(() => parseSince('yesterday')).toThrow();
	});

	it('accepts mailbox strings and objects', () => {
		expect(mailboxSchema.parse('Bob <BOB@x.com>')).toEqual({ address: 'bob@x.com', name: 'Bob' });
		expect(mailboxSchema.parse('bob@x.com')).toEqual({ address: 'bob@x.com' });
		expect(mailboxSchema.parse({ address: 'Bob@x.com', name: 'B' })).toEqual({ address: 'bob@x.com', name: 'B' });
	});
});
