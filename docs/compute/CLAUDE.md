# `docs/compute/` workers and apps

**Status:** PROPOSED. Nothing built. **Phase 2.**

**Blocked by a hard gate:** Phase 2 does not begin until Phase 1 has been in the
author's daily use for 30 consecutive days. Not "is finished." Is in use. See
`docs/decisions/0007`, where that gate is the main protection against the failure
mode this project is most likely to hit.

Registers two resource kinds, `app` and `worker`, against the same
`ComputeRuntime` interface Postgres already uses.

## Stateless, deliberately

**Phase 2 compute has no persistent local disk.** State lives in Postgres.
Volumes are Phase 3. This is not an oversight: volume lifecycle, backup and
branching interactions are real work, and putting them in the same phase as a new
runtime, a build pipeline and HTTP wake would make the hardest phase harder.

## What "many runtimes work" means

It means containers, and only containers. A Next.js app, a Python worker and a
Go binary are the same thing to us: an image that listens on a port, or a process
that runs to completion. We do not ship per-language buildpacks in Phase 2.
Bring a `Dockerfile`, or bring an image.

That is a smaller promise than "Python and JS and many others just work," and it
is the honest version of it.

## Wake on request

The sleep wedge is the reason compute belongs here at all. An app that sleeps and
wakes on the first HTTP request is the same mechanism as a database that wakes on
connection, behind one router. **A compute kind that cannot sleep does not
belong in Hobbyist**, because without that it is Coolify with fewer features.

The request path for a sleeping app: client, Caddy, our router, wake, upstream.
Caddy holds the request while the container comes up but never triggers the wake,
which stays in `@hobby.sh/proxy`. See `docs/decisions/0009`.

## In scope

- The `app` and `worker` resource kinds
- Build: from a `Dockerfile` or a prebuilt image
- HTTP wake, and the cold start budget for it, which is a different number from
  the Postgres one and needs setting separately
- Hostname allocation per app, and custom domains via Caddy on-demand TLS
- Logs, and enough of them to debug a deploy without SSH
- Scheduled workers, if and only if daily use demands them

## Out of scope

- Buildpacks, language autodetection, framework-specific magic
- Global edge execution. One box.
- Persistent volumes, which are Phase 3
- Multi-node scheduling, autoscaling, replicas

## Open questions

- What is the HTTP cold start budget? An app is not a database, and a browser
  waiting several seconds for a page is a worse experience than an ORM waiting
  for a connection.
- Where do builds happen, and what stops a build from starving the box that is
  also serving a database?
- Does `hobby eject` on an app emit its `Dockerfile` and Caddy config, and does
  the result actually serve? If not, the ADR 0003 promise has leaked.
