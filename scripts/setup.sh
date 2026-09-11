#!/usr/bin/env bash
# Interactive first-time setup for AgentMail on your Cloudflare account.
# Safe to re-run: every step is idempotent or asks before acting.
set -euo pipefail

cd "$(dirname "$0")/.."

bold() { printf '\033[1m%s\033[0m\n' "$*"; }
step() { printf '\n\033[36m==> %s\033[0m\n' "$*"; }
ask() { local reply; read -r -p "$1 [y/N] " reply; [[ "$reply" =~ ^[Yy]$ ]]; }

command -v npx >/dev/null || { echo "npx not found. Install Node.js 20+ first."; exit 1; }

step "Checking Cloudflare login"
if ! npx wrangler whoami >/dev/null 2>&1; then
  npx wrangler login
fi

step "Email domain"
read -r -p "Domain that will receive mail for your agents (e.g. mail.example.com, must be a zone on this account): " DOMAIN
[[ -n "$DOMAIN" ]] || { echo "Domain is required."; exit 1; }
DOMAIN="${DOMAIN,,}"

if grep -q 'REPLACE_ME.example.com' wrangler.jsonc; then
  sed -i.bak "s/REPLACE_ME.example.com/${DOMAIN}/" wrangler.jsonc && rm -f wrangler.jsonc.bak
  echo "Set EMAIL_DOMAINS=${DOMAIN} in wrangler.jsonc"
else
  echo "EMAIL_DOMAINS already set in wrangler.jsonc; leaving it alone."
fi

step "D1 database"
if grep -q 'REPLACE_ME_D1_DATABASE_ID' wrangler.jsonc; then
  OUT="$(npx wrangler d1 create agentmail 2>&1 || true)"
  echo "$OUT"
  ID="$(echo "$OUT" | grep -Eo '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' | head -1 || true)"
  if [[ -z "$ID" ]]; then
    # Database may already exist; look it up.
    ID="$(npx wrangler d1 list --json 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const r=JSON.parse(s).find(d=>d.name==="agentmail");console.log(r?r.uuid:"")})')"
  fi
  [[ -n "$ID" ]] || { echo "Could not determine the D1 database id. Create it manually and paste the id into wrangler.jsonc."; exit 1; }
  sed -i.bak "s/REPLACE_ME_D1_DATABASE_ID/${ID}/" wrangler.jsonc && rm -f wrangler.jsonc.bak
  echo "Set D1 database_id=${ID}"
else
  echo "D1 database_id already set."
fi

step "R2 bucket"
npx wrangler r2 bucket create agentmail-attachments 2>&1 | grep -v "already exists" || true

step "Applying D1 migrations (remote)"
npx wrangler d1 migrations apply agentmail --remote

step "API key"
if ask "Set the API_KEY secret now? (generates a random one and prints it once)"; then
  KEY="am_$(openssl rand -hex 24 2>/dev/null || node -e 'console.log(require("crypto").randomBytes(24).toString("hex"))')"
  printf '%s' "$KEY" | npx wrangler secret put API_KEY
  bold "API_KEY: $KEY"
  echo "Store this somewhere safe; it is not retrievable later."
fi

step "Email Routing (inbound)"
npx wrangler email routing enable "$DOMAIN" || echo "(If this failed, enable Email Routing for ${DOMAIN} in the dashboard: Compute & AI > Email Service > Email Routing.)"

step "Email Sending (outbound, requires Workers Paid)"
if ask "Enable Email Sending for ${DOMAIN} so agents can reply and compose?"; then
  npx wrangler email sending enable "$DOMAIN" || echo "(Enable it later with: npx wrangler email sending enable ${DOMAIN})"
fi

step "Deploying the Worker"
npx wrangler deploy

step "Catch-all routing rule → Worker"
if ! npx wrangler email routing rules create "$DOMAIN" \
  --name "agentmail catch-all" \
  --match-type all --match-field to --match-value '*' \
  --action-type worker --action-value agentmail 2>/dev/null; then
  cat <<EOF
Could not create the catch-all rule via CLI (it may already exist, or your wrangler version differs).
Create it in the dashboard: Compute & AI > Email Service > Email Routing > ${DOMAIN} > Routing rules >
  "Catch-all address" > Action: Send to a Worker > agentmail.
EOF
fi

step "Done"
URL="$(npx wrangler deployments list 2>/dev/null | grep -Eo 'https://[^ ]+workers\.dev' | head -1 || true)"
cat <<EOF

Your AgentMail server is live${URL:+ at ${URL}}.

Try it:
  curl -H "Authorization: Bearer \$API_KEY" ${URL:-https://agentmail.<you>.workers.dev}/inboxes -X POST -d '{}'
  # then send an email to the returned address and:
  curl -H "Authorization: Bearer \$API_KEY" "${URL:-https://agentmail.<you>.workers.dev}/inboxes/<address>/messages/latest"

MCP for Claude Code:
  claude mcp add --transport http agentmail ${URL:-https://agentmail.<you>.workers.dev}/mcp --header "Authorization: Bearer \$API_KEY"
EOF
