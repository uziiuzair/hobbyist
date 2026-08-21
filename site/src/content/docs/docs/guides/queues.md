---
title: Queues
description: Durable messages that survive a sleep, and wake their consumer when they arrive. Includes the one thing here that is openly broken on Linux.
sidebar:
  order: 5
---

<p class="state state--failed">consuming works. producing is broken on Linux</p>

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

<p class="state state--failed">known broken</p>

**`env.MY_QUEUE.send()` from inside a container fails on Linux.** Unimplemented,
not untested.

`packages/worker/src/worker.ts` hands every producer container
`http://host.docker.internal:<port>/enqueue`. macOS resolves that name. Linux
does not, unless the container was created with
`--add-host=host.docker.internal:host-gateway`, and nothing passes that flag:
`buildCreateArgs` (`packages/core/src/docker.ts`) never emits `--add-host`, and
`ContainerSpec` (`packages/core/src/runtime.ts`) has no field for one.

The daemon's own half is correct. It binds the project bridge gateway on Linux.
The two halves live in different packages and never meet.

**Consuming works on both platforms.** Sending from the CLI
(`hobby queue send`) works on both platforms. It is specifically producing from
inside a container on Linux that fails, which is the five dollar VPS this
project is aimed at.

Found by reading the code during a whole-branch review, after every end-to-end
run had passed on macOS. The fix is to add extra hosts to `ContainerSpec` and
emit the flag, or to resolve the gateway address into the URL at container
start, and it is
[one of the most useful contributions available](/docs/contributing/).

## Retention has a gap too

`sweepRetention` runs from the per-queue tick, and that tick only covers queues
with a drainable consumer. A queue with no consumer bound, which includes every
dead letter queue, never gets swept, so messages accumulate there regardless of
the retention you set.
