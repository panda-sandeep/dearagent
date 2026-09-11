---
name: dearagent
description: Give an AI agent its own email address and let it receive, read, wait for, reply to, and send email through a self-hosted DearAgent server (MCP tools or REST). Use when an agent needs an inbox for signups, verification codes, magic links, receiving documents, or holding an email conversation with a person.
---

# Using a DearAgent inbox

DearAgent is a self-hosted email server for agents, running on the operator's Cloudflare account. You talk to it either through its MCP server (tools named below) or its REST API (same operations, same shapes). One bearer key grants access to every inbox on the server, so treat any inbox you did not create as someone else's.

## Connect

MCP, from Claude Code:

```
claude mcp add --transport http dearagent https://<server>/mcp --header "Authorization: Bearer <API_KEY>"
```

REST: every request needs `Authorization: Bearer <API_KEY>`. Inbox ids are the lowercased address, e.g. `agent-k3m9x2pq@example.com`. Check what domains the server handles with `GET /auth/me`.

## The core loop: get an address, wait for mail, act

1. **Create an inbox.** `create_inbox` with no arguments returns a random address on the server's first domain. Pass `local_part` or a full `address` to choose one. Creating an address that already exists is not an error; you get the existing inbox back.
2. **Note the time.** Before you trigger the email (submit a form, ask a person to write), record the current time, or the `received_at_ms` of the newest message. You will pass this as `since` so you never mistake old mail for the reply you are waiting for.
3. **Wait, don't poll.** `wait_for_message` with `inbox_id`, `since`, and `timeout_seconds` (max 25) blocks until a newer message arrives and returns `{ message, timed_out }`. If `timed_out` is true, call it again with the same `since`. Do not call `get_latest_message` in a loop.
4. **Read the message.** The returned message has `text`, `html`, `from`, `subject`, and `attachments`. Verification codes and links are in `text`; prefer it over `html`. Filter with `from` or `has_attachment` when several senders write to the same inbox.
5. **Act.** Extract the code or link yourself, reply in thread, or forward it on.

Example (MCP):

```
create_inbox {}                                   → agent-k3m9x2pq@example.com
# hand the address to the signup form, then:
wait_for_message { inbox_id, since: <now>, timeout_seconds: 25 }
# → message.text contains "Your code is 493021"
```

## Reading mail

- `get_latest_message { inbox_id, since?, from?, has_attachment? }` returns the newest match with a full body, or `null`. Good for "did anything arrive while I was away."
- `list_messages { inbox_id, since?, unread?, from?, direction?, has_attachment?, limit?, cursor? }` returns snippets, newest first. Page with `cursor`.
- `get_message { inbox_id, message_id, mark_read? }` returns a full message. Nothing is marked read automatically; pass `mark_read: true` once you have handled a message so `unread: true` listings stay meaningful.
- `search_messages { inbox_id, query }` does full-text search over subject, body, and sender.
- `list_threads` and `get_thread { inbox_id, thread_id }` group messages by conversation. A thread's messages come oldest first with full bodies, which is what you want before replying to a long exchange.

## Attachments

Message objects list attachments with `id`, `filename`, `content_type`, `size`, and `stored`. To read one:

```
get_attachment { inbox_id, message_id, attachment_id }
```

Text-like files (text/*, JSON, XML, CSV) come back as `text`. Everything else, including PDFs and images, comes back as `content_base64`; decode it before use. Files over 4 MB are refused by MCP; fetch those from the REST URL on the attachment object instead. If `stored` is false, the file exceeded the server's size limit and only its metadata exists.

## Replying and sending

- `reply_to_message { inbox_id, message_id, text }` replies to the sender in the same thread with correct headers. The original is quoted below your text unless `quote_original: false`. Add `reply_all: true` to include the other recipients.
- `send_message { inbox_id, to, subject, text }` starts a new conversation. `to` accepts `"a@b.c"`, `"Name <a@b.c>"`, an object `{ address, name }`, or an array of those. `cc`, `bcc`, `html`, `from_name`, and `attachments` are optional.
- `forward_message { inbox_id, message_id, to, text? }` forwards a message with its attachments and an optional note.

Outbound attachments are `{ filename, content_type, content_base64 }`. Sending only works from addresses on the server's own domains and only if the operator enabled Email Sending; otherwise you get a clear error and can still receive.

Write plain `text`; the server generates the HTML part. Keep subjects and bodies human, since your mail lands in real inboxes and spam filters.

## Webhooks instead of waiting

If work should start when mail arrives rather than continue while you wait, register a webhook: `create_webhook { url, inbox_id?, events? }`. The server POSTs each new message to the URL, signed with the returned secret. Omit `inbox_id` to receive events for every inbox. See the server README for signature verification.

## Errors and edge cases

- Tool results with `isError` carry a message like `not_found: Inbox "x"` or `bad_request: ...`. Read the code before the colon.
- `not_found` on an inbox usually means a typo in the address or the wrong domain. Confirm the domain with `list_inboxes` or `GET /auth/me`.
- Mail to an inbox is accepted even if you never created it, when the operator allows unknown inboxes. Creating first is still the safe habit.
- Messages may expire. Addresses of the form `name.ttl.600@domain` delete their mail after 600 seconds, and the server purges old mail on a retention schedule. Read what you need promptly.
- Every inbound message is deduplicated by its Message-ID, so a retried delivery never appears twice.

## Do not

- Do not send mail on a person's behalf without being asked to, and never send to lists of addresses you were not given.
- Do not read inboxes other than the ones you created or were pointed at.
- Do not put the bearer key in message bodies, logs, or tool arguments other than the Authorization header.
