/**
 * AgentMail — email inboxes for AI agents, on Cloudflare Workers.
 *
 *   email()      inbound mail via Email Routing (catch-all → this Worker)
 *   fetch()      REST API + MCP endpoint (/mcp), Bearer-authenticated
 *   scheduled()  daily retention purge
 */
import { createApp } from './api/app';
import { handleEmail } from './email/receive';
import { runRetention } from './cron';

const app = createApp();

export default {
	fetch: (request, env, ctx) => app.fetch(request, env, ctx),
	email: handleEmail,
	scheduled: async (_controller, env, ctx) => {
		ctx.waitUntil(runRetention(env));
	},
} satisfies ExportedHandler<Env>;
