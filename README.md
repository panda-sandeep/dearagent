# DearAgent

Self-hosted email inboxes for AI agents, running entirely on your Cloudflare account.

Give every agent its own address. Receive mail, read it over a REST API or MCP, reply in-thread, send new mail, and get webhooks when something arrives. One Worker, one repo, no servers.

```
Inbound   *@mail.example.com ──► Email Routing ──► Worker email() ──► D1 (+ R2 for attachments) ──► webhooks
Outbound  POST /inboxes/:id/messages(/…/reply) ──► Worker ──► Cloudflare Email Sending
Agents    REST (Bearer key)  ·  MCP at /mcp
```

Inspired by [agentmail.to](https://www.agentmail.to/); built so you can run the same idea yourself for the cost of a Workers plan.

## Features

- **Catch-all inboxes.** Any address at your domain works immediately. Inboxes are created implicitly on first email or explicitly via `POST /inboxes` (with a random address if you want one).
- **Threads.** Messages are grouped by `In-Reply-To` / `References`, never by subject, so automated mail does not get merged.
- **Full-text search** (SQLite FTS5) over subject, body and sender.
- **Attachments** stored in R2 and served back with the right content type. Inline images are distinguished from real attachments.
- **Send, reply, reply-all, forward** with correct threading headers, via the native Email Sending binding.
- **Webhooks** on `message.received` and `message.sent`, HMAC-signed, retried, with a per-webhook delivery log.
- **MCP server** at `/mcp` so Claude Code, Cursor, or any MCP client can use an inbox as a tool, including `wait_for_message` to block until mail arrives.
- **Retention.** Daily purge after `RETENTION_DAYS`, plus per-address TTLs (`signup.ttl.600@…` expires after 600 s).

## Quick start

Prerequisites: a Cloudflare account with a zone you can use for email (e.g. `mail.example.com` as a subdomain zone or a dedicated domain), Node 20+, and `npx wrangler login` done.

```bash
git clone https://github.com/<you>/dearagent && cd dearagent
npm install
npm run setup          # interactive: D1, R2, secrets, Email Routing/Sending, deploy, catch-all rule
```

Or by hand:

```bash
cp wrangler.example.jsonc wrangler.jsonc               # wrangler.jsonc is git-ignored; it holds your values
npx wrangler d1 create dearagent                       # paste database_id into wrangler.jsonc
npx wrangler r2 bucket create dearagent-attachments
# edit wrangler.jsonc: set EMAIL_DOMAINS to "example.com" and addresses to ["*@example.com"]
npx wrangler d1 migrations apply dearagent --remote
npx wrangler secret put API_KEY                        # any long random string
npx wrangler email routing enable example.com
npx wrangler email sending enable example.com          # only needed to send/reply; Workers Paid
npx wrangler deploy                                    # also creates the catch-all routing rule from `addresses`
```

The `addresses` entry in `wrangler.jsonc` declares the Email Routing rules this Worker owns; `*@example.com` is the catch-all. `wrangler deploy` prints an "Email Routing plan" and applies it, so no separate rule command is needed. If your wrangler is older than 4.131 and ignores `addresses`, set the catch-all in the dashboard: **Compute & AI → Email Service → Email Routing → your domain → Routing rules → Catch-all → Send to a Worker → dearagent**.

### Which domains work

Email Routing is configured on the **apex zone** and must own its MX records. That gives two hard rules:

- **A domain that already receives mail elsewhere (Google Workspace, Fastmail, …) cannot be used, and neither can its subdomains.** Cloudflare refuses to onboard the apex ("Non-Cloudflare MX records exist"), and subdomain routing is configured under the onboarded apex. Use a domain you can dedicate to Cloudflare Email Routing instead: one that receives no mail today, or a new one.
- **Subdomains of a dedicated zone do work**, but only after the apex is onboarded. In the dashboard: onboard the apex under **Email Service → Email Routing**, then **Settings → Subdomains → Add subdomain**, then create the subdomain's **Catch-all** rule pointing at the `dearagent` Worker. Wrangler cannot do this; `npm run setup` detects the case and prints the steps.

Email Sending has neither restriction: `wrangler email sending enable mail.example.com` works on any subdomain, so you can send from a subdomain of a domain that receives mail elsewhere. You just cannot receive there.

Then:

```bash
export AM=https://dearagent.<your-subdomain>.workers.dev
export KEY=<your API_KEY>

# 1. get an address
curl -s -X POST $AM/inboxes -H "Authorization: Bearer $KEY" -d '{}'
# → { "id": "agent-k3m9x2pq@mail.example.com", ... }

# 2. send an email to it, then read it
curl -s "$AM/inboxes/agent-k3m9x2pq@mail.example.com/messages/latest" -H "Authorization: Bearer $KEY"
```

## Configuration

Everything lives in `wrangler.jsonc`, which is git-ignored and generated from `wrangler.example.jsonc` by `npm run setup` (or `cp` it yourself). The template is the committed source of truth; put new settings there. Secrets are set with `wrangler secret put`.

| Setting | Default | What it does |
|---|---|---|
| `EMAIL_DOMAINS` | required | Comma-separated domains this deployment accepts mail for and sends from. Mail to other domains is rejected at SMTP time. |
| `ALLOW_UNKNOWN_INBOX` | `true` | Accept mail for any address and create the inbox on the fly. Set `false` to reject addresses not created via `POST /inboxes`. |
| `RETENTION_DAYS` | `30` | Purge messages older than this. `0` keeps them forever. Per-address `ttl.<seconds>` still applies. |
| `STORE_RAW` | `false` | Keep the raw MIME in R2 so `GET …/messages/:id/raw` works. |
| `MAX_ATTACHMENT_BYTES` | `10485760` | Larger attachments keep metadata only (`stored: false`). |
| `DEFAULT_FROM_NAME` | `""` | Display name on outbound mail when the request or inbox has none. |
| `WEBHOOK_TIMEOUT_MS` | `10000` | Per-attempt webhook timeout. |
| secret `API_KEY` | required | Bearer token for the API and MCP. |

Bindings (`DB`, `ATTACHMENTS`, `EMAIL`) and the daily cron are pre-declared. To serve the API on your own hostname, uncomment `routes` in `wrangler.jsonc`.

## API

All endpoints except `GET /health` require `Authorization: Bearer <API_KEY>`. Bodies and responses are JSON. Errors look like `{ "error": { "code": "not_found", "message": "Inbox not found" } }`.

Inbox ids are the lowercased address, so URL-encode the `@` if your client insists (`agent%40mail.example.com` works too).

### Inboxes

| Method | Path | Notes |
|---|---|---|
| `GET` | `/inboxes?limit=&cursor=` | Newest first. |
| `POST` | `/inboxes` | `{ address? \| local_part? + domain?, display_name?, metadata? }`. Empty body gives a random address. `201` on create, `200` if it existed. |
| `GET` | `/inboxes/:inbox` | |
| `PATCH` | `/inboxes/:inbox` | `display_name`, `metadata`. |
| `DELETE` | `/inboxes/:inbox` | Removes all threads, messages, attachments, and inbox webhooks. |

### Messages

| Method | Path | Notes |
|---|---|---|
| `GET` | `/inboxes/:inbox/messages` | Filters: `since`, `before` (epoch ms, epoch s, or ISO), `unread`, `has_attachment`, `direction`, `thread_id`, `from`, `label`. Returns snippets; add `include_body=true` for text/html. Paginate with `limit` + `cursor`. |
| `GET` | `/inboxes/:inbox/messages/latest?since=` | Newest match with full body, or `404`. The polling primitive: pass the `received_at_ms` of the last message you saw. |
| `GET` | `/inboxes/:inbox/messages/wait?since=&timeout=25` | Long-polls up to 25 s for a message newer than `since` (default: now). Returns `{ message, timed_out }`. |
| `GET` | `/inboxes/:inbox/messages/search?q=` | FTS over subject, body, sender. |
| `GET` | `/inboxes/:inbox/messages/:id` | Full message. |
| `PATCH` | `/inboxes/:inbox/messages/:id` | `{ read?, labels? }`. |
| `DELETE` | `/inboxes/:inbox/messages/:id` | Also deletes attachments; prunes the thread if empty. |
| `GET` | `/inboxes/:inbox/messages/:id/raw` | `message/rfc822`, requires `STORE_RAW=true`. |
| `GET` | `/inboxes/:inbox/messages/:id/attachments/:attId` | Streams the file. |
| `POST` | `/inboxes/:inbox/messages` | Compose. `{ to, cc?, bcc?, subject, text?, html?, from_name?, reply_to?, headers?, attachments?, labels? }`. Recipients may be `"a@b.c"`, `"Name <a@b.c>"`, or `{ address, name }`. |
| `POST` | `/inboxes/:inbox/messages/:id/reply` | `{ text?, html?, subject?, cc?, bcc?, attachments?, quote_original? }`. Sets `In-Reply-To`/`References`, honours `Reply-To`. The original is quoted below the body unless `quote_original: false`. |
| `POST` | `/inboxes/:inbox/messages/:id/reply-all` | Same, plus the other original recipients on cc. |
| `POST` | `/inboxes/:inbox/messages/:id/forward` | `{ to, text?, html?, include_attachments? }`. Quotes the original; starts a new thread. |

Outbound attachments are `{ filename, content_type, content_base64, disposition?, content_id? }`.

Every outbound message is sent as multipart/alternative: when only `text` is given an HTML part is generated from it, and when only `html` is given a text part is derived. Replies and forwards quote the original message the way mail clients do, which keeps them out of spam filters and readable for humans.

A message looks like:

```json
{
  "id": "msg_…", "inbox_id": "agent@mail.example.com", "thread_id": "thr_…",
  "direction": "inbound", "message_id": "<…>", "in_reply_to": null, "references": [],
  "from": { "address": "alice@example.org", "name": "Alice" },
  "to": [{ "address": "agent@mail.example.com" }], "cc": [], "bcc": [], "reply_to": null,
  "subject": "Your code", "snippet": "Your code is 493021…", "text": "…", "html": "…",
  "attachments": [{ "id": "att_…", "filename": "report.csv", "content_type": "text/csv", "size": 1234, "disposition": "attachment", "stored": true, "url": "/inboxes/…/attachments/att_…" }],
  "has_attachments": true, "labels": [], "read": false, "size_bytes": 4096,
  "received_at": "2026-09-11T07:30:00.000Z", "received_at_ms": 1789111800000, "expires_at": null
}
```

### Threads

| Method | Path |
|---|---|
| `GET` | `/inboxes/:inbox/threads?limit=&cursor=` |
| `GET` | `/inboxes/:inbox/threads/:id` (includes `messages[]`, oldest first, full bodies) |
| `DELETE` | `/inboxes/:inbox/threads/:id` |

### Webhooks

| Method | Path | Notes |
|---|---|---|
| `GET` | `/webhooks?scope=global` | All webhooks, or only global ones. |
| `POST` | `/webhooks` | `{ url, events?, secret?, enabled?, inbox_id? }`. Without `inbox_id` it fires for every inbox. The `secret` is returned only here (or with `?include_secret=true`). |
| `GET` `PATCH` `DELETE` | `/webhooks/:id` | |
| `GET` | `/webhooks/:id/deliveries` | Last 50 attempts with status and error. |
| `GET` `POST` | `/inboxes/:inbox/webhooks` | Inbox-scoped. |

Events: `message.received`, `message.sent`. Payload:

```json
{ "id": "evt_…", "type": "message.received", "created_at": "…", "inbox_id": "…", "thread_id": "…",
  "message": { …same shape as above…, "body_truncated": false } }
```

Bodies over 32 KB are omitted and `body_truncated` is set; fetch the message by id. Headers: `X-DearAgent-Event`, `X-DearAgent-Delivery`, `X-DearAgent-Timestamp` (unix seconds), `X-DearAgent-Signature: sha256=<hex>`. Verify with:

```js
const expected = 'sha256=' + hmacSha256Hex(secret, `${timestamp}.${rawBody}`);
```

Deliveries retry three times (0 s, 1 s, 4 s) on network errors and 5xx/408/429; other 4xx are not retried.

### Other

`GET /health` (no auth) reports whether the deployment is configured. `GET /auth/me` validates a key and returns the configured domains.

## MCP

The Worker exposes a stateless Streamable HTTP MCP server at `/mcp`, protected by the same bearer key.

```bash
claude mcp add --transport http dearagent https://dearagent.<you>.workers.dev/mcp \
  --header "Authorization: Bearer $KEY"
```

Tools: `list_inboxes`, `create_inbox`, `list_threads`, `get_thread`, `list_messages`, `get_message`, `get_attachment`, `get_latest_message`, `wait_for_message`, `search_messages`, `send_message`, `reply_to_message`, `forward_message`, `list_webhooks`, `create_webhook`.

A typical agent flow: `create_inbox` → hand the address to a signup form → `wait_for_message` → read the verification link out of the returned message body.

## Local development

```bash
cp .dev.vars.example .dev.vars            # set API_KEY
npm run db:migrate:local
npx wrangler dev --var EMAIL_DOMAINS:mail.example.com
```

Deliver a test email to the local `email()` handler:

```bash
curl -X POST 'http://localhost:8787/cdn-cgi/handler/email?from=alice@example.org&to=agent@mail.example.com' \
  -H 'Content-Type: message/rfc822' --data-binary @test/fixtures/sample.eml
curl -H 'Authorization: Bearer dev-key' 'http://localhost:8787/inboxes/agent@mail.example.com/messages/latest'
```

Sending from `wrangler dev` needs `"remote": true` on the `send_email` binding (see the comment in `wrangler.jsonc`); it will send real mail. Binary attachments do not work through the remote proxy, deploy to test those.

Tests run inside the Workers runtime with real D1 and R2 emulation:

```bash
npm test
npm run typecheck
```

## Limits and gotchas

- **Receiving works on the free plan; sending needs Workers Paid.** Before a domain is onboarded for Email Sending you can only send to addresses verified on your account.
- Email Sending: 50 recipients per message, 5 MiB per message (25 MiB to verified destinations), 16 KB of custom headers. Inbound: 25 MiB.
- New accounts start with conservative daily send quotas that grow with reputation.
- Inbound mail is stored with `read: false`. Nothing marks messages read automatically except `get_message` with `mark_read: true` or `PATCH`.
- The catch-all rule sends *every* address at the domain to the Worker. Use `ALLOW_UNKNOWN_INBOX=false` if you want to reject unknown addresses at SMTP time.
- One API key, full access. This is a single-tenant tool; put it behind your own auth if you need per-agent scoping.

## How it maps to the code

```
src/index.ts          fetch / email / scheduled entry points
src/env.ts            config parsing (Config), secrets typing
src/email/receive.ts  email() handler → ingestEmail(): parse, dedupe, thread, store, webhook
src/email/send.ts     compose / reply / forward via env.EMAIL.send()
src/email/threading.ts, address.ts
src/db/*              thin D1 modules per table + keyset pagination
src/api/*             Hono routes, zod schemas, serializers, error mapping
src/mcp/server.ts     MCP tools (wrap the same functions the REST layer uses)
src/webhooks/deliver.ts  HMAC signing, retries, delivery log
src/cron.ts           retention purge
migrations/           D1 schema
```

## Contributing

Pull requests are welcome. By submitting a contribution you agree to the [Contributor License Agreement](CLA.md), which lets the project also be offered under licenses other than the AGPL.

## License

Copyright (c) 2026 Sandeep Panda.

[GNU Affero General Public License v3.0](LICENSE). You can self-host, modify and redistribute DearAgent freely. If you run a modified version as a network service, you must make your modified source available to its users under the same license.
