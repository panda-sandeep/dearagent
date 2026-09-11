import { findThreadByMessageIds } from '../db/messages';
import { newThreadId } from '../db/threads';
import { normalizeMessageId, parseReferences } from './address';

export interface ThreadResolution {
	threadId: string;
	isNew: boolean;
}

/**
 * Decide which thread a message belongs to.
 * Order: In-Reply-To, then every id in References (most recent first). Falls back to a new thread.
 * Subject-based matching is intentionally not used: it merges unrelated automated emails.
 */
export async function resolveThread(
	db: D1Database,
	inboxId: string,
	headers: { inReplyTo?: string | null; references?: string | string[] | null },
): Promise<ThreadResolution> {
	const candidates: string[] = [];
	const inReplyTo = normalizeMessageId(headers.inReplyTo);
	if (inReplyTo) candidates.push(inReplyTo);
	for (const ref of parseReferences(headers.references).reverse()) {
		if (!candidates.includes(ref)) candidates.push(ref);
	}
	const existing = await findThreadByMessageIds(db, inboxId, candidates);
	if (existing) return { threadId: existing, isNew: false };
	return { threadId: newThreadId(), isNew: true };
}
