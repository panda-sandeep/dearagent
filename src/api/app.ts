import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { ConfigError, getConfig, type Config } from '../env';
import { ApiError } from './errors';
import { inboxRoutes } from './inboxes';
import { threadRoutes } from './threads';
import { messageRoutes } from './messages';
import { webhookRoutes } from './webhooks';
import { extractRoutes } from './extract';
import { mcpRoutes } from '../mcp/server';

export type AppEnv = {
	Bindings: Env;
	Variables: { config: Config };
};

export type AppContext = Context<AppEnv>;

function timingSafeEqual(a: string, b: string): boolean {
	const enc = new TextEncoder();
	const ab = enc.encode(a);
	const bb = enc.encode(b);
	if (ab.byteLength !== bb.byteLength) return false;
	return crypto.subtle.timingSafeEqual(ab, bb);
}

export function requireBearer(c: AppContext): void {
	const expected = c.env.API_KEY;
	if (!expected) throw ApiError.notConfigured('API_KEY secret is not set. Run: wrangler secret put API_KEY');
	const header = c.req.header('authorization') ?? '';
	const match = /^Bearer\s+(.+)$/i.exec(header.trim());
	const token = match?.[1]?.trim();
	if (!token || !timingSafeEqual(token, expected)) throw ApiError.unauthorized();
}

/** Parse a JSON body against a zod schema, mapping failures to 400. */
export async function parseBody<T extends z.ZodTypeAny>(c: AppContext, schema: T): Promise<z.infer<T>> {
	let raw: unknown;
	try {
		raw = await c.req.json();
	} catch {
		throw ApiError.badRequest('Request body must be valid JSON');
	}
	const result = schema.safeParse(raw);
	if (!result.success) throw ApiError.badRequest('Invalid request body', z.treeifyError(result.error));
	return result.data;
}

export function parseQuery<T extends z.ZodTypeAny>(c: AppContext, schema: T): z.infer<T> {
	const result = schema.safeParse(c.req.query());
	if (!result.success) throw ApiError.badRequest('Invalid query parameters', z.treeifyError(result.error));
	return result.data;
}

export function errorResponse(error: unknown): Response {
	if (error instanceof ApiError) {
		return Response.json({ error: { code: error.code, message: error.message, ...(error.details !== undefined ? { details: error.details } : {}) } }, { status: error.status });
	}
	if (error instanceof ConfigError) {
		return Response.json({ error: { code: 'not_configured', message: error.message } }, { status: 503 });
	}
	console.log({ error: 'unhandled', message: error instanceof Error ? error.message : String(error), stack: error instanceof Error ? error.stack : undefined });
	return Response.json({ error: { code: 'internal_error', message: 'Internal server error' } }, { status: 500 });
}

export function createApp() {
	const app = new Hono<AppEnv>();

	app.onError((err) => errorResponse(err));
	app.notFound((c) => c.json({ error: { code: 'not_found', message: `No route for ${c.req.method} ${new URL(c.req.url).pathname}` } }, 404));

	app.get('/', (c) =>
		c.json({
			name: 'agentmail',
			docs: 'https://github.com/sandeepvpanda/agentmail',
			endpoints: ['/health', '/auth/me', '/inboxes', '/webhooks', '/mcp'],
		}),
	);
	app.get('/health', (c) => {
		try {
			getConfig(c.env);
			return c.json({ ok: true });
		} catch (error) {
			return c.json({ ok: false, error: error instanceof Error ? error.message : String(error) }, 503);
		}
	});

	// Everything below requires configuration + auth.
	app.use('*', async (c, next) => {
		c.set('config', getConfig(c.env));
		requireBearer(c);
		await next();
	});

	app.get('/auth/me', (c) => c.json({ ok: true, domains: c.get('config').domains }));

	app.route('/', inboxRoutes());
	app.route('/', threadRoutes());
	app.route('/', messageRoutes());
	app.route('/', webhookRoutes());
	app.route('/', extractRoutes());
	app.route('/', mcpRoutes());

	return app;
}
