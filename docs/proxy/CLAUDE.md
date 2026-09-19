# `docs/proxy/` wake-on-connect wire proxy

**Status:** BUILT, in `packages/proxy/`. **This is the keystone.** The open
questions at the bottom are still open, and TLS termination is still not built.

A Postgres wire-protocol proxy that makes a sleeping database indistinguishable
from a slow one.

## Why this decides the project

Every other capability here is orchestration around mature tools, and none of it
is novel. This is the exception. It is also the component every comparable
project holds back: Xata's open-source scale-to-zero plugin explicitly cannot
wake a hibernated cluster, and automatic reactivation on connection is what they
kept in the paid product.

Wake-on-connect is what turns "your database is stopped" into "your first query
took a second." Without it, hibernation is a bug rather than a feature.

**Build this second, immediately after basic instance lifecycle.** If the illusion
cannot be made to feel good, the project has no reason to exist, and it is far
better to learn that in week two than in month six.

## The flow

```
TCP accept
  SSLRequest?    -> terminate TLS here. forced: the startup packet is
                    otherwise encrypted and we cannot route without reading it
  CancelRequest? -> route to the right upstream, do not treat as a wake
  read startup packet -> user, database, options
  resolve project from the database name
  refused?  -> (not running, and a wake of it already failed since the daemon started)
               send a real Postgres ErrorResponse, never a dropped socket,
               and never a wake: only `hobby wake` or a restart clears it
  not running (sleeping, starting, failed)?
            -> daemon.wake(resource), poll readiness, then as below
  running?  -> dial upstream, replay startup packet; while the backend
               answers FATAL 57P03 (starting up), or the connection closes
               or resets before any backend message, discard it and dial
               again, within wakeTimeoutMs; then splice sockets
```

**Routing key: the database name is the project.**
`postgres://user:pw@box:5432/blog` reaches project `blog`. Additional databases
inside it are addressed `blog.analytics`, split on the first dot. Connection
strings stay completely ordinary, which means every client, ORM and GUI accepts
them with no special casing. The cost is that database names are globally unique
across the box, and a literal dot in a database name is reserved.

**Auth is passthrough.** We forward the startup packet unmodified and splice, so
SCRAM negotiates between the client and Postgres. The proxy never sees a password
and never maintains a user store. That is an entire subsystem we do not own.

## The proxy is also the activity sensor

Every client connection goes through here, so the number of live connections per
resource is known for free, with no polling. `docs/hibernation/CLAUDE.md` calls
"does an idle pooler connection count as activity" the single most likely bug in
that component, and counting at the proxy mostly dissolves it. Hibernation reads
this rather than inventing its own tracking.

## In scope

- Postgres wire protocol: startup packet parsing, SSL negotiation, auth
  passthrough, cancel requests, and the error paths
- Project resolution from connection parameters
- Wake orchestration: triggering the engine, waiting for readiness, handling a
  wake that fails or times out
- Connection pooling, or an honest decision to delegate pooling to an existing
  pooler behind us
- Holding the client politely during a wake instead of dropping it

## Out of scope

- Starting and stopping containers, which is `engine/`. The proxy asks, the engine
  acts.
- Deciding when to sleep, which is `hibernation/`
- Query parsing, rewriting, sharding, or load balancing. This is not PgDog.

## Prior art to read first

`pgcat`, `PgDog` and `Supavisor` are all real wire-protocol implementations in
production. None do wake-on-connect. Read them for protocol handling, then decide
whether to fork one or start clean.

## Decisions made

- **Cold start budget: under 1 second target, 3 seconds hard ceiling.** Three
  seconds is roughly where common ORM and pool connect timeouts start firing, so
  crossing it is a release blocker, not a slow path. Measured on a five dollar
  VPS and a Mac Mini, filed with hardware stated. See
  `research/2026-08-07-cold-start-budget.md`.
- **SSL terminates at the proxy.** Not a preference: routing requires reading the
  startup packet, and the startup packet is inside the TLS session.
- **Cancels route on a key the proxy mints**, swapped into BackendKeyData on its
  way to the client, because the pair a client presents is the only thing a
  CancelRequest carries. See `specs/2026-08-10-cancel-routing.md`.
- **Auth passes through** to Postgres, untouched.
- **Routing on the database name**, as above.

## Open questions

- What does a client library actually do when the first connection is slow?
  psql, node-postgres, Prisma, Drizzle and a GUI client all get tested against a
  sleeping database, and that matrix is an M2 release gate rather than a
  nice-to-have. This remains the likeliest source of "it does not work" reports.
- Where does the proxy get its TLS certificate? Caddy already manages an ACME
  store on the box (`docs/decisions/0009`), and sharing it is tempting but
  couples two components that are otherwise independent.
- Connection pooling, or an honest decision to delegate it to a pooler behind us.
  Not needed to prove the keystone, so it does not block M2.

## Amendment, 2026-08-14: Caddy is now wired in front of the HTTP half

`createCaddyManager` (`packages/cli/src/daemon/caddy.ts:151`, ADR 0009) had
been written and tested since Phase 1 with no production caller. Sub-project
B (branch `caddy-wiring`) gives it one: `startDaemon`
(`packages/cli/src/daemon/server.ts:253` onward) calls `ensureRunning()`,
`setFallback()` pointing at the HTTP wake router this file documents, an
optional Studio `addRoute()`, and `stop()` on shutdown, all behind a new
`caddyEnabled` config flag that defaults to `false`
(`packages/core/src/config.ts:101-121`). A Caddy failure logs and leaves the
daemon running rather than aborting startup, so the pg proxy this file
documents keeps waking connections even when the HTTP front door does not
come up. `hobby init` now probes host networking when Caddy is enabled and
warns, never fails, when it is absent. Full design at
`docs/proxy/specs/2026-08-14-wiring-caddy-design.md`; the host-networking
measurement behind it is filed as decision
`hobbyist.caddy-host-networking-works`.

This does not resolve the TLS certificate question above. Caddy now actually
runs and holds an ACME store for the HTTP hostnames it fronts, but that
store is not shared with the Postgres wire proxy's own TLS termination, and
sharing it remains exactly as undecided as it was before this amendment. Two
things this sub-project deliberately left undone: Caddy's certificate store
is not persisted (the container has no volume, so replacing it re-issues
certificates, a real problem against Let's Encrypt rate limits on a busy
box), and Docker Desktop for macOS is detected at `hobby init` and warned
about but has never actually been run against.

## Amendment, 2026-09-19: a `running` target is held until it serves (issue #9)

`running` is what the store recorded, not what the backend is doing. A
container restarted outside the daemon, or one still in crash recovery, is
not serving yet, and that reached the client in one of two shapes:

- **The connection closes or resets before any backend message.** This is
  the common one, and it was measured, not assumed: postgres:18-alpine on
  Docker Desktop with 3M rows, killed with `docker kill` and restarted with
  `docker start` outside the daemon, then 25 back-to-back `psql` connections
  through the proxy during recovery: 17 succeeded, 8 got a closed
  connection, none got 57P03. The cause is Docker's published port
  (docker-proxy, the Docker Desktop forwarder, and the Linux userland proxy
  behave the same), which accepts the TCP connection on the host side while
  nothing inside the container listens yet, then closes it.
- **`FATAL 57P03`** ("the database system is starting up") as the answer to
  the startup packet, once Postgres itself is listening but not yet taking
  sessions.

`holdUntilServing` (`packages/proxy/src/proxy.ts`) now reads the backend's
first answer before anything is forwarded (`classifyBackendAnswer`,
`packages/proxy/src/startup.ts`). On either shape it discards that connection
and dials again with the same startup packet, every 100ms, until the backend
serves or the connection's `wakeTimeoutMs` budget runs out. When the budget
runs out the proxy sends its own ErrorResponse, naming what the backend kept
doing. This is safe only because both shapes come before any authentication
exchange: the client has seen nothing yet. The line is the first complete
backend message. After it, the connection is spliced and a close is the
session's own business, never retried. A refused dial is still handled by
the existing dial retry. A healthy backend is still dialed once, with no
probe and no sleep.

The HTTP router got no equivalent. A dead upstream there is an honest 502
rather than a protocol-level lie, and replaying an HTTP request is not safe
in general (a streamed POST body is gone once sent), so it stays as it was.

## Amendment, 2026-09-19: a failed wake is not repeated (issue #10)

A resource whose start reliably fails used to be restarted by every incoming
connection, so a retrying client drove a crash loop. Now a wake through the
daemon's `buildWake` (`packages/cli/src/daemon/context.ts`) that throws
records the resource id in an in-memory refusal set, and every later implicit
wake of it is refused with `wake_failed` before the kind handler runs. Both
front doors ask first, through the optional `isWakeRefused` on `ProxyDeps`
and `HttpProxyDeps`: the wire proxy answers a refused target at once with an
ErrorResponse, the HTTP router with a 503, with no wake and no dial.

"Refused" is deliberately not the store's `failed`. `failed` keeps meaning
what reconcile and the kind handlers say: reconcile's `correctedState`
(`packages/cli/src/daemon/reconcile.ts`) writes it for every container found
stopped after an unclean reboot, OOM kill or crash, and a failed stop or a
failed deploy writes it too, and all of those are woken on the next
connection exactly as before. "Refused" means only that a wake failed since
this daemon started. Two things clear it: `POST /v1/resources/:id/start`
(`hobby wake`, the MCP wake tool, Studio's start button), which removes the
id before starting the resource, and a daemon restart, which empties the set
and so allows one fresh attempt per daemon lifetime.

Within a single wake, `pgProbe` (`packages/pg/src/readiness.ts`) now tells a
server that answered with an error (wrong password, no `pg_hba.conf` entry)
from one that has not answered, and `waitReady` concludes on the first
instead of polling out the whole timeout. 57P03 and the rest of SQLSTATE
classes 57 and 53 still read as "not yet", never as broken.
