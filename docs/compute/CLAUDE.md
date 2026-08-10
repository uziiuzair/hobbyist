# `docs/compute/` workers and apps

**Status:** IN PROGRESS. **Phase 2.** The design is ratified and filed at
`specs/2026-08-10-phase-2-compute-design.md`, which is the actionable document;
this file remains the scope guard.

**The gate is gone.** Phase 2 used to be blocked until Phase 1 had been in the
author's daily use for 30 consecutive days. `docs/decisions/0010` removed that on
2026-08-10, two days after Phase 1 merged, and records plainly that the gate was
correct and was removed anyway.

Registers two resource kinds, `app` and `worker`, against the same
`ComputeRuntime` interface Postgres already uses.

## Stateless, deliberately

**Phase 2 compute has no persistent local disk.** State lives in Postgres.
Volumes are Phase 3. This is not an oversight: volume lifecycle, backup and
branching interactions are real work, and putting them in the same phase as a new
runtime, a build pipeline and HTTP wake would make the hardest phase harder.

## What "many runtimes work" means

**For `app`, it means containers, and only containers.** A Next.js app, a Python
service and a Go binary are the same thing to us: an image that listens on a
port. We do not ship per-language buildpacks. Bring a `Dockerfile`, or bring an
image.

That is a smaller promise than "Python and JS and many others just work," and it
is the honest version of it.

**For `worker`, it means workerd.** Amended 2026-08-10: a `worker` is not a
container of your choosing running a background process. It is a Cloudflare
Worker, running on Cloudflare's own open-source runtime, configured from your own
`wrangler.toml`. See `docs/decisions/0011`. The container is ours, not yours, and
what you bring is a Worker.

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

The three questions this file has carried since 2026-08-07 are answered in
`specs/2026-08-10-phase-2-compute-design.md` and repeated here in one line each,
because the answers are scope-shaped and belong in the scope guard:

- **HTTP cold start budget:** 1 second target, 3 second hard ceiling, both kinds,
  with a 300ms stretch target for `worker`. Unmeasured until M10, and therefore
  still an assertion.
- **Builds:** on the box, one at a time globally, capped at `--memory=2g` and
  `--cpu-shares=512` so a build always loses to a database serving a query.
- **Eject:** yes, and verified by running it, not by asserting it. A kind that
  cannot be ejected does not ship.

Still open, and both real:

- **Does Miniflare lay Durable Object storage out the way workerd documents it?**
  The Durable Objects work depends on scanning that directory to recover alarm
  deadlines from stopped objects. Unverified.
- **A Durable Object alarm cannot fire inside a stopped container.** Until the
  Durable Objects work lands an external schedule holder, a worker that sets an
  alarm misses it. Written down rather than discovered later.
