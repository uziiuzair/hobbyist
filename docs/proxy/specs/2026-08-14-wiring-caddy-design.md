# Wiring Caddy

**Date:** 2026-08-14
**Status:** approved, implemented on branch `caddy-wiring`
**Capability:** `proxy`, the front door to the wake router
**Sub-project:** B of five (A record before code, **B wire Caddy**, D1 Studio and
MCP for all kinds, D2 Studio API tokens, C remote deploy)

**Decisions in this spec were taken by the agent, not the author**, who delegated
them for an overnight run. Every one is stated with its reasoning so it can be
reversed on sight.

## The problem

`createCaddyManager` (`packages/cli/src/daemon/caddy.ts:151`) has no production
caller. It has been fully written and fully tested since Phase 1 and has never
run. The HTTP wake router it exists to front (`startHttpRouter`, wired at
`packages/cli/src/daemon/server.ts:208`) listens on `127.0.0.1:7433` and is
therefore reachable by nothing except the daemon itself.

So the whole HTTP half of the wedge, an app that sleeps and wakes on the first
request, works only if you already know to send a `Host` header to a loopback
port. There is no front door.

### The blocker that was not real

`claude_docs/ACTIVE_CONTEXT.md` and the Phase 2 handoff both recorded that
`network: 'host'` "does not exist on Docker Desktop for macOS, so it breaks on
the author's own machine first". That was written without running it, and the
author does not run Docker Desktop. Measured on this machine on 2026-08-14:

```
$ docker info --format '{{.Name}} | {{.OperatingSystem}}'
orbstack | OrbStack                                    (29.4.0)

$ docker run --rm --network host curlimages/curl -s http://127.0.0.1:7699/
daemon-loopback-reached                    (a host listener, reached from inside)

$ docker run -d --network host caddy:2-alpine
host -> :80    HTTP 200
host -> :2019  HTTP 200                    (ports bound inside, seen outside)
```

Both directions work, which is exactly what Caddy needs: it reaches the daemon's
loopback listeners, and the ports it binds are reachable from outside. So
`caddy.ts`'s existing design needs no rescue. This sub-project is wiring.

Filed as decision `hobbyist.caddy-host-networking-works`.

## What ships

Four calls the daemon does not currently make, plus the config to decide whether
to make them, plus a preflight check so an unsupported runtime says so at
`hobby init` rather than at the first request.

## Decision 1: Caddy is OPT-IN, and defaults to OFF

`config.caddy.enabled` defaults to `false`. A daemon started without it behaves
exactly as it does today.

Three reasons, in order of weight:

1. **Starting Caddy binds :80 and :443 on the operator's box.** A daemon restart
   that silently claims two privileged ports is a surprising side effect, and on
   a machine already running a web server it is a port conflict presented as a
   daemon crash.
2. **The code itself says the surface behind it is unreviewed.**
   `warnOnFirstExposure` (`caddy.ts:163-174`) prints that Studio's auth path "was
   written in a single unattended session and has not been reviewed or exercised
   against a live host. Read it before pointing this at the internet." Turning
   that on by default would contradict the warning the same file prints.
3. Root `CLAUDE.md`: "we do not ship anything whose failure mode is someone else
   getting owned or losing data quietly." Network exposure is opt-in per that
   sentence, whatever ADR 0008 says about Studio being network-exposed in
   principle.

## Decision 2: the config field is named `caddy`, NOT `ingress`

A parallel session owns ingress as a concept. Its decision record
(`hobbyist.ingress-two-lanes-tailscale-byo`) establishes that ingress is two
lanes, public HTTP through an adapter (Caddy today, Cloudflare Tunnel possibly
later) and everything private over Tailscale, and states that "an ingress-mode
ADR (0013+) is still owed". That ADR is theirs and will take number 0015.

Naming this field `ingress` would squat the taxonomy their ADR exists to define,
from a sub-project that implements exactly one of the two lanes. So this ships a
concrete `caddy` block, and their ADR is free to define `ingress` on top of it
later without first having to undo a name.

The fields are **flat, not a nested `caddy: {}` object**, and that is a
correctness requirement rather than a style preference. `resolveConfig`
(`packages/core/src/config.ts:142-150`) merges with a shallow spread:

```ts
{ ...DEFAULT_CONFIG, ...readFileConfig(cwd), ...readEnvConfig(env) }
```

Every field on `HobbyConfig` today is a scalar, so that merge is correct. A
nested object would be the only exception, and setting one env var would replace
the whole sub-object: `HOBBY_CADDY_ENABLED=1` alone would leave `adminPort` and
`studioHost` `undefined` rather than defaulted, silently, with no type error
because `readEnvConfig` returns `Partial<HobbyConfig>`. Fixing that would mean
introducing deep-merge logic for one field.

```ts
// packages/core/src/config.ts, on HobbyConfig
// Opt-in. See the spec's Decision 1: starting Caddy binds :80 and :443.
caddyEnabled: boolean         // false
// Caddy's own admin API, on loopback, reached by the daemon only.
caddyAdminPort: number        // 2019
// The hostname Studio is served at. Null means no Studio route is published
// and Caddy serves only the catch-all, which is the correct shape for a box
// that runs apps and does not want its control plane on the network at all.
caddyStudioHost: string | null // null
```

Environment overrides follow the existing pattern exactly:
`HOBBY_CADDY_ENABLED`, `HOBBY_CADDY_ADMIN_PORT`, `HOBBY_CADDY_STUDIO_HOST`.

The `caddy` prefix still carries Decision 2's point: these are Caddy's own
knobs, not a general ingress taxonomy, and the parallel session's ADR 0015 is
free to define `ingress` on top without undoing a name.

## Decision 3: what gets wired, and where

In `startDaemon` (`packages/cli/src/daemon/server.ts`), after the HTTP router is
listening and before the hibernator starts:

1. **`ensureRunning()`**. Idempotent by its own contract, safe on every start.
2. **`setFallback({ upstream, askUrl })`**. `upstream` is
   `127.0.0.1:${ctx.config.httpPort}`, the wake router. `askUrl` is built from
   `TLS_ASK_PATH`, which `@hobby.sh/proxy` already exports at
   `packages/proxy/src/http.ts:66` precisely so the daemon can construct it
   without duplicating the string.
3. **`addRoute()` for Studio**, only when `caddy.studioHost` is non-null:
   `{ id: 'hobby-studio', host: studioHost, upstream: '127.0.0.1:' + apiPort }`.
   Skipped entirely when the Studio listener is not started (`apiPort === null`),
   because a route to a port nothing is listening on is worse than no route.
4. **`stop()` in the shutdown path**, alongside the existing listener closes.

Nothing is called per deploy. That is the entire point of the fallback: our
router already resolves the `Host` header to know what to wake, so having Caddy
resolve it too would be duplicated state that drifts whenever an admin API call
fails. `caddy.ts`'s own comment (`:44-56`) argues this and it is correct.

## Decision 4: an unsupported runtime is detected at `hobby init`, not at :80

`runPreflight` (called from `cmdInit`, `packages/cli/src/cli/commands.ts:133`)
gains a host-networking check. It runs only when `caddy.enabled` is true, since
the answer is irrelevant otherwise.

The check is the cheap direction of what was measured above: start a throwaway
container on `--network host` and confirm it can reach a loopback listener the
daemon itself opened. If it cannot, `hobby init` reports it as a warning, not a
failure, naming the likely cause:

> caddy: this container runtime does not appear to support host networking, which
> Caddy needs in order to bind :80 and :443 and reach the daemon. Docker Desktop
> for macOS is the known case. Linux and OrbStack both work. Hobbyist will start
> without a front door: apps are reachable on their loopback ports and `hobby
> studio` still works.

Warning rather than failure, because root `CLAUDE.md` says exactly that about the
ext4 case: "detect it at `hobby init`, warn rather than fail."

## Decision 5: Caddy failing to start does not take the daemon with it

`ensureRunning` and the two route pushes are wrapped so that a failure logs and
leaves the daemon running with no front door, rather than aborting startup.

The reasoning is the wedge. A box whose Caddy will not start still has Postgres
resources that must wake on connection through the pg proxy, which has nothing to
do with HTTP. Refusing to start the daemon because the HTTP front door failed
would take databases offline to punish a web server, which inverts the priority
root `CLAUDE.md` sets.

The failure is loud: an `error` line naming the admin API and the likely cause.
It is not silent, and it is not fatal.

## Surfaces

**`hobby studio`** currently prints a loopback URL. When `caddy.enabled` and
`caddy.studioHost` are set, it prints the public URL instead, because that is the
one that now works from anywhere. When Caddy is off it is unchanged.

**`hobby ls`** is unchanged. Hostnames are already shown for compute resources
(sub-project A), and whether Caddy is fronting them does not change the name.

## Error handling

| Situation | Response |
|---|---|
| `caddy.enabled` but the runtime has no host networking | `hobby init` warns (Decision 4); the daemon logs at startup and runs without a front door |
| Caddy container will not start | logged `error`, daemon continues (Decision 5) |
| Admin API unreachable when pushing routes | existing `HobbyError('runtime_unavailable', ...)` from `push()`, caught at the call site, logged, daemon continues |
| `studioHost` set but `apiPort` is null | the Studio route is skipped, with a log line saying why |

## Test plan

Test-driven, all against a fake runtime and a fake `fetchFn`. No Docker in the
suite: `createCaddyManager` already takes both seams, which is why its existing
tests run without a container.

| Area | Assertion |
|---|---|
| config | `caddy.enabled` defaults false; the three env overrides parse |
| startup | with `caddy.enabled` false, no runtime call and no fetch is made at all |
| startup | with it true, `ensureRunning` then `setFallback` are called, in that order |
| startup | the fallback upstream is `127.0.0.1:<httpPort>` and the askUrl contains `TLS_ASK_PATH` |
| startup | a Studio route is added when `studioHost` is set and `apiPort` is not null |
| startup | no Studio route when `studioHost` is set but `apiPort` is null, and the skip is logged |
| startup | no Studio route when `studioHost` is null |
| resilience | `ensureRunning` throwing leaves the daemon started and the pg proxy listening |
| resilience | a failing route push leaves the daemon started |
| shutdown | `stop()` is called on close |
| preflight | the host-networking check is skipped entirely when `caddy.enabled` is false |
| preflight | a runtime without host networking produces a warning, not a failure |

The two resilience tests are the load-bearing ones. They encode Decision 5, which
is the difference between "the web front door is down" and "the databases are
down".

## Out of scope

- **The ingress-mode taxonomy.** Two lanes, adapters, Cloudflare Tunnel as a peer
  to Caddy. That is the parallel session's ADR 0015, and this spec deliberately
  avoids the `ingress` name so it stays free.
- **Custom domains per app.** On-demand TLS makes them work already through the
  ask endpoint; a UI or CLI for managing them is not this.
- **Certificate storage and renewal.** Caddy owns that, and the container is
  managed but its data volume is not yet. Filed as a known gap below.

## Known gaps this ships with, stated rather than hidden

- **Caddy's certificate store is not persisted.** The container is created
  without a volume, so a container replacement loses issued certificates and
  re-issues on next request. Fine for `localhost` and for a low-traffic box,
  and a real problem against Let's Encrypt rate limits on a busy one. Needs a
  volume, which needs the `ContainerSpec` binds path that already exists; it is
  omitted here only to keep this sub-project to wiring.
- **Docker Desktop for macOS remains unmeasured.** Expected to fail, detected and
  warned about, never actually run.
