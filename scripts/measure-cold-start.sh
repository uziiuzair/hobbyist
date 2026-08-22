#!/usr/bin/env bash
#
# Measures wake time end to end, the way a client actually experiences it.
#
#   ./scripts/measure-cold-start.sh
#   N=30 PROJECT=coldstart ./scripts/measure-cold-start.sh
#   KIND=app ./scripts/measure-cold-start.sh
#
# KIND=postgres (the default) times a connect and a query through the wire
# protocol proxy. KIND=app deploys a tiny static server and times an HTTP
# request through the wake router, which needs no Caddy: the router keys off
# the Host header, so curl supplies one.
#
# Deliberately measured through the shipped product rather than a harness: the
# real proxy on 5432, the real daemon, and a real psql client. The number this
# prints is what an application would see, which is the number the project's
# claim is about.
#
# Each iteration puts the resource to sleep, waits until the daemon actually
# reports it sleeping (not merely that the stop was requested), settles, then
# times a connect and a query. Every iteration asserts the query returned the
# right answer, so a fast failure cannot be mistaken for a fast wake.
#
# It also times the same query while already awake. That warm figure is the
# client's own startup and connect cost, which the cold figure also carries,
# so subtracting it gives the wake work itself.
#
# Needs GNU date for millisecond timestamps, which is what Linux has.

set -euo pipefail

N="${N:-30}"
PROJECT="${PROJECT:-coldstart}"
SETTLE_MS="${SETTLE_MS:-500}"

die() { printf '\nerror: %s\n' "$1" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

KIND="${KIND:-postgres}"
case "$KIND" in postgres|app) ;; *) die "KIND must be postgres or app, not $KIND" ;; esac

have hobby  || die "hobby is not on PATH."
have docker || die "docker is not installed."
have python3 || die "python3 is not installed."
if [ "$KIND" = postgres ]; then
  have psql || die "psql is not installed. On Ubuntu: sudo apt-get install -y postgresql-client"
else
  have curl || die "curl is not installed."
fi
date +%s%3N >/dev/null 2>&1 || die "this needs GNU date, for millisecond timestamps."

hobby ls --json >/dev/null 2>&1 || die "the daemon is not reachable. Start it with: hobby daemon &"

printf '==> Preparing %s\n' "$PROJECT"
if ! hobby ls --json | python3 -c "
import json,sys
want = sys.argv[1]
print('yes' if any(d['project']['name'] == want for d in json.load(sys.stdin)) else 'no')
" "$PROJECT" | grep -q yes; then
  hobby new "$PROJECT" >/dev/null
  printf '    created\n'
else
  printf '    already exists, reusing it\n'
fi

# Looks the resource up by name when one is given, and by kind otherwise, so
# the same helper serves both modes.
resource_state() {
  local want_name="${1:-}"
  hobby ls --json | python3 -c "
import json,sys
proj, want_name, want_kind = sys.argv[1], sys.argv[2], sys.argv[3]
for d in json.load(sys.stdin):
    if d['project']['name'] == proj:
        for r in d['resources']:
            if (r['name'] == want_name) if want_name else (r['kind'] == want_kind):
                print(r['state']); raise SystemExit
print('unknown')
" "$PROJECT" "$want_name" "$KIND"
}

state_of() {
  if [ "$KIND" = app ]; then resource_state "$APP_NAME"; else resource_state ""; fi
}

APP_NAME="${APP_NAME:-web}"
HTTP_PORT="${HTTP_PORT:-7433}"

if [ "$KIND" = postgres ]; then
  CONN="$(hobby connect "$PROJECT" --json | python3 -c 'import json,sys; print(json.load(sys.stdin)["connectionString"])')"
  [ -n "$CONN" ] || die "could not get a connection string."
  TARGET="$PROJECT"
else
  TARGET="$PROJECT/$APP_NAME"

  # Which app to measure. The fixtures live in scripts/fixtures and differ only
  # in how much they do before they can answer: see that directory's README.
  FIXTURE_NAME="${FIXTURE:-static}"
  FIXTURE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/fixtures/${FIXTURE_NAME}"
  [ -d "$FIXTURE_DIR" ] || die "no fixture named ${FIXTURE_NAME}" \
    "available: $(for d in "$(dirname "$FIXTURE_DIR")"/*/; do basename "$d"; done | tr '\n' ' ')"
  printf '    fixture: %s\n' "$FIXTURE_NAME"
  if ! resource_state "$APP_NAME" >/dev/null 2>&1 || [ "$(resource_state "$APP_NAME")" = "unknown" ]; then
    printf '    deploying %s as %s (a build on one vCPU can take minutes)\n' "$FIXTURE_NAME" "$TARGET"
    # nextjs-db needs a database to talk to, and --database is how a deploy is
    # told which sibling to bind. Every other fixture ignores it.
    DEPLOY_ARGS=(--project "$PROJECT" --name "$APP_NAME" --port 8080)
    if [ "$FIXTURE_NAME" = "nextjs-db" ]; then
      # hobby new creates a postgres called primary, which is the sibling this
      # fixture queries. Both are asleep before each measurement, so one request
      # wakes two containers in sequence.
      DEPLOY_ARGS+=(--database primary)
    fi
    hobby deploy "$FIXTURE_DIR" "${DEPLOY_ARGS[@]}" >/dev/null \
      || die "deploy failed. Run it without redirecting output to see why."
  else
    printf '    %s already deployed, reusing it\n' "$TARGET"
  fi
  HOSTNAME_APP="$(hobby ls --json | python3 -c "
import json,sys
proj, name = sys.argv[1], sys.argv[2]
for d in json.load(sys.stdin):
    if d['project']['name'] == proj:
        for r in d['resources']:
            if r['name'] == name:
                print(r.get('config', {}).get('hostname', '')); raise SystemExit
" "$PROJECT" "$APP_NAME")"
  [ -n "$HOSTNAME_APP" ] || die "could not find the app's hostname in hobby ls --json."
  printf '    reachable as %s via the router on :%s\n' "$HOSTNAME_APP" "$HTTP_PORT"
fi

# Reports the resource's state as the daemon sees it, which is the only source
# that knows whether the container is really down.
wait_sleeping() {
  local i
  for i in $(seq 1 120); do
    [ "$(state_of)" = "sleeping" ] && return 0
    sleep 0.5
  done
  die "it never reached sleeping. State is now: $(state_of)"
}

# One timed request, asserted. The assertion is the point: a connection that
# fails fast must never be recorded as a wake that succeeded fast.
timed_request() {
  local label="$1" start end out
  start="$(date +%s%3N)"
  if [ "$KIND" = postgres ]; then
    out="$(psql "$CONN" -tAq -c 'select 1' 2>/dev/null || true)"
    end="$(date +%s%3N)"
    [ "$(printf '%s' "$out" | tr -d '[:space:]')" = "1" ] \
      || die "$label did not return 1."
  else
    out="$(curl -s -o /dev/null -w '%{http_code}' --max-time 30 \
             -H "Host: $HOSTNAME_APP" "http://127.0.0.1:${HTTP_PORT}/" || true)"
    end="$(date +%s%3N)"
    [ "$out" = "200" ] || die "$label returned HTTP ${out:-nothing}, not 200."
  fi
  printf '%s' "$(( end - start ))"
}

printf '==> Measuring %s wakes (%s)\n' "$N" "$KIND"
COLD=(); WARM=()
for i in $(seq 1 "$N"); do
  hobby sleep "$TARGET" >/dev/null 2>&1 || true
  # For the app-plus-database fixture the database has to be asleep too, or the
  # measurement is only ever half the wake it claims to be.
  if [ "$KIND" = app ] && [ "${FIXTURE_NAME:-static}" = "nextjs-db" ]; then
    hobby sleep "$PROJECT/primary" >/dev/null 2>&1 || true
  fi
  wait_sleeping
  python3 -c "import time,sys; time.sleep(int(sys.argv[1])/1000)" "$SETTLE_MS"

  COLD+=( "$(timed_request "cold, iteration $i")" )
  WARM+=( "$(timed_request "warm, iteration $i")" )

  printf '    %2d/%s  cold %sms  warm %sms\n' "$i" "$N" "${COLD[-1]}" "${WARM[-1]}"
done

stats() {
  printf '%s\n' "$@" | python3 -c "
import sys
v = sorted(int(x) for x in sys.stdin.read().split())
def pct(p):
    if not v: return 0
    k = (len(v) - 1) * p
    lo, hi = int(k), min(int(k) + 1, len(v) - 1)
    return round(v[lo] + (v[hi] - v[lo]) * (k - lo))
print(f'n={len(v)}  min={v[0]}  p50={pct(0.5)}  p95={pct(0.95)}  max={v[-1]}  mean={round(sum(v)/len(v))}')
"
}

printf '\n==> Results, milliseconds, client observed\n'
printf '    cold  %s\n' "$(stats "${COLD[@]}")"
printf '    warm  %s\n' "$(stats "${WARM[@]}")"

printf '\n==> The box\n'
# Every field falls back rather than printing an empty column, because a
# benchmark without its hardware is a rumour and a half-filled table invites
# someone to quote the number without it.
cpu_model() {
  grep -m1 'model name' /proc/cpuinfo 2>/dev/null | cut -d: -f2- | sed 's/^ *//' && return
  grep -m1 'Model' /proc/cpuinfo 2>/dev/null | cut -d: -f2- | sed 's/^ *//' && return
  uname -m
}
fs_type() {
  local target="$HOME/.hobby"
  [ -d "$target" ] || target="$HOME"
  df -T "$target" 2>/dev/null | awk 'NR==2 {print $2}' | grep . && return
  df "$target" 2>/dev/null | awk 'NR==2 {print $1}' | grep . || echo unknown
}
printf '    cpu        %s x %s\n' "$(nproc 2>/dev/null || echo '?')" "$(cpu_model | head -1)"
printf '    memory     %s\n' "$(awk '/^MemTotal:/ {printf "%dMB", $2/1024}' /proc/meminfo 2>/dev/null || echo '?')"
printf '    swap       %s\n' "$(awk '/^SwapTotal:/ {printf "%dMB", $2/1024}' /proc/meminfo 2>/dev/null || echo '?')"
printf '    filesystem %s\n' "$(fs_type | head -1)"
printf '    kernel     %s\n' "$(uname -sr)"
printf '    docker     %s\n' "$(docker --version 2>/dev/null | sed 's/Docker version //;s/,.*//' || echo '?')"

cat <<'EOF'

The budget is 1 second target and 3 seconds hard ceiling. The warm row is the
psql client's own startup and connect cost; subtract it from cold to get the
wake work itself.

Please file this with the hardware above stated:
https://github.com/uziiuzair/hobbyist/issues
EOF
