# `docs/queues/` the broker outside the runtime

**Status:** Built, wired into the daemon, and **verified end to end against real
Docker** on 2026-08-14: three messages queued before a sleep were still on disk
with the container stopped and were all delivered on wake, and a sleeping
consumer was woken by a message with no HTTP request of any kind. See
`research/2026-08-14-queues-survive-sleep.md`. The spec is
`specs/2026-08-13-queues-design.md`; the evidence it rests on is
`research/2026-08-13-miniflare-queues-are-in-memory.md`. See
`docs/decisions/0013` for why this capability exists at all. **Phase 2.**

Registers the `queue` resource kind: **one resource is one queue**, which is one
SQLite file the daemon owns. Messages are rows inside it, not resources.

## The one thing this capability is for

**Holding messages somewhere that stopping a container does not destroy.**

Queues are already reachable without this folder. `packages/worker/src/manifest.ts:172`
parses `queues.producers` and `queues.consumers`, and
`packages/worker/src/runtime-image.ts:77-78` hands them to Miniflare, whose
broker keeps its backlog in memory by its own admission. So a worker with a
queue works until it sleeps, and then the messages are gone with no error
anywhere. That is the problem this capability exists to remove, and it is a
data-loss problem before it is a feature request.

The second half follows from the first. Once messages live outside the runtime,
a message arriving for a sleeping consumer can **wake** it. That makes a queue
the first thing in the project where stored state, rather than an inbound
connection, is what starts a container.

## The seam

**The broker asks, the engine acts.** This package never starts or stops a
container. It decides a batch is ready and calls `wake(resourceId)`, exactly as
`packages/proxy` and `@hobby.sh/do` do. That is what keeps the delivery logic
testable against a fake with no Docker and no workerd in the loop.

## What belongs here

- The durable broker: storage layout, batching, leases, retries, dead letter
  queues, delay and retention.
- The wake rule for a sleeping consumer, and the guard that stops a worker being
  slept mid-batch.
- The transport between a container and the daemon, and the platform facts that
  constrain it.
- The `queue` resource kind's lifecycle: create, list, peek, purge, destroy, and
  what `hobby eject` owes a backlog.
- Conformance with Cloudflare's semantics, and where we knowingly differ.

## What does not belong here

- **The worker runtime.** workerd, Miniflare, the image, the bundle and the
  build are `docs/compute/`. This folder consumes that runtime and does not
  describe it.
- **Durable Objects.** The alarm mirror and the object catalog are
  `docs/durable-objects/`. The two capabilities share a shape and share no code
  beyond the wake seam, and the pattern argument belongs in ADR 0013 rather than
  being restated here.
- **Anything that makes a queue a distributed system.** Partitions, consumer
  groups, multi-node fan-out, ordering guarantees, exactly-once. One box.
- **The HTTP pull API.** Ruled out in ADR 0013. If it is ever built it gets its
  own ADR first, because it is a second protocol and not an extra endpoint.
- **General purpose job scheduling.** Cron, retries with arbitrary policies,
  workflow orchestration. A queue delivers messages to a consumer. Anything that
  starts describing itself as a workflow engine is somebody else's project.

## The measurement this capability owed, and now has

Both taken on 2026-08-14, ten samples each, on an Apple M5 Pro / macOS 26.3.2 /
OrbStack (Docker server 29.4.0, linux/arm64) / APFS. Full method, verbatim
output and the decomposition are in
`research/2026-08-14-queues-survive-sleep.md`.

| Number | p50 | p95 |
|---|---|---|
| **Enqueue latency**, `send()` inside the container to the row committed on the host | 1 ms | 12 ms |
| **Wake to first delivery**, default consumer config, one message | 1569 ms | 1728 ms |
| **Wake to first delivery**, batch already full so no batching wait | 514 ms | 600 ms |

The p95 on enqueue is entirely the first send through a cold binding; steady
state is 0 to 1 ms.

**Read the second and third rows together, because the difference between them
is the whole story.** The wake itself, container cold start and two-port
readiness probe included, is 514 ms p50, inside the project's 1 second target.
The extra second in the default case is `max_batch_timeout`, which defaults to
1 second: `isBatchReady` (`packages/queue/src/broker.ts`) does not consider a
lone message a ready batch until it has waited that long. So the default
configuration cannot beat 1 second for a single message by construction, and
`max_batch_timeout = 0` in a wrangler file is the knob. Neither figure is
anywhere near the 3 second ceiling.

Every one of these is from a Mac, like every other measurement in this repo.

## Follow-ups, most consequential first

- **THE PRODUCER PATH DOES NOT WORK ON LINUX.** Not untested: unimplemented on
  the container side. `packages/worker/src/worker.ts` hands every producer
  container `http://host.docker.internal:<port>/enqueue`, which macOS resolves
  and Linux does not unless the container was created with
  `--add-host=host.docker.internal:host-gateway`. Nothing passes that flag:
  `buildCreateArgs` (`packages/core/src/docker.ts`) never emits `--add-host` and
  `ContainerSpec` (`packages/core/src/runtime.ts`) has no field for one. The
  daemon's side is right (it binds the project bridge gateway on Linux); the two
  halves live in different packages and never meet. `env.MY_QUEUE.send()` fails
  DNS on the five dollar VPS this project is aimed at. Fix: add extra hosts to
  `ContainerSpec` and emit the flag, or resolve the gateway IP into the URL at
  container start. Found by whole-branch review 2026-08-14, after every
  end-to-end run passed on macOS.

- **Retention never sweeps a queue with no drainable consumer, which includes
  every dead letter queue.** `sweepRetention` has exactly one caller,
  `tickOneQueue` (`packages/queue/src/tick.ts`), and `drainableQueues`
  (`packages/cli/src/daemon/queues.ts`) excludes any queue whose consumer is
  null, undeployed or released. A dead letter queue is auto-created with
  `consumerResourceId: null`, so **dead letters are kept forever**. Three places
  claim otherwise, including this file's own earlier wording and the comment on
  `QueueConfig`. No data is lost and the depth is visible in `hobby queue ls`,
  but it is unbounded disk growth on a one-box product.

- **Consumer tuning keys are sticky across redeploys.** `syncWorkerQueueBindings`
  (`packages/cli/src/daemon/routes.ts`) writes each key only when the manifest
  value is non-null, so deleting `max_batch_timeout` or `dead_letter_queue` from
  a wrangler file and redeploying leaves the old value in force forever.
  `QueueConfig`'s own comment states the opposite. Undiscoverable, because
  nothing prints effective tuning values, so fix these two together.

## Follow-ups the verification named

- **The readiness probe writes a stack trace into every worker's log on every
  start.** `defaultProbeFactory` (`packages/worker/src/worker.ts`) POSTs an
  empty body to the control port, and `CONTROL_SOURCE`
  (`packages/worker/src/runtime-image.ts`) starts with `await request.json()`,
  which throws on it. Harmless (the probe only needs a status line, and the 500
  is one) but it means a real control channel failure and a routine startup
  look identical in `hobby logs`. Smallest fix: read the body as text and
  answer an empty one as a readiness ping without logging.
- **Nothing prints a consumer's effective tuning values.** Neither
  `hobby deploy` nor `hobby queue ls` shows `max_batch_size`,
  `max_batch_timeout`, `max_retries` or `retry_delay`, and the spec claims the
  deploy does. Given that `max_batch_timeout` turned out to be the dominant
  term in delivery latency, it is the value users will most want to see.
- **Retries, dead letters and lease expiry have never met Docker.** They are
  covered against a fake clock in `packages/queue/test/` and no real handler
  has ever thrown, and no real container has ever died mid-batch.
- **`queueDeliveryGuard` has never run inside a real hibernation tick.** Unit
  tests only.
