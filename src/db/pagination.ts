/**
 * Keyset pagination over (timestamp DESC, id DESC).
 * Cursors are opaque base64url strings so clients never depend on the shape.
 */
export interface PageCursor {
	t: number;
	id: string;
}

export interface Page<T> {
	items: T[];
	next_cursor: string | null;
}

export const DEFAULT_LIMIT = 20;
export const MAX_LIMIT = 100;

export function clampLimit(raw: string | number | undefined | null): number {
	if (raw === undefined || raw === null || raw === '') return DEFAULT_LIMIT;
	const n = Number(raw);
	if (!Number.isFinite(n) || n < 1) return DEFAULT_LIMIT;
	return Math.min(Math.floor(n), MAX_LIMIT);
}

export function encodeCursor(c: PageCursor): string {
	const json = JSON.stringify(c);
	return btoa(json).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function decodeCursor(raw: string | undefined | null): PageCursor | null {
	if (!raw) return null;
	try {
		const b64 = raw.replace(/-/g, '+').replace(/_/g, '/');
		const parsed = JSON.parse(atob(b64)) as Partial<PageCursor>;
		if (typeof parsed.t !== 'number' || typeof parsed.id !== 'string') return null;
		return { t: parsed.t, id: parsed.id };
	} catch {
		return null;
	}
}

/** Trim a `limit + 1` result set into a page with a next cursor. */
export function toPage<T>(rows: T[], limit: number, key: (row: T) => PageCursor): Page<T> {
	const hasMore = rows.length > limit;
	const items = hasMore ? rows.slice(0, limit) : rows;
	const last = items[items.length - 1];
	return {
		items,
		next_cursor: hasMore && last ? encodeCursor(key(last)) : null,
	};
}
