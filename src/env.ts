/**
 * Environment + configuration.
 *
 * `Env` comes from `worker-configuration.d.ts` (run `npm run cf-typegen` after
 * editing wrangler.jsonc). Secrets are not part of the generated type, so they
 * are declared here.
 */
declare global {
	interface Env {
		/** Bearer token for the REST API and MCP endpoint. `wrangler secret put API_KEY`. */
		API_KEY?: string;
	}
}

/** The only part of ExecutionContext this codebase needs; lets Hono's narrower context type flow through. */
export type WaitUntil = { waitUntil(promise: Promise<unknown>): void };

export interface Config {
	/** Lowercased domains this deployment accepts mail for and sends from. */
	domains: string[];
	/** 0 = keep forever. */
	retentionDays: number;
	allowUnknownInbox: boolean;
	storeRaw: boolean;
	maxAttachmentBytes: number;
	defaultFromName: string;
	webhookTimeoutMs: number;
}

export class ConfigError extends Error {}

function bool(value: string | undefined, fallback: boolean): boolean {
	if (value === undefined || value === '') return fallback;
	return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
}

function int(value: string | undefined, fallback: number, min = 0): number {
	if (value === undefined || value === '') return fallback;
	const n = Number(value);
	if (!Number.isFinite(n) || n < min) throw new ConfigError(`Invalid numeric config value: ${value}`);
	return Math.floor(n);
}

export function getConfig(env: Env): Config {
	const domains = String(env.EMAIL_DOMAINS ?? '')
		.split(',')
		.map((d) => d.trim().toLowerCase())
		.filter(Boolean);
	if (domains.length === 0 || domains.some((d) => d.startsWith('replace_me'))) {
		throw new ConfigError('EMAIL_DOMAINS is not configured. Set it in wrangler.jsonc to the domain(s) you enabled Email Routing for.');
	}

	return {
		domains,
		retentionDays: int(env.RETENTION_DAYS, 30),
		allowUnknownInbox: bool(env.ALLOW_UNKNOWN_INBOX, true),
		storeRaw: bool(env.STORE_RAW, false),
		maxAttachmentBytes: int(env.MAX_ATTACHMENT_BYTES, 10 * 1024 * 1024),
		defaultFromName: String(env.DEFAULT_FROM_NAME ?? '').trim(),
		webhookTimeoutMs: int(env.WEBHOOK_TIMEOUT_MS, 10_000, 1000),
	};
}

/** Prefixed, URL-safe random identifier, e.g. `msg_3f9a…`. */
export function newId(prefix: string): string {
	return `${prefix}_${crypto.randomUUID().replace(/-/g, '')}`;
}

export function now(): number {
	return Date.now();
}
