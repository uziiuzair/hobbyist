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
  container start. The daemon's own half WAS built: `queueEndpointHosts` binds
  each project network's bridge gateway, so the listener is correctly bound and
  simply unreachable by name. Found by whole-branch review 2026-08-14, after
  every end-to-end run passed on macOS. **Established by reading the code, not
  by running it: no Linux box has been touched.**

- **The readiness probe writes a stack trace into every worker's log on every
  start.** `defaultProbeFactory` (`packages/worker/src/worker.ts`) POSTs an
  empty body to the control port, and `CONTROL_SOURCE`
  (`packages/worker/src/runtime-image.ts`) starts with `await request.json()`,
  which throws on it. Harmless (the probe only needs a status line, and the 500
  is one) but it means a real control channel failure and a routine startup
  look identical in `hobby logs`. Smallest fix: read the body as text and
  answer an empty one as a readiness ping without logging.
- **Queue throughput is one batch per queue per tick (issue #159), and a
  consumer wake starts only once a batch is ready (issue #163).** Both follow
  from the tick being sequential, which is also why the delivery timeout is 30
  seconds rather than Cloudflare's 15 minutes (issue #158, documented in the
  guide). Making the tick concurrent per queue is the design change that would
  lift all three, and it is deliberately not made piecemeal.
- **Retries, dead letters and lease expiry have never met Docker.** They are
  covered against a fake clock in `packages/queue/test/` and no real handler
  has ever thrown, and no real container has ever died mid-batch.
- **`queueDeliveryGuard` has never run inside a real hibernation tick.** Unit
  tests only.

## Amendment, 2026-10-29: destroy deletes the row (issue #65)

`queueKindHandler.destroy` removed the files and never the row, so `hobby
queue rm` printed "deleted" and left the resource in `destroying` forever:
the name stayed taken, bare `project` targets turned ambiguous, `hobby
branch` refused the project and `hobby eject` still exported the queue. It
now ends with `store.deleteResource`, as every other kind's destroy does.

## Amendment, 2026-10-30: three follow-ups above are stale (issue #171)

The follow-ups list is left as written; three of its entries no longer
describe the code.

**The producer path is fixed in code, and owes a Linux re-run.** Both halves
landed: `containerSpec` (`packages/worker/src/worker.ts`) sets
`extraHosts: [{ name: 'host.docker.internal', address: 'host-gateway' }]` for
any worker that produces to a queue or is bound to a database, and
`buildCreateArgs` (`packages/core/src/docker.ts`) emits it as `--add-host`;
`ContainerSpec` (`packages/core/src/runtime.ts`) has the field. The second
half, recorded in `research/2026-08-22-the-producer-path-on-real-linux.md`,
is also closed: the queue endpoint's listener set is no longer a startup
snapshot, `queueEndpoint.addHost` (`packages/cli/src/daemon/queue-endpoint.ts`)
binds a new project's bridge gateway when `packages/cli/src/daemon/server.ts`
creates the network. The QA queues lane ran `send()` from inside a container
against real Docker on macOS on 2026-10-19. **Nobody has re-run it on a real
Linux box since the fix**, and Linux is the platform the bug was about, so the
site keeps it under "unmeasured" rather than "works".

**The readiness probe no longer writes a stack trace.** `defaultProbeFactory`
(`worker.ts`) now probes the control port with `GET /`, and `CONTROL_SOURCE`
(`packages/worker/src/runtime-image.ts`) answers any non-POST with 405 before
it reads a body, so `await request.json()` is never reached by the probe. The
QA lane's `hobby logs` for two workers showed only the two `hobby: ...
listening` lines per start.

**Retries, dead letters and lease expiry have met Docker.** The same lane
drove a consumer that threw, watched the message retry and land in the dead
letter queue, and let a lease expire with the container stopped mid-batch,
all against real Docker on macOS. They remain covered by the fake-clock tests
in `packages/queue/test/`; the point of this note is that the "never met
Docker" wording above is out of date.

## Amendment, 2026-10-30: the QA queues lane fixes (issues #156 to #158, #164 to #170)

- **Retention sweeps every queue.** `retentionTargets`
  (`packages/cli/src/daemon/queues.ts`) lists every queue in a managed project
  that `drainableQueues` leaves out, and `tickOnce` (`packages/queue/src/tick.ts`)
  sweeps them after the drainable pass. Dead letter queues and producer-only
  queues no longer keep messages forever (#167). A file that does not exist yet
  is left alone rather than created.
- **The manifest replaces the stored tuning on every deploy.**
  `syncWorkerQueueBindings` writes all five consumer keys from the manifest,
  null included, so a key deleted from `wrangler.toml` falls back to the
  broker's default (#166). `QueueConfig`'s comment was right all along.
- **Retry delay counts from the delivery result.** `tickOneQueue` reads the
  clock again after `wake` and `deliver` return and hands that to `applyResult`
  (#157).
- **Dead letters keep their identity.** `insertDeadLetter`
  (`packages/queue/src/broker.ts`) writes the same id, the original
  `enqueued_at` and the failed attempt count into two new nullable columns,
  `dead_lettered_at` and `failed_attempts`, added by `openQueueDb` with ALTER
  TABLE on an older file. `attempts` restarts at 0. Retention on a dead letter
  counts from `dead_lettered_at` (#168). INSERT OR IGNORE keeps the
  write-before-delete ordering safe to repeat.
- **A dead letter queue cannot be deleted while named.** `findBindingWorker`
  (`packages/cli/src/daemon/routes.ts`) also reads every consumer's
  `dead_letter_queue`, from the manifest and from the stored `QueueConfig`
  (#156).
- **Every failed delivery is logged.** `deliverBatch` returns a `failure`
  reason on `DeliveryResult`; the tick logs it, logs dead letters, and logs
  retention sweeps (#158). The 30 second handler limit is now documented in the
  guide; it is not raised, see the follow-up above.
- **Producer errors carry the daemon's message.** The shim in
  `packages/worker/src/runtime-image.ts` reads `error.message` and `error.hint`
  from a non-2xx response (#164). An ejected worker's shim throws a plain
  "has no broker" error.
- **The enqueue route takes a 1 MB body**, and `readJsonBody` drains an
  oversized body and answers 400 instead of destroying the socket (#165).
- **Eject strips `queueEndpoint` and `queueToken`** from `HOBBY_WORKER_MANIFEST`
  in the compose output, and a queue-only project ejects its backlog with a
  compose file that is comments only (#169).
- **`hobby queue peek` marks `leased` and `delayed` messages and dead letter
  provenance; `hobby queue ls` shows retention and effective tuning; `hobby
  queue set` echoes the value** (#170). `peek()` takes `nowMs` and returns
  `PeekedMessage`.
