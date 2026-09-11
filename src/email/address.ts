import type { Config } from '../env';
import type { Mailbox } from '../db/schema';

const ADDRESS_RE = /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/;

export function normalizeAddress(addr: string): string {
	return addr.trim().replace(/^<|>$/g, '').toLowerCase();
}

export function isValidAddress(addr: string): boolean {
	return ADDRESS_RE.test(normalizeAddress(addr));
}

export function domainOf(addr: string): string {
	const at = addr.lastIndexOf('@');
	return at === -1 ? '' : addr.slice(at + 1).toLowerCase();
}

export function localPartOf(addr: string): string {
	const at = addr.lastIndexOf('@');
	return at === -1 ? addr : addr.slice(0, at);
}

export function isAllowedDomain(addr: string, config: Config): boolean {
	return config.domains.includes(domainOf(normalizeAddress(addr)));
}

/**
 * Optional per-address TTL: `anything.ttl.3600@domain` expires the message after 3600 seconds.
 * Returns null when the address carries no ttl token.
 */
export function ttlSecondsFromAddress(addr: string): number | null {
	const local = localPartOf(normalizeAddress(addr));
	const match = /(?:^|[.+_-])ttl\.(\d{1,9})(?=$|[.+_-])/.exec(local);
	if (!match) return null;
	const seconds = Number(match[1]);
	return Number.isFinite(seconds) && seconds > 0 ? seconds : null;
}

/** Ensure a Message-ID carries angle brackets so lookups are consistent across inbound/outbound. */
export function normalizeMessageId(id: string | null | undefined): string | null {
	if (!id) return null;
	const trimmed = id.trim();
	if (!trimmed) return null;
	return trimmed.startsWith('<') ? trimmed : `<${trimmed.replace(/^<|>$/g, '')}>`;
}

/** Split a References header (or list) into normalized Message-IDs. */
export function parseReferences(value: string | string[] | null | undefined): string[] {
	if (!value) return [];
	const raw = Array.isArray(value) ? value.join(' ') : value;
	const ids = raw.match(/<[^<>\s]+>/g) ?? raw.split(/\s+/);
	return ids.map((v) => normalizeMessageId(v)).filter((v): v is string => Boolean(v));
}

export function stripReplyPrefixes(subject: string | null | undefined): string | null {
	if (!subject) return null;
	let s = subject.trim();
	// Strip repeated Re:/Fwd:/Fw:/AW:/WG: (and bracketed [1]) prefixes.
	for (;;) {
		const next = s.replace(/^(?:(?:re|fwd?|aw|wg|sv|vs)\s*(?:\[\d+\])?\s*:\s*)/i, '');
		if (next === s) break;
		s = next;
	}
	return s || null;
}

export function replySubject(original: string | null | undefined): string {
	const base = stripReplyPrefixes(original) ?? '';
	return base ? `Re: ${base}` : 'Re:';
}

export function forwardSubject(original: string | null | undefined): string {
	const base = stripReplyPrefixes(original) ?? '';
	return base ? `Fwd: ${base}` : 'Fwd:';
}

/** Deduplicate mailboxes by address, keeping the first name seen. */
export function uniqueMailboxes(list: Mailbox[]): Mailbox[] {
	const seen = new Map<string, Mailbox>();
	for (const m of list) {
		const key = normalizeAddress(m.address);
		if (!key || seen.has(key)) continue;
		seen.set(key, { address: key, ...(m.name ? { name: m.name } : {}) });
	}
	return [...seen.values()];
}

export function toEmailAddress(m: Mailbox): EmailAddress | string {
	return m.name ? { email: m.address, name: m.name } : m.address;
}

/** Generate a random, readable local part for implicit inbox creation. */
export function randomLocalPart(prefix = 'agent'): string {
	const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
	const bytes = crypto.getRandomValues(new Uint8Array(8));
	const suffix = Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
	return `${prefix}-${suffix}`;
}
