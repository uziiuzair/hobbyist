#!/usr/bin/env bash
#
# Measures wake time end to end, the way a client actually experiences it.
#
#   ./scripts/measure-cold-start.sh
#   N=30 PROJECT=coldstart ./scripts/measure-cold-start.sh
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

have hobby  || die "hobby is not on PATH."
have docker || die "docker is not installed."
have psql   || die "psql is not installed. On Ubuntu: sudo apt-get install -y postgresql-client"
have python3 || die "python3 is not installed."
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

CONN="$(hobby connect "$PROJECT" --json | python3 -c 'import json,sys; print(json.load(sys.stdin)["connectionString"])')"
[ -n "$CONN" ] || die "could not get a connection string."

# Reports the resource's state as the daemon sees it, which is the only source
# that knows whether the container is really down.
state_of() {
  hobby ls --json | python3 -c "
import json,sys
want = sys.argv[1]
for d in json.load(sys.stdin):
    if d['project']['name'] == want:
        for r in d['resources']:
            if r['kind'] == 'postgres':
                print(r['state']); raise SystemExit
print('unknown')
" "$PROJECT"
}

wait_sleeping() {
  local i
  for i in $(seq 1 120); do
    [ "$(state_of)" = "sleeping" ] && return 0
    sleep 0.5
  done
  die "it never reached sleeping. State is now: $(state_of)"
}

printf '==> Measuring %s wakes\n' "$N"
COLD=(); WARM=()
for i in $(seq 1 "$N"); do
  hobby sleep "$PROJECT" >/dev/null 2>&1 || true
  wait_sleeping
  python3 -c "import time,sys; time.sleep(int(sys.argv[1])/1000)" "$SETTLE_MS"

  start="$(date +%s%3N)"
  out="$(psql "$CONN" -tAq -c 'select 1' 2>/dev/null || true)"
  end="$(date +%s%3N)"
  [ "$(printf '%s' "$out" | tr -d '[:space:]')" = "1" ] \
    || die "iteration $i did not return 1. A failed connection is not a fast one."
  COLD+=( "$(( end - start ))" )

  start="$(date +%s%3N)"
  out="$(psql "$CONN" -tAq -c 'select 1' 2>/dev/null || true)"
  end="$(date +%s%3N)"
  [ "$(printf '%s' "$out" | tr -d '[:space:]')" = "1" ] || die "warm query $i failed."
  WARM+=( "$(( end - start ))" )

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
