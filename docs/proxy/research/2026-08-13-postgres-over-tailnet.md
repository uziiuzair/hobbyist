# Postgres over a tailnet: the private lane

Status: PROPOSED. **VERIFIED on 2026-08-13, same-box and cross-device: a
sleeping Postgres woke on a `psql` connect addressed to the tailnet IP and to
the full MagicDNS name, with zero code changed, including from a second
machine whose path started on a DERP relay.** Numbers in the Measurements
sections below. Remaining gaps are listed at the bottom: the five dollar VPS,
and the Studio-over-Serve check.
Date:   2026-08-13

Companion to `docs/compute/research/2026-08-13-tunnels-and-tailscale.md`,
which concluded: public HTTP goes through an ingress (Cloudflare Tunnel or
Caddy), and everything wire-protocol or private goes over Tailscale. This doc
is the Tailscale half, and it is nearly all documentation rather than build.

## The claim

A Hobbyist box joined to a tailnet serves wake-on-connect Postgres to every
device on that tailnet today, with zero new code:

```
psql postgres://user:pw@<machine-name>.<tailnet>.ts.net:5432/blog
```

Sleeping database wakes on connect, exactly as on localhost, because the
tailnet path terminates at the same proxy.

## Why zero code, grounded

1. **The proxy already binds every interface.** `startPgProxy`
   (`packages/proxy/src/proxy.ts:588`) takes `host?: string` and defaults to
   `'0.0.0.0'` (`proxy.ts:611`). The daemon's call site
   (`packages/cli/src/daemon/server.ts:194`) passes no host. A tailnet
   interface is just another interface: `tailscaled` on the host assigns a
   `100.x.y.z` address, and anything bound to `0.0.0.0` is reachable on it.
2. **Wake does not care which interface the connection arrived on.**
   `createProxyDeps` (`packages/cli/src/daemon/context.ts:159`) resolves the
   project from the database name in the startup packet and calls `wake()`.
   Nothing in that path reads the local address.
3. **Routing is in the connection string, not in DNS.** The database name is
   the project (`docs/proxy/CLAUDE.md`): `/blog` reaches project `blog`,
   `/blog.analytics` reaches another database inside it. One MagicDNS name
   covers every project on the box.
4. **The proxy's missing TLS is not a gap on this path.** The proxy rejects
   every `SSLRequest` with `N` (`packages/proxy/src/startup.ts:75`,
   negotiation loop at `packages/proxy/src/proxy.ts:558`), and a default
   `psql` (`sslmode=prefer`) falls back to plaintext. On a public network
   that is a real limitation. Inside a tailnet the whole TCP stream rides
   WireGuard, so the fallback is encrypted end to end anyway. The private
   lane and the proxy's current TLS posture fit each other exactly.

## Setup, the whole of it

On the Hobbyist box:

```
# install tailscaled (https://tailscale.com/download), then
tailscale up
```

On any client device already on the tailnet:

```
psql postgres://user:pw@<machine-name>.<tailnet>.ts.net:5432/<project>
```

MagicDNS gives the name; nothing else is configured. No port forwarding, no
public IP, no DNS records, no certificates, no client-side sidecar. This is
what the Cloudflare lane cannot do for Postgres (see the companion doc,
section 3a) and it is the reason the private lane is Tailscale's.

## What this does not do

**It does not make the box tailnet-only.** `0.0.0.0` means the proxy is also
listening on the LAN and, on a VPS, on the public interface, subject only to
the machine's firewall. Tailscale adds a reachable path; it does not remove
the others.

For an operator who wants Postgres reachable **only** over the tailnet, the
options today are, in order of preference:

1. A host firewall rule dropping 5432 on the public interface. Works today,
   outside our scope, and where this should stay for now.
2. `DRAFT pending config change, not built:` a `proxyHost` field in
   `HobbyConfig` (`packages/core/src/config.ts:71`), with an
   `HOBBY_PROXY_HOST` env override beside the existing `HOBBY_PROXY_PORT`
   (`config.ts:124`), passed through the daemon's `startPgProxy` call to the
   `host` parameter that already exists and is currently unused by any
   caller. Binding to the box's tailnet address makes the proxy invisible
   off-tailnet with no firewall knowledge required. Small, additive, and it
   should wait for the ingress-mode ADR the companion doc calls for rather
   than landing as a drive-by.

## Studio over the tailnet

Studio rides the daemon's loopback TCP listener at `apiPort`, bound
explicitly to `127.0.0.1` (`packages/cli/src/daemon/server.ts:187`), with
Caddy as its sole intended caller (ADR 0008). Caddy remains unwired
(`createCaddyManager` in `packages/cli/src/daemon/caddy.ts:151` has no
caller), so today Studio is reachable only from the box itself.

`tailscale serve` can front that loopback listener with a tailnet-only
HTTPS endpoint and a certificate Tailscale issues for the machine's
`ts.net` name. Both of the questions this section originally left open,
whether the ADR 0008 session gate stays in the path and whether anything
chokes on Serve's `Host` header, were answered by running it: see "Studio
over `tailscale serve`" below. Whether Serve becomes a recommended setup,
rather than a verified-possible one, still belongs to the same ingress ADR
as the Caddy wiring question.

## Per-project names, later

Tailscale Services (`svc:` virtual IPs) advertises multiple MagicDNS names
and TCP endpoints from one `tailscaled`, which would allow
`blog.<tailnet>.ts.net:5432` per project instead of one machine name with
routing in the database name. The companion doc records it as TCP-only and
plan-tier-unverified. Not needed for the claim above to hold; filed as a
refinement, not a dependency.

## Against the wedge

- **Wake:** unchanged. Same proxy, same `wake()`, same activity tracking
  (`ctx.activity`, one source of truth per `server.ts:213`).
- **Sleep:** `tailscaled` is one more always-on process on the box. On the
  five dollar VPS its footprint joins the unmeasured column.
- **Cold start:** WireGuard adds per-packet overhead, not a per-connection
  edge round trip, so the effect on the 3s ceiling should be negligible.
  Should be: measured is the only word that counts, see below.

## Measurements, 2026-08-13

### Hardware and method

Apple M5 Pro, macOS 26.3.2, the same machine as
`2026-08-07-cold-start-measurements.md`. tailscale 1.102.2 on the host (the
BYO model: the standard macOS client, nothing Hobbyist-managed). Docker via
OrbStack 29.4.0. The daemon was the real installed one, started by the
author's own install, with the proxy on its default bind: `lsof` showed
`*:5432`, confirming the `0.0.0.0` default at `proxy.ts:611` live in
production, not just in source.

Client: `psql` from a `postgres:18-alpine` container on the same box. Timing
taken inside the container with `date +%s%N` around
`psql "<uri>" -tAc 'select 1'`, so `docker exec` overhead is outside the
measured window. Each sample is the full client experience: TCP connect,
auth, query, first row back. That is a wider window than the harness
segments in the 2026-08-07 doc, so compare shapes, not exact figures.

Two paths from the same client, so the container NAT cost cancels and the
difference isolates the tailscale hop: `100.120.238.84` (the box's tailnet
address, via OrbStack NAT then the `utun` tailscale interface) against
`host.docker.internal` (OrbStack's direct host path).

Cold samples forced the sleep: `POST /v1/resources/:id/stop` between
connects. Target was project `ali`, one postgres resource, previously
sleeping for days.

### Results, milliseconds

| path | scenario | n | p50 | min | max |
|---|---|---|---|---|---|
| tailnet IP | cold (wake on connect) | 10 | 175 | 160 | 216 |
| host.docker.internal | cold (wake on connect) | 10 | 171 | 121 | 251 |
| tailnet IP | warm | 30 | 11 | 8 | 14 |
| host.docker.internal | warm | 30 | 10 | 8 | 15 |

The tailnet cold distribution sits entirely inside the host-path spread, and
warm differs by about a millisecond. **On one box, the tailscale path adds
nothing measurable to either cold or warm connects.** Cold p50 of 175ms is
also consistent with the 170ms loopback harness p50 from 2026-08-07, against
a 1s target and 3s ceiling.

### What was verified beyond the numbers

- **Wake fired on the tailnet path:** the resource went `sleeping` to
  `running` on the API, `lastActiveAt` updated, and `select 1` returned on
  the very connect that triggered the wake.
- **The full MagicDNS connection string works:**
  `psql postgres://...@uzairs-macbook-pro.tailc7b992.ts.net:5432/ali`
  returned `1`. The name resolves to the tailnet address (verified with
  `dscacheutil`).
- **Proxy error semantics survive the tailnet path:** connecting to a
  project with two postgres resources returned the proxy's real
  `ErrorResponse` explaining the ambiguity, in 14ms, rather than a dropped
  socket.
- **First cold connect after a multi-day sleep:** 319ms, one sample, noted
  for honesty; every scripted cold sample after it was under 260ms.

## Cross-device measurements, 2026-08-13, same day

Second device: `uziiuzair`, Ubuntu Linux x86_64, native
`psql (PostgreSQL) 18.4`, reached over Tailscale SSH. Same target resource,
same method (GNU `date +%s%N` around `psql -tAc 'select 1'`), full MagicDNS
connection string, which resolved correctly on the remote box via `getent`.

The run captured something better than a clean number: **the path changed
underneath it.** At first contact, `tailscale ping` showed the peer reachable
only via `DERP(sin)`, the Singapore relay, at 215ms RTT, with no direct
connection established. Under the sustained traffic of the test itself,
Tailscale punched through NAT, and by the end `tailscale ping` showed a
direct IPv6 endpoint at 6ms RTT. The samples straddle that transition, and
that is the honest shape of real-world tailnets: the first connects pay the
relay tax, then the path upgrades on its own.

| scenario | n | samples, ms | reading |
|---|---|---|---|
| cold, relay era | 3 | 459, 556, 300 | worst observed 556ms |
| cold, after upgrade | 3 | 313, 278, 278 | settles near 278ms |
| warm | 15 | p50 97, min 87, max 251 | the 251ms outlier is a relay-era sample |

Every sample, including the relayed worst case of 556ms, sits inside the
3000ms ceiling with over 5x headroom, and the relayed cold connect is the
one case that genuinely stacks both costs: a wake plus several round trips
through a relay a continent away. `sslmode=prefer` fell back to plaintext
here exactly as on loopback; over the tailnet that plaintext is inside
WireGuard end to end regardless of relay, because DERP forwards encrypted
WireGuard frames it cannot read.

## Off-tailnet exposure, confirmed live

On the same box, the proxy answered on the LAN interface too:
`nc -z 192.168.18.15 5432` succeeded, with the macOS application firewall
disabled. That is the `0.0.0.0` bind doing what the "What this does not do"
section says it does: Tailscale added a path and removed none. On a laptop
behind NAT the blast radius is the LAN; on a VPS it is the internet, and the
firewall rule (or the DRAFT `proxyHost` bind) is not optional hygiene there.

The daemon API held its contract in the same check: port 7432 was
unreachable on the LAN interface, matching its explicit `127.0.0.1` bind at
`packages/cli/src/daemon/server.ts:187`.

## Studio over `tailscale serve`, verified 2026-08-13

After the operator enabled Serve on the tailnet (a one-click admin action;
the CLI blocks and prints the enablement URL until it is done):

```
tailscale serve --bg http://127.0.0.1:7432
```

From the remote Linux box, over `https://uzairs-macbook-pro.tailc7b992.ts.net`
with a certificate Serve provisioned itself (no `-k` needed, HTTP/2):

- **The session gate held.** Unauthenticated `GET /v1/projects` returned
  `401 {"error":{"code":"unauthorized","message":"authentication required"}}`.
  This is `createStudioApp` wrapping the TCP listener
  (`packages/cli/src/daemon/server.ts:176`), the same gate ADR 0008 built
  for Caddy, gating a caller ADR 0008 never anticipated. Serve is transport,
  auth stays auth, exactly as the earlier section demanded.
- **The Studio shell served.** `GET /` returned 200 with the Studio HTML.
  The `Host: uzairs-macbook-pro.tailc7b992.ts.net` header bothered nothing:
  the open Host-header question from the earlier section is answered.
- Reverted after with `tailscale serve reset`; the tailnet's serve config
  is back to empty. Re-enabling is the one `--bg` command above.

One caveat worth its own line: Serve in front of `apiPort` publishes the
whole session-gated daemon API to the tailnet, not just Studio's pages. The
gate held here, but that makes Studio's operator credential the only thing
between every tailnet device and create/destroy on every database. On a
personal tailnet (6 users) that is a reasonable trade; it should still be a
documented one.

## Still unverified

1. **The five dollar VPS**, as everywhere else in this project.

## Sources

- [Tailscale quickstart](https://tailscale.com/kb/1017/install)
- [MagicDNS](https://tailscale.com/kb/1081/magicdns)
- [Tailscale Serve](https://tailscale.com/kb/1312/serve)
- [Tailscale Services](https://tailscale.com/docs/features/tailscale-services)
- [Tailscale Docker parameters](https://tailscale.com/docs/features/containers/docker/docker-params)
