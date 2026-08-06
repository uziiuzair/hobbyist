# `docs/proxy/` wake-on-connect wire proxy

**Status:** PROPOSED. Nothing built. **This is the keystone.**

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
client opens TCP
  -> proxy reads the startup packet, extracts user and database
  -> proxy resolves which project that is
  -> project awake?   yes: forward the connection
                      no:  start it, wait for readiness, then forward
  -> client sees one slow connection, then normal Postgres
```

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

## Open questions

- **What is an acceptable cold start?** This is the number the whole project is
  judged on. Set a target before building, measure honestly, and publish it.
- What does a client library do when the first connection takes several seconds?
  Some ORMs and pool managers have connect timeouts well under a typical container
  start. This is the most likely source of "it does not work" reports.
- SSL termination: at the proxy, passthrough, or both.
- Auth: passthrough to Postgres, or does the proxy need its own view of users in
  order to route before authenticating.
