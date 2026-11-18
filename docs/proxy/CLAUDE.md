# `docs/proxy/` wake-on-connect wire proxy

**Status:** BUILT, in `packages/proxy/`. **This is the keystone.** The open
questions at the bottom are still open. TLS termination is built, behind
`proxyTls` (ADR 0019).

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
  refused?  -> (not running, its last wake failed, and its backoff has not run out)
               send a real Postgres ErrorResponse, never a dropped socket,
               and never a wake: the backoff running out, `hobby wake` or a
               restart clears it
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
(2026-11-17: true for TCP clients. Serverless driver traffic is the one
exception, accepted in ADR 0021 on 2026-11-18 and described in the amendment of that date
below.)

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
- ~~Where does the proxy get its TLS certificate?~~ Answered 2026-09-28 by
  ADR 0019: from files the operator provides, re-read when they change. Not
  Caddy's store.
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
and so allows one fresh attempt per daemon lifetime. (The next amendment
replaced "until an explicit start" with a backoff.)

Within a single wake, `pgProbe` (`packages/pg/src/readiness.ts`) now tells a
server that answered with an error (wrong password, no `pg_hba.conf` entry)
from one that has not answered, and `waitReady` concludes on the first
instead of polling out the whole timeout. 57P03 and the rest of SQLSTATE
classes 57 and 53 still read as "not yet", never as broken.

## Amendment, 2026-09-19 (later the same day): the refusal is a backoff, and it is visible

The refusal above had no automatic way out, and that was the wrong default
for the failures a small box actually has. A disk briefly full, the Docker
daemon restarting, a slow first boot after a host reboot: each clears on its
own, and each left a database refused until a human noticed and ran `hobby
wake`, with nothing to notice it by but error text in some application's log.
Issue #10 itself left the door open for "a bounded automatic retry policy if
one is ever designed". This is that policy.

The set became a map from resource id to `{ failures, retryAt, lastError }`
(`WakeRefusal`, `packages/cli/src/daemon/context.ts`). After the Nth
consecutive failed wake through `buildWake`, automatic wakes are refused until
the failure time plus `wakeRetryDelayMs(N)`
(`packages/cli/src/daemon/wake-backoff.ts`): 30 seconds, then 1, 2, 4 and 8
minutes, then 15 minutes for every failure after that. Once `retryAt` passes,
`isWakeRefused` answers false, so the next connection or request is let
through to make one attempt; every caller arriving while it runs joins the
same in-flight wake, so a crowd waiting for the retry time costs one start. A
failure moves `retryAt` one step further along the schedule, and a success
deletes the entry, so the next failure starts at 30 seconds again. `POST
/v1/resources/:id/start` and a daemon restart still clear it at once. The
clock is `DaemonContext.wakeClock`, unset in production (so `Date.now`), and
named that rather than `now` because `AppDeps` and `WorkerDeps` already read a
`now` off the same structurally shared context.

The bound issue #10 needed is still there, as a rate instead of a stop: a
resource that never boots costs five starts in its first quarter of an hour
and four an hour after that, however many clients keep connecting.

It is also visible now. `toWireResource` (`packages/cli/src/daemon/wire.ts`)
adds `wakeRefusal: { failures, retryAt, lastError } | null` to every resource
on the wire, so `hobby ls --json`, Studio and MCP see it, and `hobby ls`
prints it after the resource (`renderResourceLine`,
`packages/cli/src/cli/output.ts`):

```
primary  postgres  failed  port 15432  (wake refused, retry in 3m 12s: docker start failed)
```

`lastError` is the failed start's message passed through `redactWakeError`,
which replaces the userinfo of any URL with credentials and the value of any
`password=`, and caps it at 300 characters. No start error is known to carry a
secret today (the Docker runtime's errors keep stderr in the hint, which is
never read here), but a kind handler may throw anything, and the wire is where
secrets leak from.

The refusal `buildWake` throws names the retry time, relative and absolute,
and still names `hobby logs`. The front doors' own refusal text
(`handleStartup` in `packages/proxy/src/proxy.ts`, `resolveAndWake` in
`packages/proxy/src/http.ts`) says the daemon retries by itself and points at
`hobby ls` for when, because `isWakeRefused` answers a boolean and carries no
time.

## Amendment, 2026-09-28: TLS termination (ADR 0019)

`proxyTls` (`packages/core/src/config.ts`) gives the proxy a certificate.
`handleConnectionInner` (`packages/proxy/src/proxy.ts`) answers `SSLRequest`
with `S` and hands the socket to `startTlsTerminator`
(`packages/proxy/src/tls.ts`), which pipes it to a loopback `tls.createServer`
and returns the decrypted connection to the same handler. A plaintext startup
from a non-loopback peer is refused with 28000; a plaintext CancelRequest is
not. Two Bun gaps shaped this, both measured on Bun 1.3.14 and both passing
under Node: an in-place `tls.TLSSocket` upgrade hangs, and
`setSecureContext` is a no-op. The ADR has the detail.

## Amendment, 2026-10-29: the QA sweep's proxy findings (issues #54, #67, #68)

Three fixes, all in `packages/proxy/src`, all measured by the 2026-10-16 QA
lanes.

**A refused dial to a `running` target is a dead container, and it is woken
(#54).** A Postgres container that died behind the daemon (OOM kill,
`docker kill`) stayed `running` in the store, so neither front door woke it:
the only wake trigger was `state !== 'running'`, and `holdUntilServing`'s
retry (the 2026-09-19 amendment above) only covers a port that accepts and
then closes, the Docker Desktop shape. On OrbStack and a Linux bridge the
port refuses outright, which took the `connectUpstream` throw path straight
to a 57P03 in a few milliseconds, for every connection, until a human ran
`hobby wake`. `holdUntilServing` now marks that result `dialFailed`, and
`handleStartup` answers it on a target that was `running` at entry with
exactly one `wake()` (the same `docker start` plus readiness wait a sleeping
target gets, honouring the daemon's refusal set), a re-resolve, and one more
hold. The HTTP router does the same on `ECONNREFUSED` from a `running`
target, and replays the request when it carried no body; a request with a
body gets a 502 that says the app has been restarted, since its body has
already gone into the dead connection. The paragraph above that says "the
HTTP router got no equivalent" is superseded for this one shape.

**No idle cap on a response that has started (#67).** `upstreamTimeoutMs`
was passed as the socket timeout of every upstream request, so any response
quiet for 10s was cut with a 502, and once the headers had been forwarded
that 502 had nowhere to go and the client hung until its own timeout. The
timeout now bounds only the wait for the response headers, at 120s by
default (`DEFAULT_UPSTREAM_TIMEOUT_MS`), and is cleared the moment they
arrive. An upstream that dies mid-body destroys the client connection
rather than ending it, so a truncated body never looks complete.

**A half-closed upgrade is torn down (#68).** `socket.pipe(upstream)` only
half-closes: a client's FIN ended the upstream's write side and nothing
more, and an upgrade handler that does not end its own side on a peer's
close (most do not) left the pair open with its activity handle held. The
app never slept, and the daemon hung on SIGTERM waiting for sockets the
HTTP server no longer owned, because `closeAllConnections` does not know
about a socket handed to `'upgrade'`. Either side's `'end'` now tears both
down, the pair carries TCP keepalive so a peer that vanished without a FIN
is noticed by the kernel, and `HttpRouter.closeUpgraded` destroys every
detached socket on shutdown.

## Amendment, 2026-10-29: a second postgres, and apps through the proxy (issues #66, #53)

**The dotted segment names a resource first (#66).** `hobby pg create` on a
project that already had a postgres used to cut off both: `resolve` threw
`ambiguous_target` for the bare project name, and the second resource's
connection string was identical to the first's (every resource's
`config.database` is the project name), so nothing routed anywhere. Now
`ProxyDeps.resolve(project, segment)` is handed the segment after the first
dot, and the daemon's `createProxyDeps` (`packages/cli/src/daemon/context.ts`)
resolves it in this order: a resource with that name, then, for a bare key,
the project's only postgres or the one named `primary`
(`DEFAULT_POSTGRES_NAME`, what `hobby new` creates). A segment that matches
no resource keeps its older meaning, a database inside the default resource,
substituted on the wire as before; the target's `databaseSegmentIsResource`
tells the proxy which happened, and a resource match puts the resource's own
database on the wire. A project with several postgres resources and no
`primary` is still ambiguous for the bare key, and the error now lists the
dotted forms. `connectionString` (`packages/pg/src/connstring.ts`) renders
the matching key through the proxy: `blog` for `primary`, `blog.analytics`
for anything else (`routingKeyFor`, `packages/core/src/names.ts`). A resource
and an inner database sharing a name resolve as the resource.

The "Routing key" paragraph above still holds for the bare form. The cost it
names, that database names are unique across the box, now also applies to
resource names within a project's dotted keys.

**Apps and workers connect through the proxy (#53).** An app's `DATABASE_URL`
and a worker's Hyperdrive string pointed straight at the database container
on the project network, so neither passed through here: an app could not
wake its own database (its queries failed with ENOTFOUND while Postgres
slept) and could not keep it awake (nothing counted traffic that bypassed
the activity sensor, so the database slept under an app querying it every
eight seconds). Both now carry
`host.docker.internal:<proxyPort>/<routing key>`, the host's own
container-facing name. On macOS docker routes that name to the host's
loopback, where the proxy already listens. On Linux it resolves, via the
container's `--add-host ...:host-gateway`, to the bridge gateway of the
project's network, and `server.ts` now binds a proxy listener on every
project network's gateway (`proxyGatewayHosts`, and one more on each
network created while the daemon runs), the same addresses and the same
best-effort rule the enqueue listener already used. Those gateway listeners
allow plaintext with TLS configured, as loopback does: the traffic never
leaves the box, and the app's string carries no `sslmode`. A `proxyHost`
set to a single non-loopback literal on macOS leaves loopback unbound, and
an app on that box cannot reach its database; `tailnet` and `all` both
include it.

The compose file `hobby eject` emits still points apps at the database
service by name, since there is no proxy in an ejected stack.

## Amendment, 2026-10-30: a crash on boot fails fast, a deploy clears the refusal, errors name the resource (issues #55, #57, #58)

- **A container that exits before it listens is reported after one poll
  (#55).** `waitListening` (`packages/app/src/readiness.ts`, and the worker's
  own copy in `packages/worker/src/worker.ts`) and `waitReady`
  (`packages/pg/src/readiness.ts`) take a `status` callback, `runtime.inspect`
  in production, consulted after every failed probe; `exists && !running`
  ends the wait with the exit code. The kinds turn that into `wake_failed`
  (not `wake_timeout`: the loopback hint is for a process that is alive)
  with the container's last 20 log lines in the hint. A crash that used to
  cost 30 seconds on deploy and 30 more on the first request now costs one
  poll interval. A wake that genuinely hangs still waits `wakeTimeoutMs`
  (30 s by default, `HOBBY_WAKE_TIMEOUT_MS`), which is issue #56's remaining
  half; the default was deliberately not lowered, since a large app or a
  postgres in crash recovery can legitimately take longer than the 3 second
  cold start target.
- **A successful deploy clears the wake refusal (#57).** `deployResourceRoute`
  calls `clearWakeRefusal` after `deployApp` or `deployWorker` returns, as
  `startResourceRoute` already did for `hobby wake`.
- **Errors name `project/name` (#58).** `ProxyTarget.label` is filled by
  `createProxyDeps` and used by every refusal and wake error the Postgres
  proxy sends; `startPostgres` names `postgres project/name` rather than the
  resource UUID. App and worker errors already named the container.

## Amendment, 2026-11-17: Neon's serverless driver on the proxy port (issue #155)

`@neondatabase/serverless` now works against a Hobbyist Postgres, in both of
its modes: `neon()` (`POST /sql`, JSON) and `Pool`/`Client` (the Postgres
protocol inside a WebSocket). The protocol was taken from Neon's proxy, which
is Apache-2.0 (`proxy/src/serverless/sql_over_http.rs`, `json.rs`,
`websocket.rs`, `mod.rs`), and checked against the built source of the driver,
pinned at 1.2.0 as a devDependency of `packages/proxy`. User guide:
`site/src/content/docs/docs/guides/serverless-driver.md`.

**Same port, told apart by its first byte.** `handleConnectionInner`
(`packages/proxy/src/proxy.ts`) sniffs the first chunk of an accepted
connection (`sniff`): an uppercase ASCII letter is an HTTP method, `0x16` is a
TLS ClientHello. Neither can begin a startup packet, whose first byte is the
high byte of a length `parseStartup` accepts, so nothing a Postgres client
sends changes path. HTTP goes to the serverless front
(`createServerlessFront`, `packages/proxy/src/serverless.ts`). A ClientHello
with no SSLRequest goes to the same `TlsTerminator.relay` an SSLRequest gets,
and the decrypted connection is sniffed again. So the endpoints bind exactly
where `proxyHost` binds (ADR 0017), use the `proxyTls` certificate (ADR 0019),
and need no setting, listener or route of their own. The daemon is
unchanged, since `startPgProxy` builds the front itself. Nothing was added
to the daemon API (ADR 0008), and Caddy is not involved (ADR 0009). Caddy's
https was the alternative for TLS. It was not taken, for the reasons ADR 0019
gives for not sharing Caddy's certificate.

**Every request is a proxied connection.** Each WebSocket and each `/sql`
request becomes one side of an in-memory socket pair (`socketPair`,
`packages/proxy/src/socket-pair.ts`). The other side is handed to
`handleConnectionInner` exactly as an accepted socket, with no TLS and no
front. Routing by database name, wake-on-connect, the wake refusal backoff,
`holdUntilServing`, cancel key minting and the ActivityTracker all apply
unchanged, with no second implementation. `/sql` (`handleSql`,
`packages/proxy/src/sql-over-http.ts`) uses the `pg` package over that pair,
with **one connection per request and no pool** (Neon pools). A request that
names `application_name=hobby` gets `hobby-serverless-driver`, so the
hibernator's guard (`HOBBY_APPLICATION_NAME`, `packages/pg/src/activity-guard.ts`)
never ignores driver traffic. `packages/cli/test/serverless-driver.test.ts`
holds the two packages' spellings to each other. A client that disconnects
mid-query has its query cancelled through the proxy's own cancel routing.

**"Auth passes through" has an exception here.** `/sql` receives the password
in `Neon-Connection-String`. The driver's default `pipelineConnect:
"password"` sends a cleartext PasswordMessage before the server asks, which
a SCRAM Postgres rejects. So `PipelinedPasswordShim`
(`packages/proxy/src/pipelined-auth.ts`) holds that early password, answers
SCRAM-SHA-256, MD5 or cleartext for the client, and shows the client the
AuthenticationOk it expects, as Neon's proxy does. A client that does not
pipeline is passed through untouched, and its SCRAM runs end to end. The
password is held in memory for one handshake and never logged.

**TLS is stricter than for TCP.** Over TCP, SCRAM keeps the password off the
wire even without TLS. Here it does not. So a request from another machine is
refused with a 403 unless it arrived over TLS, **whether or not `proxyTls`
is set**. Loopback and the gateway listeners count as this machine. Before
this change, an HTTP request line on this port got a `08P01` from
`parseStartup`. Now it gets an HTTP answer. A ClientHello with no proxy
certificate still gets `08P01`.

**Two Bun gaps shaped the plumbing**, both measured on Bun 1.3.5 and 1.3.14
on 2026-11-17, and both working under Node:

- `http.Server.emit('connection', socket)` hangs.
- A node:http `'upgrade'` socket silently drops every byte written to it,
  through `write` and through `pipe` alike.

So the request head is read off the raw socket (`parseHttpHead`,
`packages/proxy/src/websocket.ts`), a WebSocket handshake is answered there,
and framing is the hand-written RFC 6455 subset in the same file. ADR 0006
asks a runtime dependency to justify itself, and `ws` sits on the same broken
event. Any other request is piped to an internal node:http server on an
ephemeral loopback port, the tls.ts pattern. Before any byte is sent, the
relay's local port is recorded with whether the request may proceed. Node's
undici does send a WebSocket upgrade down a kept-alive connection that a
`/sql` request just used (measured). That upgrade reaches the internal server,
which takes the client's socket back from the relay (`RelayEntry.takeOver`)
and answers it on the raw socket.

**The second gap probably affects the HTTP router** (`packages/proxy/src/http.ts`,
`handleUpgrade`), which proxies app and worker WebSockets through node:http's
`'upgrade'` event. That was not tested here and is not fixed by this change.
It needs its own issue.

**Verified.** `packages/proxy/test/serverless.test.ts` drives the real driver
(`neon`, `transaction`, `Pool`, `Client`, `poolQueryViaFetch`, both
`pipelineConnect` settings, https, the 403) through `startPgProxy`. It runs
against `test/fixtures/fake-postgres.ts`, which speaks SCRAM and both query
protocols, with no Docker. `websocket.test.ts` covers the framer, the shim's
other paths and the value conversion. Both pass under `node --test` and under
`bun test` on Bun 1.3.14. By hand, the same flows ran against a real
`postgres:18-alpine` (SCRAM, as shipped) under Node and Bun:

- wake on first request and activity counted
- transaction, a 42P01 error and a wrong password
- a prepared statement refusing two commands
- cancel during `pg_sleep`
- `https://` and `wss://` with a throwaway certificate, with plaintext refused

**Not done, not measured.**

- The per-request cost of `/sql` over a network is not measured.
- No JWT (`authToken`).
- The `Neon-Pool-Opt-In` header is ignored.
- `sslnegotiation=direct` for libpq is still not supported. Its ClientHello
  now reaches the terminator, but no ALPN `postgresql` is offered, so libpq
  aborts as before.
- A daemon shutdown with `wss://` sessions open waits out tls.ts's existing
  one-second grace for the relayed socket.
- Nothing has run through a real daemon yet.

## Amendment, 2026-11-17: per-project IP allowlists

**What.** A project can carry an allowlist of IPv4 and IPv6 addresses and CIDR
ranges (`Project.allowlist`, a JSON column added by `migrate` in
`packages/core/src/store.ts`). It decides which client addresses this proxy
accepts for every postgres in the project. Three states:

- `null`: no restriction. Every project before this, and every new one.
- `[]`: this box only.
- a list: those addresses and ranges, plus this box.

`hobby allow [ls|add|rm|off]`, the MCP tools `hobby_allow_*` and
`GET/POST/DELETE /v1/projects/:name/allowlist` (`setAllowlistRoute` in
`packages/cli/src/daemon/routes.ts`) are the one control surface. Removing the
last entry leaves `[]`, never `null`: taking an address away must not open the
project to every address. Only `off` (DELETE) lifts it. Inspired by Xata's
gateway filter (`services/gateway/ipfiltering/filter.go`, Apache-2.0), which
also treats an enabled empty list as deny-all and an unparseable client
address as refused. No code is copied; parsing and matching are our own, on
bigints, in `packages/core/src/allowlist.ts`.

**The box is always allowed.** A connection is exempt when its peer is
loopback, or when the address it dialed is loopback or a docker network
gateway the daemon knows (`sameBox` in `startDaemon`,
`packages/cli/src/daemon/server.ts`, built from `proxyGatewayHosts` and grown
by `addProxyGateway`). Judged by the dialed address, not the listener, because
with `proxyHost: "all"` there is no gateway listener and container traffic
arrives on the 0.0.0.0 one from container addresses no allowlist would name.
On Docker Desktop and OrbStack, an app reaching `host.docker.internal` lands
on the host's loopback listener, which counts. The box's own apps and workers
are the same box, so restricting them would only break them.

**Where it is enforced.** `allowedOrRefuse` in `proxy.ts`, on every path:

- *Startups*, plain TCP, TLS, and the serverless driver's `/sql` and
  WebSocket (each an in-memory connection into the same handler).
  `handleStartup` checks first, with the routing key's project, before
  `resolve`. So a refused address never learns what the project holds,
  never calls `wake`, and never reaches `activity.open`: it cannot wake a
  sleeping database or keep one awake. The answer is `FATAL 28000` (what
  Postgres sends when `pg_hba.conf` has no line for the client), naming the
  project and the client address. On `/sql` that FATAL becomes HTTP 403 with
  the usual Neon-shaped JSON (`errorJson` in `sql-over-http.ts` maps 28000 to
  403). A WebSocket has already upgraded before the startup packet names a
  project, so its client gets the FATAL inside the session, which the driver
  reports as an ordinary error with code 28000.
- *CancelRequests* are checked too, against the project the minted key's
  session was opened for (`CancelRoute.project`). Refused cancels close
  silently, as an unknown key does. A cancel carries no credentials, but it
  does interrupt the project's queries, and an address the project refuses
  should not be able to.
- A lookup that throws refuses.

**The client's real address.** Through a plain TCP connection it is the
socket peer. Two paths lost it before this change, and both now carry a
`ClientAddress` (`packages/proxy/src/access.ts`) read from the socket the
outer server accepted:

- the TLS terminator dials its inner server from 127.0.0.1, so `tls.ts`
  records the context against the relay's local port before the handshake,
  the same trick `serverless.ts` already used for its own relay;
- the serverless front hands the proxy a `PairSide` with no address at all,
  so `connectToProxy` takes the client alongside the stream.

A connection whose record is missing is judged as an unknown address, which
no list matches.

**What it does not cover.** The proxy sees the TCP peer. A tunnel or
forwarder on the box (`ssh -L`, `tailscale serve`, a local TCP proxy) makes
every client look like loopback, and loopback is exempt. There is no PROXY
protocol support. The HTTP router for apps and workers, Studio (ADR 0008) and
the daemon API (ADR 0018) are not filtered by this; it is the Postgres port
only. Sessions already open when a list changes are not ended. A snapshot
restored into a new project copies the allowlist of the project it was taken
from as that project is now (`restoreSnapshot` in `snapshots.ts`); the
manifest does not record one, so a snapshot restored after its project was
deleted comes back open.

**Branches inherit at branch time.** A branch is its own project, holding the
same data and passwords as its source, so `branchProject` (`branch.ts`) copies
the source's list into it. A copy, not a link: each list changes on its own
afterwards, and `hobby reset` leaves the branch's own list alone.

**Logging.** Each refusal is reported through `ProxyDeps.onAccessRefused`;
the daemon writes at most one line per address per minute to its log, with a
count of what it folded in (`RefusalLimiter` in `access.ts`, one per daemon,
shared by every listener). The tracked-address map is capped at 1024; past
that, untracked addresses share one bucket, so a scanner sweeping an IPv6
range cannot grow it. No user name or credential is logged.

**ADR fit.** ADR 0017 (where the proxy listens) is unchanged: an allowlist
narrows who may use a bind, it never widens one, and loopback stays the
default. ADR 0019 (TLS) is unchanged, and its plaintext rule still runs
before the allowlist. It lists rate limiting and blocking scanners under what
it does not do, and defers login throttling. This is neither: it is a static,
operator-written address filter, with no counting of attempts. ADR 0008
(Studio) and ADR 0018 (the remote CLI) are about other listeners and are
unaffected. ADR 0021 is unaffected: `/sql` and WebSocket requests are checked
inside the same handler, and a refused one is turned away before any
password the proxy holds is used.

**Verified.** `packages/proxy/test/allowlist.test.ts` drives `startPgProxy`
against the fake SCRAM Postgres for TCP, TLS (from `::1`, so the relay's
127.0.0.1 cannot pass for the client), cancels, `/sql` and WebSocket. It
asserts no resolve, no wake and no activity on a refusal. Parsing and
matching are in `packages/core/test/allowlist.test.ts`; routes, deps,
logging, branch inheritance and the CLI in `packages/cli/test/allowlist.test.ts`.

**Not verified.** Nothing here has run through a real daemon, against a
client on another machine, or under Bun. The same-box rule for container
traffic on Linux, and on Docker Desktop or OrbStack, is reasoned from the
code paths above, not measured.

## Amendment, 2026-11-18: new connections wait through a deliberate restart (Phase A3)

**Built.** Phase A3 of `docs/availability/specs/2026-11-18-standby-pair-design.md`
(on the `docs/adr-0023-standby-pair` branch, not yet on main). When the
daemon restarts or recreates an awake database on purpose, a new connection
through the proxy waits for it and is then served by the restarted
container, instead of being refused. Sessions that were open at the stop
still end; nothing carries a session across a Postgres restart.

**The mechanism is the existing snapshot fence, not a new state.** The spec
proposed marking the resource `restarting`. That was not needed: the proxy
already sends every connection to a non-`running` target through
`deps.wake`, and a `running` target whose dial is refused through one more
(`handleStartup` in `packages/proxy/src/proxy.ts`), and `buildWake`
(`packages/cli/src/daemon/context.ts`) already waits on a project hold taken
with `holdProjectAsleep` before it starts anything, then returns at once if
the operation left the resource `running`. A restart drives the store
through `stopping`, `sleeping`, `starting` (`stopPostgres`, `startPostgres`
in `packages/pg/src/postgres.ts`), so every connection in that window lands
on the fence. The proxy itself is unchanged.

**What was already true, and what is new.** `applyPostgresSettings`
(`packages/cli/src/daemon/pg-settings.ts`) took that hold since 2026-11-17,
so a connection during a settings change already waited and was served:
the new tests below pass against the code before this change too. What this
change adds:

- **A failed restart answers the waiters.** The release function a hold
  returns (`ReleaseHold`) now takes the resources the operation stopped and
  could not start again, each with its failed start's message. A wake
  waiting on that fence throws `heldRestartFailed` (`wake_failed`,
  "`blog/primary` was restarted by a settings change, and did not come back:
  ...") as soon as the hold is released, instead of making another start
  attempt of its own and taking up to `wakeTimeoutMs` to fail again.
  `applyPostgresSettings` reports its resource when it stopped it and it is
  not `running` at the end (both the new and the rolled-back start failed).
  `resume` (`packages/cli/src/daemon/snapshots.ts`) takes an optional map it
  fills the same way, used by `takeSnapshot`, `restoreSnapshot` in place,
  `resetBranch` and `cloneSourceAtRest`.
- **A branch or reset quiescing an awake source holds it.**
  `cloneSourceAtRest` (`packages/cli/src/daemon/branch.ts`, used by
  `branchProject` and `resetBranch` for the parent) takes `holdProjectAsleep`
  on the source when anything in it is running, from before the stop to
  after the resume. Before, a client connecting mid-clone woke the source,
  which `assertAtRest` then caught and discarded the whole branch. A source
  that was asleep is still not held.
- **The hibernator leaves a held project alone** (`isProjectHeld`, checked
  twice in `tick`, `packages/cli/src/daemon/hibernator.ts`), so it cannot
  stop a database in the middle of an operation's own stop and start.
- **Holds are named.** `holdProjectAsleep` and `holdProjectExclusive` take
  what the operation is ("a settings change", "a branch", "a reset", "a
  snapshot", "a restore", "an import", "the removal"), and a second hold is
  refused as "a settings change of blog is already in progress" rather than
  always "a snapshot or restore".

**Every path converges.** Plain TCP, TLS (the terminator hands the decrypted
stream back to `handle` with `encrypted: true`) and the serverless driver's
`/sql` and WebSocket `/v2` (`connectToProxy` hands an in-memory socket pair
to the same `handle`) all reach `handleStartup`, which calls `deps.resolve`
and `deps.wake`. The HTTP router (`http.ts`), the query route and `hobby
wake` (`waitForProjectAwakeable`) wait on the same fence.

**Bounds and deadlock.** The proxy races the whole wake, fence included,
against `wakeTimeoutMs` (default 30 s, `HOBBY_WAKE_TIMEOUT_MS`), so a
restart that outlasts it ends the wait with "wake timed out". The operation
never waits on its own fence: it stops and starts through the kind handler
(`handler.stop`, `handler.start`, `resume`) and never through `buildWake`.
An operation that leaves a resource asleep (a settings change on an asleep
database, a branch of an asleep source) starts nothing; only a client's own
connection wakes it afterwards, which is ordinary wake-on-connect.

**Operations covered:** `hobby pg config set|unset` on an awake database,
including `--allow-pause` on a pinned project; `hobby branch` and `hobby
reset` pausing an awake source or parent (with `--allow-pause` too); `hobby
reset`'s quiesce of the branch itself, `hobby snapshot` (quiesced) and
`hobby snapshot restore --in-place` (all three held before; now they also
report failed resumes to waiters).

**Deliberately not covered:** `hobby pg ext add|rm` (runs `CREATE
EXTENSION` over SQL, or only edits the declaration; no restart; a preload
change goes through settings); `hobby sleep` and `hobby eject --release`
(they mean to leave it stopped, and a connection afterwards wakes it, or is
refused for a released project, as before); `hobby snapshot --online` and
`hobby import` (`holdProjectExclusive`, nothing is restarted); expiry of a
branch (`expiry.ts`, holds it while removing it, and a waiter then gets
`resource_not_found` from `buildWake` because the resource is gone); daemon shutdown (the proxy closes first); an app or
worker env change (`routes.ts`, not Postgres, and not behind this proxy).

**Verified.** `packages/cli/test/restart-wait.test.ts` drives the real
proxy, `createProxyDeps`, `applyPostgresSettings` and `cloneSourceAtRest`
against a fake runtime whose stop and start take a stand-in Postgres off
and back onto the resource's port: a connection during the stop and during
the start is held and then gets `AuthenticationOk`; one waiting on a restart
whose new and rollback starts both fail gets the error within
milliseconds and starts nothing; one waiting past `wakeTimeoutMs` gets
"wake timed out" inside the budget; a branch holds the awake source's
clients and serves them after resume. `packages/proxy/test/serverless.test.ts`
covers `/sql` through the real `@neondatabase/serverless` client, with the
store saying `stopping` and with it still saying `running` while the port
refuses, and a failed restart. `packages/cli/test/hibernator.test.ts` covers
the hibernator skip.

**Not verified.** Not run against real Docker. In particular not measured:
how often a client lands in Postgres's own shutdown window (`57P03` "the
database system is shutting down", retried by `holdUntilServing` against
the old port) versus the fenced window, and whether a TLS or WebSocket
client's own connect timeout fires before a long restart finishes.
