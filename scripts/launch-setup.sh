#!/usr/bin/env bash
#
# The one script that touches live infrastructure.
#
# It creates the DNS records for hobbyist.sh (GitHub Pages) and hobby.sh (the
# install worker), then deploys the worker. Nothing else in this repository
# changes anything outside it, and this file does nothing until you run it.
#
#   scripts/launch-setup.sh              show what would change, change nothing
#   scripts/launch-setup.sh --apply      make the changes, after confirming
#
# Needs:
#   CLOUDFLARE_API_TOKEN   a token with Zone:DNS:Edit on both zones, and
#                          Account:Workers Scripts:Edit for the deploy
#
# Re-running is safe. Every record is matched by name and type and updated in
# place rather than duplicated, and the worker deploy is idempotent by nature.

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

SITE_ZONE="${SITE_ZONE:-hobbyist.sh}"
INSTALL_ZONE="${INSTALL_ZONE:-hobby.sh}"
PAGES_TARGET="${PAGES_TARGET:-uziiuzair.github.io}"

APPLY=false
[ "${1:-}" = "--apply" ] && APPLY=true

if [ -t 1 ]; then
  BOLD="$(printf '\033[1m')"; DIM="$(printf '\033[2m')"; RED="$(printf '\033[31m')"
  GREEN="$(printf '\033[32m')"; YELLOW="$(printf '\033[33m')"; RESET="$(printf '\033[0m')"
else
  BOLD=""; DIM=""; RED=""; GREEN=""; YELLOW=""; RESET=""
fi

step() { printf '\n%s==>%s %s\n' "$BOLD" "$RESET" "$1"; }
note() { printf '    %s%s%s\n' "$DIM" "$1" "$RESET"; }
ok()   { printf '    %s%s%s\n' "$GREEN" "$1" "$RESET"; }
warn() { printf '    %s%s%s\n' "$YELLOW" "$1" "$RESET"; }

die() {
  printf '\n%serror:%s %s\n' "$RED" "$RESET" "$1" >&2
  if [ $# -gt 1 ]; then printf '\n%s\n' "$2" >&2; fi
  exit 1
}

have() { command -v "$1" >/dev/null 2>&1; }

have curl || die "curl is not installed."
have jq   || die "jq is not installed." "Debian or Ubuntu: sudo apt-get install -y jq
  macOS:             brew install jq"

: "${CLOUDFLARE_API_TOKEN:?CLOUDFLARE_API_TOKEN is not set. Create a token with Zone:DNS:Edit on both zones and Workers Scripts:Edit, then export it.}"

# GitHub Pages' published apex addresses. Documented at
# docs.github.com/en/pages/configuring-a-custom-domain-for-your-github-pages-site.
# Hardcoded rather than resolved at runtime, because a script that silently
# points your apex at whatever DNS happened to answer is not a setup script.
PAGES_A=(185.199.108.153 185.199.109.153 185.199.110.153 185.199.111.153)
PAGES_AAAA=(2606:50c0:8000::153 2606:50c0:8001::153 2606:50c0:8002::153 2606:50c0:8003::153)

api() {
  local method="$1" path="$2" body="${3:-}"
  local args=(-sS -X "$method" "https://api.cloudflare.com/client/v4${path}"
              -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}"
              -H "Content-Type: application/json")
  [ -n "$body" ] && args+=(--data "$body")
  curl "${args[@]}"
}

# Every call goes through here so that a failure surfaces Cloudflare's own
# message. A bare "false" from their success flag tells the reader nothing, and
# the two most likely failures (a token missing a scope, a zone on another
# account) both have very clear messages that are worth showing.
api_checked() {
  local response
  response="$(api "$@")"
  if [ "$(printf '%s' "$response" | jq -r '.success')" != "true" ]; then
    printf '%s\n' "$response" | jq -r '.errors[]? | "  cloudflare: \(.message) (code \(.code))"' >&2
    die "the Cloudflare API refused that request." "Check that CLOUDFLARE_API_TOKEN has Zone:DNS:Edit on both zones."
  fi
  printf '%s' "$response"
}

zone_id() {
  local name="$1" id
  id="$(api_checked GET "/zones?name=${name}" | jq -r '.result[0].id // empty')"
  [ -n "$id" ] || die "zone ${name} was not found on this account." \
    "Either the domain is not on this Cloudflare account, or the token cannot see it."
  printf '%s' "$id"
}

# Returns empty rather than dying when the install zone is not on the account
# yet, so that a run before hobby.sh has been added still completes the site
# half instead of failing at the first API call. The site publishes the same
# web-install.sh at /install, so the mirror keeps working either way. Re-run this
# once hobby.sh is on the account and the worker half completes too.
zone_id_optional() {
  local name="$1"
  api_checked GET "/zones?name=${name}" | jq -r '.result[0].id // empty'
}

# Matched by name and type, so a re-run updates rather than duplicates. Apex A
# records are the one case with several records of the same name and type, and
# they are handled by their own function below.
upsert() {
  local zone="$1" type="$2" name="$3" content="$4" proxied="$5"
  local existing current_content current_proxied body

  existing="$(api_checked GET "/zones/${zone}/dns_records?type=${type}&name=${name}")"
  body="$(jq -nc --arg t "$type" --arg n "$name" --arg c "$content" --argjson p "$proxied" \
    '{type:$t,name:$n,content:$c,proxied:$p,ttl:1}')"

  local id
  id="$(printf '%s' "$existing" | jq -r '.result[0].id // empty')"

  if [ -n "$id" ]; then
    current_content="$(printf '%s' "$existing" | jq -r '.result[0].content')"
    current_proxied="$(printf '%s' "$existing" | jq -r '.result[0].proxied')"
    if [ "$current_content" = "$content" ] && [ "$current_proxied" = "$proxied" ]; then
      note "$type $name -> $content (already correct)"
      return 0
    fi
    printf '    %s%s %s%s %s -> %s (was %s)\n' "$YELLOW" "update" "$type" "$RESET" "$name" "$content" "$current_content"
    $APPLY || return 0
    api_checked PUT "/zones/${zone}/dns_records/${id}" "$body" >/dev/null
    ok "updated"
  else
    printf '    %screate%s %s %s -> %s%s\n' "$GREEN" "$RESET" "$type" "$name" "$content" \
      "$([ "$proxied" = "true" ] && printf ' (proxied)' || printf ' (dns only)')"
    $APPLY || return 0
    api_checked POST "/zones/${zone}/dns_records" "$body" >/dev/null
    ok "created"
  fi
}

# The apex needs all four addresses of each family present, which upsert's
# one-record-per-name-and-type shape cannot express. Anything at that name and
# type that is not one of the four is removed, because a stale fifth address
# means one request in five reaches nothing.
upsert_apex_set() {
  local zone="$1" type="$2" name="$3"; shift 3
  local wanted=("$@")
  local existing

  existing="$(api_checked GET "/zones/${zone}/dns_records?type=${type}&name=${name}&per_page=100")"

  local want
  for want in "${wanted[@]}"; do
    local id
    id="$(printf '%s' "$existing" | jq -r --arg c "$want" '.result[] | select(.content==$c) | .id' | head -n1)"
    if [ -n "$id" ]; then
      note "$type $name -> $want (already present)"
      continue
    fi
    printf '    %screate%s %s %s -> %s (dns only)\n' "$GREEN" "$RESET" "$type" "$name" "$want"
    $APPLY || continue
    api_checked POST "/zones/${zone}/dns_records" \
      "$(jq -nc --arg t "$type" --arg n "$name" --arg c "$want" '{type:$t,name:$n,content:$c,proxied:false,ttl:1}')" >/dev/null
    ok "created"
  done

  local stale
  # shellcheck disable=SC2086
  stale="$(printf '%s' "$existing" | jq -r --argjson w "$(printf '%s\n' "${wanted[@]}" | jq -Rsc 'split("\n")|map(select(length>0))')" \
    '.result[] | select(.content as $c | ($w | index($c)) | not) | "\(.id) \(.content)"')"
  if [ -n "$stale" ]; then
    while read -r id content; do
      [ -z "$id" ] && continue
      printf '    %sdelete%s %s %s -> %s (not a GitHub Pages address)\n' "$RED" "$RESET" "$type" "$name" "$content"
      $APPLY || continue
      api_checked DELETE "/zones/${zone}/dns_records/${id}" >/dev/null
      ok "deleted"
    done <<< "$stale"
  fi
}

# ---------------------------------------------------------------------------

if $APPLY; then
  printf '%sThis will change live DNS on %s and %s.%s\n' "$BOLD" "$SITE_ZONE" "$INSTALL_ZONE" "$RESET"
  printf 'Run without --apply first if you have not read the plan.\n\n'
  printf 'Type the word apply to continue: '
  read -r confirmation
  [ "$confirmation" = "apply" ] || die "not confirmed, nothing changed."
else
  printf '%sDry run.%s Nothing will be changed. Re-run with --apply to make these changes.\n' "$BOLD" "$RESET"
fi

step "Finding the zones"
SITE_ZONE_ID="$(zone_id "$SITE_ZONE")"
INSTALL_ZONE_ID="$(zone_id_optional "$INSTALL_ZONE")"
ok "$SITE_ZONE  $SITE_ZONE_ID"
if [ -n "$INSTALL_ZONE_ID" ]; then
  ok "$INSTALL_ZONE  $INSTALL_ZONE_ID"
else
  warn "$INSTALL_ZONE is not on this Cloudflare account yet. Skipping the worker."
  warn "Add the zone, then re-run this script. The mirror at"
  warn "https://${SITE_ZONE}/install serves the same script in the meantime."
fi

step "$SITE_ZONE: GitHub Pages"
note "apex A and AAAA records point at GitHub. www is a CNAME to $PAGES_TARGET."
note "left unproxied on purpose: GitHub issues the certificate for the custom"
note "domain itself, and it cannot do that through Cloudflare's proxy until the"
note "domain has verified. Turn the orange cloud on afterwards if you want it."
upsert_apex_set "$SITE_ZONE_ID" A    "$SITE_ZONE" "${PAGES_A[@]}"
upsert_apex_set "$SITE_ZONE_ID" AAAA "$SITE_ZONE" "${PAGES_AAAA[@]}"
upsert "$SITE_ZONE_ID" CNAME "www.${SITE_ZONE}" "$PAGES_TARGET" false

step "$INSTALL_ZONE: the install worker"
if [ -z "$INSTALL_ZONE_ID" ]; then
  warn "skipped: $INSTALL_ZONE is not on this Cloudflare account yet."
  note "Add the zone in Cloudflare, then re-run this script."
  note "Nothing else here depends on it."
else
  note "a worker route needs a proxied record at the hostname to attach to. The"
  note "address is never reached: 192.0.2.1 is the reserved documentation address"
  note "from RFC 5737, chosen so that a misconfiguration fails obviously rather"
  note "than reaching somebody else's server."
  upsert "$INSTALL_ZONE_ID" A "$INSTALL_ZONE" "192.0.2.1" true
  upsert "$INSTALL_ZONE_ID" A "www.${INSTALL_ZONE}" "192.0.2.1" true
fi

step "Deploying the worker"
if [ -z "$INSTALL_ZONE_ID" ]; then
  warn "skipped: the worker's routes are on $INSTALL_ZONE, which is not on this account."
elif ! have npx; then
  warn "npx is not available, skipping the deploy."
  warn "Deploy it by hand: cd worker && npm install && npx wrangler deploy"
elif $APPLY; then
  ( cd "$REPO_DIR/worker" && npm install --silent && npx wrangler deploy )
  ok "deployed"
else
  note "would run: cd worker && npm install && npx wrangler deploy"
  ( cd "$REPO_DIR/worker" && npx wrangler deploy --dry-run --outdir /tmp/hobby-worker-dry >/dev/null 2>&1 ) \
    && ok "the worker builds" \
    || warn "the worker did not build. Fix that before applying."
fi

# ---------------------------------------------------------------------------

step "What is left to do by hand"
cat <<EOF
    ${DIM}Cloudflare cannot do these, and neither can this script.${RESET}

    1. Turn on GitHub Pages, once, in the repository:
       Settings > Pages > Source: GitHub Actions

    2. Set the custom domain:
       Settings > Pages > Custom domain: ${SITE_ZONE}
       site/public/CNAME already contains it, so the first deploy sets it too.

    3. Wait for GitHub to verify the domain, then tick "Enforce HTTPS".
       This can take a few minutes and occasionally up to an hour.

    4. Verify, in this order:

         dig +short ${SITE_ZONE}
         curl -sSI https://${SITE_ZONE}/ | head -1
         curl -fsSL https://${SITE_ZONE}/install | head -5

       That last one should print the first lines of web-install.sh, not HTML.

    5. Only if ${INSTALL_ZONE} is on the account, the shorter URL as well:

         curl -sSI https://${INSTALL_ZONE}/install | head -3
         curl -fsSL https://${INSTALL_ZONE}/install | head -5

    6. Only then, the real test, on a machine you do not mind rebuilding:

         curl -fsSL https://${SITE_ZONE}/install | bash
EOF

if $APPLY; then
  printf '\n%sDone.%s\n' "$BOLD" "$RESET"
else
  printf '\n%sDry run finished. Nothing changed.%s Re-run with --apply.\n' "$BOLD" "$RESET"
fi
