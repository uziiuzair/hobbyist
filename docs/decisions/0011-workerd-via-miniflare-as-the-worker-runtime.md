# 0011. workerd, via Miniflare, as the `worker` runtime

Status: ACCEPTED
Date:   2026-08-10

## Context

`docs/compute/CLAUDE.md` has said since 2026-08-07 that Phase 2 means "containers,
and only containers": a Next.js app, a Python worker and a Go binary are the same
thing to us, an image that listens on a port. Under that reading, `app` and
`worker` differ only in whether the process serves HTTP or runs to completion.

That reading was set aside. The author's requirement is that a `worker` is a
Cloudflare Worker: `wrangler.toml`, the Workers runtime APIs, the same code that
would deploy to Cloudflare, running on their own box instead.

This is possible in a way it would not have been for most platforms, because
Cloudflare open-sourced the actual runtime. `workerd` is Apache 2.0 and is, in
their own description, "the JavaScript / Wasm runtime that powers Cloudflare
Workers", explicitly intended for self-hosting applications you would otherwise
run on Workers.

Three ways to run it were considered.

**Generate workerd config ourselves.** `workerd serve config.capnp`, with us
emitting the Cap'n Proto config. Verified from `src/workerd/server/workerd.capnp`:
this gives modules, Durable Objects with `durableObjectStorage = (localDisk =
...)`, and bindings for `service`, `durableObjectNamespace`, `hyperdrive`,
`fromEnvironment`, `text`, `json` and `data`. It does not give KV, R2, D1, Queues
or Cache: those binding types exist, but they are `ServiceDesignator` fields
pointing at a service that implements the store, and workerd does not implement
any of them.

**Embed Miniflare.** The `miniflare` npm package, Cloudflare's own, which wraps
workerd and supplies exactly the missing half: KV, R2, D1, Queues, Durable Objects
and Cache, with disk persistence under `resourcePersistencePath`. It is TypeScript,
which matches ADR 0006, and it spawns a real workerd, so the code executing user
Workers is the same code Cloudflare runs.

**Run a plain node container and pretend.** Rejected without much thought. A
Worker running on node is not a Worker, and the compatibility problems would
surface as user-visible bugs in someone else's code.

## Decision

**`worker` runs workerd, via the `miniflare` npm package, in a container we
build.** One workerd process per worker resource.

The container is Bun, plus `miniflare`, plus a small entry script of ours that
reads a manifest generated from the user's `wrangler.toml` and starts Miniflare
listening on `0.0.0.0:$PORT`.

## Reasoning

The deciding property is the storage APIs. A Worker that cannot use KV, D1 or R2
is not the thing the author asked for, and implementing those stores ourselves
would be a project of its own that Cloudflare has already done and published.

The second property is the wrangler manifest. Miniflare's option surface is close
enough to wrangler's configuration that the translation is a mapping rather than
an interpretation, which keeps us honest about a format we do not own.

The third is ADR 0006. Miniflare is TypeScript and runs under our own runtime.
The workerd binary it spawns is a compiled dependency, in exactly the way the
Caddy binary already is under ADR 0009: one language in our source tree, not one
language on the box.

## The objection, stated properly

**Miniflare's own README says it is "not intended for production use" and
describes it as "a lower level API designed for tools creators."** We are
building a tool that runs other people's code, so the second half fits. The first
half is a real warning and it is being overridden.

Reasons this is defensible here specifically, none of which would hold for a
hosted platform:

- The workload is one person's own code on one person's own box. ADR 0002's
  reasoning applies unchanged: every tenant here is the same person.
- The root `CLAUDE.md` states plainly that there is no warranty and no liability,
  and that we do not ship things whose failure mode is someone else getting owned
  or losing data quietly. Miniflare's failure mode is a worker that does not
  serve, which is loud.
- The alternative is not "a supported production runtime". It is "our own
  hand-written capnp config plus our own reimplementation of four storage
  services", which has a worse expected failure rate than Cloudflare's own tool.

## Consequences accepted

- **A dev tool is load-bearing in the request path.** If Miniflare changes its
  API, breaks under sustained load, or leaks over long uptimes, that is our
  problem and there is no support contract behind it.
- **Cold start is a container start, not an isolate start.** One workerd per
  worker was the author's explicit choice over a shared process. The sub-5ms
  isolate figure applies only once the container is warm. A `worker` is therefore
  not meaningfully faster to wake than an `app`, and the spec says so rather than
  implying otherwise.
- **Miniflare owns its own on-disk layout.** The Durable Objects work needs to
  scan Durable Object storage directly, and whether Miniflare lays it out as
  workerd's bare `<uniqueKey>/<id>.sqlite` is unverified. It is an open question
  in the Phase 2 spec and it is blocking for that work, not for this decision.
- **We inherit a compatibility surface we do not control.** `compatibility_date`
  and `compatibility_flags` are Cloudflare's, and a user's Worker behaving
  differently here than on Cloudflare is a bug report we cannot always fix.

## What would have to change to revisit

Two triggers, both measurable rather than aesthetic.

**Cold start.** M10 measures HTTP wake on real hardware. If `worker` misses the 3
second hard ceiling because of Miniflare's own startup cost, the lever is to drop
Miniflare from the runtime path and generate workerd capnp directly, keeping
Miniflare only as the deploy-time translator from `wrangler.toml`. That trades the
storage APIs away, so it is a real loss and not a free fallback.

**Stability under real use.** A Miniflare process that degrades over days of
uptime, rather than failing outright, would be the worst case, because sleep and
wake would mask it: every wake is a fresh process. If that is happening, it will
show up as workers behaving differently from apps under identical load, and the
same lever applies.
