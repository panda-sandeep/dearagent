#!/usr/bin/env bash
# Interactive first-time setup for DearAgent on your Cloudflare account.
# Safe to re-run: every step is idempotent or asks before acting.
set -euo pipefail

cd "$(dirname "$0")/.."

# wrangler.jsonc is git-ignored and generated from the committed template.
if [[ ! -f wrangler.jsonc ]]; then
  cp wrangler.example.jsonc wrangler.jsonc
  echo "Created wrangler.jsonc from wrangler.example.jsonc"
fi

bold() { printf '\033[1m%s\033[0m\n' "$*"; }
step() { printf '\n\033[36m==> %s\033[0m\n' "$*"; }
ask() { local reply; read -r -p "$1 [y/N] " reply; [[ "$reply" =~ ^[Yy]$ ]]; }

command -v npx >/dev/null || { echo "npx not found. Install Node.js 20+ first."; exit 1; }

step "Checking Cloudflare login"
WHOAMI="$(npx wrangler whoami 2>&1 || true)"
if echo "$WHOAMI" | grep -qi "not authenticated"; then
  npx wrangler login
elif echo "$WHOAMI" | grep -qi "account name"; then
  echo "$WHOAMI" | grep -iE "logged in|Account Name|│" | head -4
else
  echo "Could not determine login state; running wrangler login."
  npx wrangler login
fi

step "Email domain"
echo "Email Routing works on an apex domain that is a zone on this account and receives no mail elsewhere"
echo "(e.g. example.com). Subdomains and domains already on Google Workspace / other providers cannot be used."
read -r -p "Apex domain for your agents' mail: " DOMAIN
[[ -n "$DOMAIN" ]] || { echo "Domain is required."; exit 1; }
DOMAIN="$(printf "%s" "$DOMAIN" | tr "[:upper:]" "[:lower:]")"

CURRENT_DOMAINS="$(grep -E '^[[:space:]]*"EMAIL_DOMAINS"' wrangler.jsonc | sed -E 's/.*"EMAIL_DOMAINS":[[:space:]]*"([^"]*)".*/\1/')"
if [[ "$CURRENT_DOMAINS" == "$DOMAIN" ]]; then
  echo "EMAIL_DOMAINS already set to ${DOMAIN}."
  sed -i.bak "s/\"addresses\": \[[^]]*\]/\"addresses\": [\"*@${DOMAIN}\"]/" wrangler.jsonc && rm -f wrangler.jsonc.bak
else
  sed -i.bak "s/\"EMAIL_DOMAINS\": \"[^\"]*\"/\"EMAIL_DOMAINS\": \"${DOMAIN}\"/" wrangler.jsonc && rm -f wrangler.jsonc.bak
  sed -i.bak "s/\"addresses\": \[[^]]*\]/\"addresses\": [\"*@${DOMAIN}\"]/" wrangler.jsonc && rm -f wrangler.jsonc.bak
  if [[ -n "$CURRENT_DOMAINS" && "$CURRENT_DOMAINS" != "REPLACE_ME.example.com" ]]; then
    echo "Replaced EMAIL_DOMAINS ${CURRENT_DOMAINS} -> ${DOMAIN} in wrangler.jsonc (edit the file by hand to serve several domains)."
  else
    echo "Set EMAIL_DOMAINS=${DOMAIN} in wrangler.jsonc"
  fi
fi

step "D1 database"
if grep -q 'REPLACE_ME_D1_DATABASE_ID' wrangler.jsonc; then
  OUT="$(npx wrangler d1 create dearagent 2>&1 || true)"
  ID="$(echo "$OUT" | grep -Eo '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' | head -1 || true)"
  if [[ -n "$ID" ]]; then
    echo "Created D1 database dearagent."
  elif echo "$OUT" | grep -qi "already exists"; then
    # Reuse the existing database (e.g. re-running setup after regenerating wrangler.jsonc).
    ID="$(npx wrangler d1 list --json 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const r=JSON.parse(s).find(d=>d.name==="dearagent");console.log(r?r.uuid:"")})')"
    [[ -n "$ID" ]] && echo "D1 database dearagent already exists; reusing it."
  else
    echo "$OUT"
  fi
  [[ -n "$ID" ]] || { echo "Could not determine the D1 database id. Create it manually and paste the id into wrangler.jsonc."; exit 1; }
  sed -i.bak "s/REPLACE_ME_D1_DATABASE_ID/${ID}/" wrangler.jsonc && rm -f wrangler.jsonc.bak
  echo "Set D1 database_id=${ID}"
else
  echo "D1 database_id already set."
fi

step "R2 bucket"
if npx wrangler r2 bucket info dearagent-attachments >/dev/null 2>&1; then
  echo "Bucket dearagent-attachments already exists."
else
  R2_OUT="$(npx wrangler r2 bucket create dearagent-attachments 2>&1 || true)"
  if echo "$R2_OUT" | grep -qi "already exists"; then
    echo "Bucket dearagent-attachments already exists."
  elif echo "$R2_OUT" | grep -qi "error"; then
    echo "$R2_OUT"; exit 1
  else
    echo "Created bucket dearagent-attachments."
  fi
fi

step "Applying D1 migrations (remote)"
npx wrangler d1 migrations apply dearagent --remote

step "API key"
if ask "Set the API_KEY secret now? (generates a random one and prints it once)"; then
  KEY="da_$(openssl rand -hex 24 2>/dev/null || node -e 'console.log(require("crypto").randomBytes(24).toString("hex"))')"
  printf '%s' "$KEY" | npx wrangler secret put API_KEY
  bold "API_KEY: $KEY"
  echo "Store this somewhere safe; it is not retrievable later."
fi

step "Email Routing (inbound)"
# Email Routing is configured per zone. If DOMAIN is a subdomain of a zone (e.g. mail.example.com
# under the example.com zone) the CLI cannot enable it; that is done once in the dashboard under the
# parent zone's Email Routing > Settings > Subdomains. Detect that case and guide instead of failing.
SUBDOMAIN_MODE=0
ROUTING_BLOCKED=0
PARENT_ZONE="${DOMAIN#*.}"
SUBLABEL="${DOMAIN%%.*}"
ROUTING_OUT="$(npx wrangler email routing enable "$DOMAIN" 2>&1 || true)"
if echo "$ROUTING_OUT" | grep -qi "could not find zone"; then
  SUBDOMAIN_MODE=1
  cat <<EOF

${DOMAIN} is not a zone on this account; it is a subdomain of ${PARENT_ZONE}.
Email Routing is configured on the apex zone, and subdomains are added under it:

  1. Dashboard > ${PARENT_ZONE} > Email Service > Email Routing > Onboard domain (the apex must be
     onboarded first; Cloudflare refuses if ${PARENT_ZONE} already has MX records pointing elsewhere).
  2. Email Routing > Settings > Subdomains > Add subdomain "${SUBLABEL}".
  3. Email Routing > Routing rules > select ${DOMAIN} > Catch-all address > Send to a Worker > dearagent.

If ${PARENT_ZONE} already receives mail through another provider, step 1 is not possible and
${DOMAIN} cannot be used for inbound mail. Use a domain whose apex can be dedicated to Cloudflare
Email Routing instead (Email Sending, by contrast, works fine on subdomains).
EOF
elif echo "$ROUTING_OUT" | grep -qi "Non-Cloudflare MX"; then
  ROUTING_BLOCKED=1
  cat <<EOF

${DOMAIN} already has MX records pointing at another mail provider, so it receives mail elsewhere.
Cloudflare Email Routing needs to own the MX records of the apex zone, and enabling it here would
replace them and break that mail, so nothing was changed.

Subdomains do not get around this: Email Routing for a subdomain is configured under the onboarded
apex zone, so ${DOMAIN} and everything below it cannot receive mail through this Worker.

Use a domain whose apex can be dedicated to Cloudflare Email Routing (one that receives no mail
today, or a new domain). Re-run this script with that domain. Email Sending, by contrast, works on
subdomains, so you can still send from mail.${DOMAIN} if it is onboarded for sending.
EOF
else
  echo "$ROUTING_OUT" | grep -v "open beta" || true
  if echo "$ROUTING_OUT" | grep -qi "error"; then
    echo "(Email Routing could not be enabled via CLI. Enable it for ${DOMAIN} in the dashboard: Compute & AI > Email Service > Email Routing.)"
  fi
fi

step "Email Sending (outbound, requires Workers Paid)"
SENDING_DOMAINS="$(npx wrangler email sending list 2>/dev/null | awk -F'│' 'NF>3 {gsub(/ /,"",$3); print $3}' || true)"
if echo "$SENDING_DOMAINS" | grep -qx "$DOMAIN"; then
  echo "Email Sending is already enabled for ${DOMAIN}."
elif ask "Enable Email Sending for ${DOMAIN} so agents can reply and compose?"; then
  SENDING_OUT="$(npx wrangler email sending enable "$DOMAIN" 2>&1 || true)"
  if echo "$SENDING_OUT" | grep -qi "already exists"; then
    echo "Email Sending is already enabled for ${DOMAIN}."
  elif echo "$SENDING_OUT" | grep -qi "error"; then
    echo "$SENDING_OUT" | grep -v "open beta"
    echo "(Enable it later with: npx wrangler email sending enable ${DOMAIN})"
  else
    echo "$SENDING_OUT" | grep -v "open beta" || true
  fi
fi

step "Deploying the Worker"
# `addresses` in wrangler.jsonc makes wrangler create the catch-all Email Routing rule for this Worker
# as part of the deploy (it prints an "Email Routing plan" and applies it). wrangler asks for
# confirmation before deleting routing rules (e.g. after a domain change) and cannot prompt when its
# output is piped, so run it in a pseudo-terminal via `script`, which keeps prompts working while
# recording the output so the Worker URL can be picked out afterwards.
DEPLOY_LOG="$(mktemp)"
if [[ "$(uname)" == "Darwin" ]]; then
  script -q "$DEPLOY_LOG" npx wrangler deploy
else
  script -q -e -c "npx wrangler deploy" "$DEPLOY_LOG"
fi
URL="$(tr -d '\r' < "$DEPLOY_LOG" | sed 's/\x1b\[[0-9;]*[A-Za-z]//g' | grep -Eo 'https://[A-Za-z0-9.-]+\.workers\.dev' | head -1 || true)"
rm -f "$DEPLOY_LOG"
URL="${URL:-https://dearagent.<your-subdomain>.workers.dev}"

if [[ "${ROUTING_BLOCKED:-0}" != "1" && "$SUBDOMAIN_MODE" != "1" ]]; then
  step "Catch-all routing rule → Worker"
  if npx wrangler email routing rules list "$DOMAIN" 2>/dev/null | grep -qE '^Catch-all rule: enabled, action: worker:dearagent'; then
    echo "Catch-all set: *@${DOMAIN} → Worker dearagent."
  else
    cat <<EOF
The deploy did not leave a catch-all rule pointing at the Worker (see the "Email Routing plan" output above).
Set it in the dashboard: Compute & AI > Email Service > Email Routing > ${DOMAIN} > Routing rules >
  "Catch-all address" > Action: Send to a Worker > dearagent.
EOF
  fi
fi

step "Done"
if [[ "${ROUTING_BLOCKED:-0}" == "1" ]]; then
  bold "Inbound mail is NOT configured: ${DOMAIN} receives mail elsewhere and Email Routing cannot be enabled on it. Re-run with a domain you can dedicate to Cloudflare Email Routing (see above)."
elif [[ "$SUBDOMAIN_MODE" == "1" ]]; then
  bold "Remaining manual step: add the ${SUBLABEL} subdomain + catch-all rule under the ${PARENT_ZONE} zone (instructions above)."
fi
cat <<EOF

Your DearAgent server is live at ${URL}.

Try it:
  curl -H "Authorization: Bearer \$API_KEY" ${URL}/inboxes -X POST -d '{}'
  # then send an email to the returned address and:
  curl -H "Authorization: Bearer \$API_KEY" "${URL}/inboxes/<address>/messages/latest"

MCP for Claude Code:
  claude mcp add --transport http dearagent ${URL}/mcp --header "Authorization: Bearer \$API_KEY"
EOF
