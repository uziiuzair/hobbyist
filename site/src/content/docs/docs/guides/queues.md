---
title: Queues
description: Durable messages that survive a sleep, and wake their consumer when they arrive.
sidebar:
  order: 5
---

<p class="state state--starting">works, rough edges</p>

A `queue` holds messages in a sqlite file the daemon owns, outside any runtime.
It is the first thing in this project where **stored state, rather than an
inbound connection, starts a container**: a message arriving for a sleeping
consumer wakes it.

## Why the broker is outside the runtime

If the queue lived inside the worker runtime, a sleeping worker would be a queue
that does not exist: messages sent to it would have nowhere to land, and a
backlog could not accumulate while it slept. Miniflare's own queues are in
memory, which is fine for a dev server and useless here.

Holding messages in the daemon means a backlog survives a sleep, and the arrival
of a message is an event the daemon can act on.
[ADR 0013](/docs/decisions/0013-queues-and-the-broker-outside-the-runtime/).

## Commands

```sh
hobby queue create jobs --project blog
hobby queue ls blog
hobby queue send blog/jobs '{"hello":"world"}'
hobby queue peek blog/jobs --limit 5
hobby queue set blog/jobs --retention 86400
hobby queue purge blog/jobs
hobby queue rm blog/jobs
```

`peek` reads the oldest messages **without leasing them**, so looking at a queue
does not change what your consumer will receive. `purge` and `rm` both confirm
before destroying anything, and both take `--yes`.

## Binding a consumer

A worker becomes a consumer through its own `wrangler.toml`, the same as on
Cloudflare:

```toml
[[queues.consumers]]
queue = "jobs"
```

Deploy the worker and the binding takes effect. `hobby queue ls` shows the
consumer, or says there is none.

## The Linux producer gap

<p class="state state--starting">fixed in code, not yet re-run on a Linux box</p>

This page used to record that `env.MY_QUEUE.send()` from inside a container
failed on Linux, for two reasons that lived in different packages: the
container was handed `http://host.docker.internal:<port>/enqueue` and nothing
mapped that name on Linux, and the daemon's listener only bound the bridge
gateways that existed when it started, so every project created afterwards
missed it.

Both halves are now in the code:

- A producer container, or one bound to a database, is created with
  `extraHosts: [{ name: host.docker.internal, address: host-gateway }]`
  (`packages/worker/src/worker.ts`, `containerSpec`), and `buildCreateArgs`
  (`packages/core/src/docker.ts`) emits it as `--add-host`. On macOS that
  restates the address Docker already provides.
- The queue endpoint grows a listener for a new project's bridge gateway when
  the project's network is created (`queueEndpoint.addHost`,
  `packages/cli/src/daemon/queue-endpoint.ts`, called from
  `packages/cli/src/daemon/server.ts`), instead of taking a snapshot of the
  addresses at startup.

What has been observed: the producer path, retries, dead letters and lease
expiry all ran against real Docker on macOS on 2026-10-19. **No one has yet
re-run the producer path on a real Linux box since the fix**, which is the
platform the bug was about, so this stays marked rough until someone does.
Consuming has worked on both platforms throughout, and so has
`hobby queue send` from the CLI.

## Retention has a gap too

`sweepRetention` runs from the per-queue tick, and that tick only covers queues
with a drainable consumer. A queue with no consumer bound, which includes every
dead letter queue, never gets swept, so messages accumulate there regardless of
the retention you set.
