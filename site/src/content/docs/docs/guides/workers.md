---
title: Workers
description: Cloudflare-style Workers on workerd, with the bindings that survive a sleep and the ones that do not exist.
sidebar:
  order: 3
---

<p class="state state--starting">works, rough edges</p>

A `worker` runs your Worker script on workerd, the same runtime Cloudflare runs,
driven through the Miniflare package. Cold start measured at p50 299ms, p95
321ms on an Apple M5 Pro, 2026-08-10.

## Deploy

```sh
cd ./my-worker
hobby deploy
```

A `wrangler.toml`, `wrangler.jsonc` or `wrangler.json` in the directory is what
makes it a worker rather than an [app](/docs/guides/apps/). Your existing
wrangler manifest is read directly; there is no second config format to learn.

## What is honoured, and what is ignored

Your manifest is for a platform with regions, tiers and a global network. This
is one box. Rather than fail on the keys that cannot mean anything here,
`packages/worker/src/manifest.ts` reads what it can and reports the rest as
explicitly ignored, with the reason.

For example `queues.consumers.max_concurrency` is ignored and honoured as 1,
because there is one box and one consumer container. A dead letter queue named
by something other than a string queue name is ignored, and the consumer ends up
with none.

Read the ignored list after your first deploy. A silently dropped setting is the
failure mode this is designed to avoid.

## Bindings

| Binding | State |
|---|---|
| Durable Objects | Works, and [alarms survive a sleep](/docs/guides/durable-objects/) |
| KV, R2, D1, Cache | Work, persisted under the resource's `state` directory |
| Queues, consuming | Works. A message wakes a sleeping consumer |
| Queues, producing | **Broken on Linux.** [Why](/docs/guides/queues/#the-linux-producer-gap) |
| Hyperdrive | Works, pointed at a [Postgres](/docs/guides/postgres/) resource in the same project |

## Where state lives

```
~/.hobby/projects/blog/api/
  bundle/    the built script and the manifest generated from your wrangler file
  state/     KV, R2, D1, cache
  do/        Durable Object sqlite, one directory per namespace
```

Each namespace directory also holds Miniflare's own `metadata.sqlite`, which is
not an object.

## The runtime, honestly

Miniflare's own documentation says it is a development tool.
[ADR 0011](/docs/decisions/0011-workerd-via-miniflare-as-the-worker-runtime/)
runs it as a server anyway, records that this is what it is doing, and names the
fallback: drop Miniflare from the runtime path and generate workerd capnp
configuration directly, at the cost of the KV, R2 and D1 storage APIs.

It is pinned to `4.20260730.0`, because npm's `latest` is a 5.x alpha.

Two things learned by running it, worth knowing if you are debugging a build:

- **Miniflare does not work under Bun.** It asserts on a control pipe file
  descriptor that Bun's `child_process` does not provide. The worker image is
  therefore two stages: Bun builds, Node runs.
- **workerd ships no musl binary.** On Alpine it fails with an `ENOENT` on the
  workerd binary, which reads like a missing file and is a missing platform.

## Eject

```sh
hobby eject blog
```

You get the built bundle, the manifest, and the storage directories. A worker is
not as portable as a Postgres data directory, because workerd is the thing
running it, but nothing is held hostage.
