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
does not change what your consumer will receive. A message that is out with the
consumer is marked `leased`, and one that is not yet visible (a delayed send, or
a retry waiting out its delay) is marked `delayed` with the time until it
becomes visible. `purge` and `rm` both confirm before destroying anything, and
both take `--yes`.

`hobby queue ls` shows each queue's retention and, under a queue with a
consumer, the tuning in force: batch size and timeout, retries and retry delay.
A key your `wrangler.toml` does not set shows the default. `hobby queue set
--retention` echoes the value it applied.

## Binding a consumer

A worker becomes a consumer through its own `wrangler.toml`, the same as on
Cloudflare:

```toml
[[queues.consumers]]
queue = "jobs"
```

Deploy the worker and the binding takes effect. `hobby queue ls` shows the
consumer, or says there is none. Each deploy replaces the stored tuning with
what the manifest says, so deleting `retry_delay` or `dead_letter_queue` from
`wrangler.toml` and redeploying puts the default back.

## Handler time limit

A `queue()` handler has **30 seconds** to answer a batch. The daemon's delivery
hop (`DELIVERY_TIMEOUT_MS` in `packages/queue/src/deliver.ts`) gives up after
that, counts the attempt as failed, and the batch is retried after
`retry_delay`, or dead lettered once `max_retries` is exhausted. The handler
inside the container is not interrupted, so a handler that finishes at 40
seconds has done its work and will then see the same batch again. Cloudflare
allows 15 minutes; the limit here is tighter because one daemon drains every
queue on the box in turn, and one hung consumer must not stall the others.

Every failed delivery writes a line to the daemon log naming the queue and the
reason (a timeout, a refused connection, a handler that threw), and so does
every dead letter and every retention sweep. `hobby logs` on the daemon is
where to look when a message is not arriving.

## Retries and dead letters

`retry_delay` is counted from the moment the delivery result came back, not from
when the batch was handed out, so a slow handler or a cold start does not eat
into it. A message that exhausts `max_retries` moves to the `dead_letter_queue`
named in the consumer config, keeping **the same id**, its original enqueue time
and the number of attempts that failed; `hobby queue peek` on the dead letter
queue shows all three. Its retention clock restarts when it lands there, so a
message that spent most of its life failing is not swept the moment it arrives.
A dead letter queue cannot be deleted while a consumer still names it as
`dead_letter_queue`; remove that line and redeploy first. Without a dead letter
queue, an exhausted message is dropped, as on Cloudflare.

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

## Retention

Every queue is swept on its retention, whether or not anything consumes it:
dead letter queues and producer-only queues included. The default is four days,
settable from 60 seconds to 14 days with `hobby queue set --retention`.
