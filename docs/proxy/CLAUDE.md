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
  running?  -> dial upstream, replay startup packet, splice sockets
  sleeping? -> daemon.wake(resource), poll readiness, then as above
  failed?   -> send a real Postgres ErrorResponse, never a dropped socket
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
