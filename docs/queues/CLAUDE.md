# `docs/queues/` the broker outside the runtime

**Status:** DESIGNED, not built. The spec is
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

## The measurement this capability owes

Two numbers, neither taken yet, both to be filed with hardware stated:

- **Enqueue latency**, from `send()` being called inside the container to the
  row being committed on the host.
- **Wake to first delivery**, from a message arriving for a sleeping consumer to
  its `queue()` handler running. This one is judged against the project's single
  number: 1 second target, 3 second ceiling.
