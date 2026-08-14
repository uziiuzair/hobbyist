# Queues: a durable broker in the daemon, and a consumer that sleeps

Status: BUILT. Approved in design on 2026-08-13 and implemented over
2026-08-13 and 2026-08-14. Verified end to end against real Docker on
2026-08-14: `research/2026-08-14-queues-survive-sleep.md`.
Date:   2026-08-13

**Status line corrected on 2026-08-14.** It previously read "Nothing in this
document is built ... implementation has not started", which was the first
line a reader met and was by then false in every particular. The body below is
left exactly as it was written on 2026-08-13, per the dated-artifact rule; the
places where the machine disagrees with it are recorded in the addendum at the
end rather than edited into the text.

Implements `docs/decisions/0013`. The evidence every claim about Miniflare and
about container networking rests on is in
`research/2026-08-13-miniflare-queues-are-in-memory.md`, including the probes
that produced it.

## What this builds

A `queue` resource kind, and a package `@hobby.sh/queue` that holds messages
where a stopped container cannot destroy them.

Two properties matter, and the second is the one no dev tool will ever have:

1. **A queued message survives sleep.** Today it does not (ADR 0013).
2. **A message arriving for a sleeping consumer wakes it.** This is the first
   place in the project where stored state, rather than an inbound connection,
   starts a container.

It never starts a container itself. It calls `wake(resourceId)` and waits, the
same seam `packages/proxy` and `@hobby.sh/do` use.

## The shape

```
 producer worker (container)                 daemon (host)                consumer worker (container)
 ┌───────────────────────────┐         ┌────────────────────────┐        ┌──────────────────────────┐
 │ env.MY_Q.send(body)       │  POST   │  @hobby.sh/queue       │        │  runner control server   │
 │   └ wrapped binding       │ /enqueue│  ┌──────────────────┐  │        │  :<controlPort>          │
 │      (our JS)           ──┼────────▶│  │ messages.sqlite  │  │  POST  │   /queue  ───────┐       │
 │                           │  200 ◀──┼──│                  │  │ batch  │                  ▼       │
 └───────────────────────────┘         │  └──────────────────┘  ├───────▶│  hobby-control worker    │
   send() resolves only once the       │      tick, 250ms       │        │  env.USER.queue(...)     │
   row is committed on the host        │   ready? wake? deliver │ ◀──────┤  user's queue(batch,...) │
                                       └────────────────────────┘ result └──────────────────────────┘
```

## The store

One SQLite database per queue, at `paths.resourcePath(project, queue, 'queue')`,
opened through `packages/core/src/sqlite.ts`. The daemon is the only writer,
which is what keeps this simple: no cross-container locking, no WAL over a bind
mount.

```sql
CREATE TABLE messages (
  id             TEXT PRIMARY KEY,      -- ULID, sortable by creation
  body           TEXT NOT NULL,         -- opaque to the daemon, see Codec
  content_type   TEXT NOT NULL,         -- 'json' | 'text' | 'bytes' | 'v8'
  bytes          INTEGER NOT NULL,      -- for the 128 KB limit and backlog metrics
  enqueued_at    INTEGER NOT NULL,      -- ms since epoch, drives retention
  visible_at     INTEGER NOT NULL,      -- ms since epoch, drives delaySeconds
  attempts       INTEGER NOT NULL DEFAULT 0,
  lease_id       TEXT,                  -- non-null while a batch is out
  lease_expires_at INTEGER              -- ms since epoch
);
CREATE INDEX messages_ready ON messages (visible_at) WHERE lease_id IS NULL;
CREATE INDEX messages_lease ON messages (lease_expires_at) WHERE lease_id IS NOT NULL;
```

Milliseconds, not the nanoseconds `_cf_ALARM` uses. That choice is deliberate
and the reason is recorded in decision `hobbyist.durable-objects-on-main`:
int64 nanoseconds exceed `Number.MAX_SAFE_INTEGER` and `node:sqlite` throws
`ERR_OUT_OF_RANGE` rather than rounding. This table is ours, so it does not
inherit that problem.

`id` is a ULID rather than a UUID so `ORDER BY id` is creation order, which
makes best-effort FIFO free and makes `hobby queue peek` output stable.

## The two legs

### Producer

Miniflare's `queueProducers` is **not** configured, so `QueueBrokerObject` is
never constructed. The binding is supplied through `wrappedBindings`, whose
module implements the Cloudflare producer surface and calls the daemon:

```
POST http://host.docker.internal:<queuePort>/enqueue
Authorization: Bearer <per-resource token>
{ "queue": "vault-embed",
  "messages": [ { "body": "<encoded>", "contentType": "json", "delaySeconds": 0 } ] }

200 { "ids": ["01JQ..."] }
```

`send()` and `sendBatch()` resolve only after the rows are committed on the
host. That is a stronger guarantee than Cloudflare offers and it is the honest
one for a box you own: when the promise resolves, the message is on your disk.

Rejections match Cloudflare's limits, taken from Miniflare's own constants
(`dist/src/workers/queues/broker.worker.js:84`): 128 KB per message, 100
messages per batch, 288 KB per batch. `delaySeconds` is an integer 0 to 86400.

### Consumer

The daemon leases a batch and posts it to the container's control port. Inside,
a second worker named `hobby-control` holds a service binding to the user's
worker and makes the same call Miniflare's broker makes
(`broker.worker.js:212`, `#dispatchBatch`):

```js
env.USER.queue(queueName, messages, { metrics: { backlogCount, backlogBytes, oldestMessageTimestamp } })
```

That call requires the `service_binding_extra_handlers` compatibility flag,
which `hobby-control` sets on itself and which the user's worker does not need.
Its return value is the entire point:

```ts
{ outcome: 'ok' | 'exception',
  retryBatch: { retry: boolean, delaySeconds?: number },
  retryMessages: Array<{ msgId: string, delaySeconds?: number }> }
```

`ackAll()` and `retryAll()` need no special handling: workerd folds them into
`retryBatch` and the acks before we see them.

**`attempts` is incremented once, when the batch is leased**, never when the
result comes back. So the value stored is the number of delivery attempts made,
it is 1 during the first delivery, and it is exactly the `Message.attempts` the
handler sees, which Cloudflare documents as starting at 1. Counting at lease
time rather than at result time is what makes a consumer that dies mid-batch
cost an attempt: no result ever arrives for it, and an attempt that is only
counted on return would let a crash loop retry forever.

Applying the result, per message, in one transaction:

- retried, and `attempts <= max_retries`: clear the lease, set
  `visible_at = now + (per-message delay, else batch delay, else retry_delay)`.
- retried, and `attempts > max_retries`: move the row to the dead letter queue's
  table if `dead_letter_queue` is set, otherwise delete it and log at warn.
- acked, or not mentioned at all with `outcome: 'ok'`: delete the row.

With the default `max_retries` of 2, a message that always fails is delivered
three times and then dead lettered, matching `maxAttempts = maxRetries + 1` at
`broker.worker.js:226`.

An `outcome` other than `ok` retries the whole batch, matching
`broker.worker.js:250`.

### Delivery over a second port, not a proxy

The control channel is a separate published port allocated by
`store.allocatePort` (`packages/core/src/store.ts:328`), so nothing of ours sits
in front of Miniflare on the request path. Fronting it would put our code in the
way of every request, including Durable Object WebSocket upgrades and streamed
responses, to serve a channel used a few times a second at most. The cost is one
integer per worker resource.

The control server binds `0.0.0.0` inside the container and is published to the
host loopback only, exactly as the worker port already is
(`DEFAULT_PORT_BIND`, `packages/core/src/runtime.ts`).

## The tick

One loop in the daemon, 250ms, alongside the alarm mirror. For each queue with a
consumer:

1. **Expire leases.** `lease_expires_at < now` clears the lease and makes the
   row visible again. It does not touch `attempts`, which was already
   incremented when the batch was leased. This is what makes a container dying
   mid-batch, or being slept mid-batch, a redelivery rather than a loss. A
   message that has exhausted `max_retries` this way is dead lettered here
   rather than redelivered.
2. **Sweep retention.** `enqueued_at` older than the queue's retention is
   deleted, and the count logged. Silent expiry is how a queue lies about what
   it holds. Default 4 days, settable from 60 seconds to 14 days, which are
   Cloudflare's own bounds (`wrangler queues update --message-retention-period-secs`).
3. **Decide a batch.** Ready when the count of visible unleased messages
   reaches `max_batch_size`, or when the oldest visible message has waited
   `max_batch_timeout`.
4. **Wake if needed.** If the consumer resource is `sleeping`, call
   `wake(resourceId)` and deliver once it is `running`. If it is `starting`,
   wait for the next tick rather than stacking wakes.
5. **Deliver**, apply the result, repeat until nothing is ready.

Default `max_batch_size` 5, `max_batch_timeout` 1 second, `max_retries` 2, taken
from Miniflare's constants so local behaviour matches the simulator the user
already tests against. Cloudflare's production defaults are documented
separately and are not identical; a handler that cares should set the keys
explicitly, and `hobby deploy` prints the effective values.

**A queue never blocks sleep by having a backlog.** The opposite is the point:
sleep with a backlog, wake when it is time to deliver. The only thing that keeps
a worker awake is an outstanding lease, through the guard below.

## The kind, and the guard

`queueKindHandler` implements `ResourceKindHandler` from
`packages/core/src/kinds.ts`:

| Method | Behaviour |
|---|---|
| `start` | Ensure the SQLite file exists. No container. |
| `stop` | No-op. A queue has nothing to stop. |
| `destroy` | Delete the file and the row, after refusing if a worker still binds it unless `--force`. |
| `probe` | `true` if the file is openable. |
| `guard` | Not used by the queue itself. |

**A queue's state is `running` from creation and never changes.** It holds no
process, so it has nothing to sleep and nothing to wake. Reading `sleeping` on a
queue would mean the hibernator had acted on it, which is exactly the bug the
exemption below prevents.

The hibernator must skip `queue` entirely, and reconcile must not read a
container state for it. This is the first kind with no container, and it is the
shape most likely to need a second pass. It should share whatever exemption the
record-before-code work adds for its `undeployed` resting state rather than
growing a second one.

The `worker` kind gains a second guard, composed with the existing Durable
Object one in `packages/worker/src/kind.ts:35`:

```
queueDeliveryGuard  ->  'active' while any queue has an unexpired lease held by this worker
```

Without it the hibernator could stop a container in the middle of a batch. The
messages would come back on lease expiry, so this is not a correctness fix, it
is the difference between a clean stop and re-running a handler that was already
half done.

## Codec

Cloudflare message bodies are structured-clone values under 128 KB. JSON would
silently flatten `Date`, `Map` and `Set`, and silent flattening across a sleep
is the kind of bug that surfaces a week later in someone else's code.

Both ends are ours, so the runner encodes and decodes with a structured-clone
compatible codec (the `@ungap/structured-clone` serialization shape: a flat
array of tagged nodes, JSON-safe, cycles preserved). The daemon stores the text
and never parses it. `content_type` records what was asked for so `hobby queue
peek` can render it and so a future pull consumer would know how to present it.

Where we differ from Cloudflare, stated plainly: a `v8` content type on
Cloudflare is workerd's own serializer, and ours is a JS codec with a slightly
smaller supported set (no `ArrayBuffer` transfer semantics, no `Error` cause
chains). Everything Arlo's `EmbedJob`-shaped payloads use is covered.

## Package layout

```
packages/queue/src/
  index.ts      the public surface
  schema.ts     the SQLite schema above, and opening it
  broker.ts     enqueue, lease, ack, retry, dead letter, sweep. No IO beyond sqlite.
  tick.ts       the loop: which queues are ready, when to wake, what to deliver
  deliver.ts    the HTTP hop to a container's control port, and parsing the result
  codec.ts      encode and decode, shared verbatim with the runner
  kind.ts       queueKindHandler
  guard.ts      queueDeliveryGuard, exported for @hobby.sh/worker
```

`broker.ts` takes a clock, so every semantic in this document is unit testable
with no Docker, no workerd and no timers.

## Surfaces

### wrangler

`packages/worker/src/manifest.ts:172` `queuesFrom` currently keeps queue names
and discards everything else, including `binding`, which is the field the
producer needs. It grows to:

```toml
[[queues.producers]]
queue = "vault-embed"
binding = "VAULT_EMBED_QUEUE"

[[queues.consumers]]
queue = "vault-embed"
max_batch_size = 10
max_batch_timeout = 5
max_retries = 3
retry_delay = 30
dead_letter_queue = "vault-embed-dlq"
max_concurrency = 4          # accepted, honoured as 1, reported
```

A queue named in either list is created if it does not exist, including a
`dead_letter_queue`, which matches Cloudflare ("If there is no queue with the
specified name, it will be created automatically"). `max_concurrency` joins
`IGNORED_WITH_REASON` (`manifest.ts:47`) with the reason "one box, one consumer
container", rather than being accepted silently.

### CLI

```
hobby queue ls [project]              name, depth, oldest, consumer, dlq
hobby queue create <name>
hobby queue peek <name> [--limit n]   non-destructive, oldest first
hobby queue send <name> <json>        dev ergonomics, and the manual test path
hobby queue purge <name>              destructive, confirms by typing the name
hobby queue rm <name>                 refuses while a worker binds it
hobby queue set <name> --retention <seconds>
```

`purge` asks for the queue name to be typed back, which is what `wrangler
queues purge` does, and for the same reason: it is irreversible and it is
reachable by tab completion.

### Daemon API, two listeners

`/v1/queues/*` on the existing daemon surface is the operator control plane, and
CLI, MCP and Studio are all clients of it, per the root `CLAUDE.md`.

The enqueue endpoint is a **separate listener** with a per-resource bearer token
minted at container start, exposing `POST /enqueue` and nothing else. A
compromised container should be able to add a message to a queue it was granted,
not read the store or destroy a project. On macOS it binds loopback and is
reached through `host.docker.internal`; on Linux it binds additionally on the
project network's bridge gateway, because a loopback bind is not reachable from
a container there (see the research doc).

### MCP

One tool per CLI verb, over the same daemon API, so the two cannot diverge.

### Studio

**Not in this work.** Studio is being restyled in another lane and
record-before-code sequences its multi-kind view after that. The daemon API
lands here; the view lands there.

### Eject

`hobby eject` writes `queues/<name>.jsonl`, one message per line with `id`,
`body`, `attempts` and `enqueued_at`, beside the emitted `docker-compose.yml`,
and the compose file carries a comment stating that hobby's broker is not part
of the ejected stack. An ejected worker has no queue. Saying so, and handing
over the messages in a readable format, is what ADR 0003's promise requires;
pretending the queue comes with you would be the lie.

## Test plan

| Layer | Proves | Docker |
|---|---|---|
| `broker.ts` unit, injected clock | batching, `delaySeconds`, lease expiry, `attempts`, dead letter after `max_retries`, retention sweep, the 128 KB and 100-message limits | no |
| Conformance suite | the semantics `~/ooozzy/arlo/packages/queue/src/__tests__/contract.test.ts` asserts across its three drivers, run against ours | no |
| Codec round trip | `Date`, `Map`, `Set`, nested, cyclic | no |
| Real Docker, producer plus consumer | send, deliver, ack deletes the row; a throwing handler retries; lands in the dead letter queue after `max_retries` | yes |
| **Survival** | three messages queued, worker slept, messages still present and delivered on wake | yes |
| **The feature** | consumer asleep, message arrives, it wakes and processes with no request in between | yes |
| Measurement | enqueue latency, and wake to first delivery, filed with hardware stated | yes |

The last two decide whether this works. Everything above them passes on a broker
that quietly loses messages.

## Milestones

| M | Ships | Verified by |
|---|---|---|
| M11 | Spike: `wrappedBindings` doing an outbound fetch from inside workerd | a container run, before any other code |
| M12 | `@hobby.sh/queue`: schema, broker, codec, all semantics | unit and conformance suites |
| M13 | `queue` kind, store wiring, hibernator and reconcile exemptions | kind dispatch tests |
| M14 | Runner control server, `hobby-control` worker, producer binding, second port | real Docker: send and deliver |
| M15 | Enqueue listener, token, Linux gateway bind | real Docker on macOS; the Linux run stays owed and is marked so |
| M16 | Tick, wake, `queueDeliveryGuard`, CLI, MCP, eject | survival and wake tests, numbers filed |

## Open questions

1. **`wrappedBindings` with an outbound fetch is unverified.** It is the
   load-bearing producer mechanism and has only been read about. M11 exists to
   settle it first. Fallback if it fails: the binding posts to the runner's own
   control server over container loopback, and the runner forwards to the
   daemon. One extra hop, slower, still correct.
2. **The Linux gateway bind is reasoned, not run.** No five dollar VPS has been
   touched. This joins cold start on the list of Linux claims tested only on a
   Mac.
3. **Ordering across a wake.** Best effort, like Cloudflare. `ORDER BY id`
   gives creation order within a batch, and nothing promises more.
4. **Two workers binding one queue as consumer.** Cloudflare allows one consumer
   per queue. We should reject the second at deploy with a clear message rather
   than picking one silently. Not yet designed.

## Addendum, 2026-08-14: where the machine disagreed with this document

Appended after the end-to-end verification
(`research/2026-08-14-queues-survive-sleep.md`) rather than edited into the
body above, so what was designed on 2026-08-13 stays legible next to what was
found on the 14th.

**Contradicted, and still open.** "The tick" section says a handler that cares
about the batching defaults "should set the keys explicitly, and `hobby deploy`
prints the effective values." It does not. A real deploy prints the image and
the URL and says nothing about queues at all, and `hobby queue ls` prints
depth, oldest, consumer and dead letter queue but none of the four tuning
values. Nothing anywhere shows a user what `max_batch_size`,
`max_batch_timeout`, `max_retries` or `retry_delay` resolved to. That matters
more than it looks: the measurement showed `max_batch_timeout` is the single
largest term in end-to-end latency, so it is the value a user is most likely to
want to see and least able to find. Not built, not scheduled, recorded here
rather than quietly dropped.

**Settled: open question 1.** `wrappedBindings` doing an outbound fetch was
verified on 2026-08-13 (`research/2026-08-13-wrapped-bindings-spike.md`) and
again on 2026-08-14 against the real production path, this time with a worker
declaring **two** distinct producer bindings to two different queues, which is
the case the control channel verification had explicitly left unrun. Both
worked. The fallback path described in that open question was never needed.

**Settled: open question 4.** Two workers binding one queue as consumer is
designed and built: `assertQueueBindingsAreLegal`
(`packages/cli/src/daemon/routes.ts`) refuses the second one *before* the image
is built, which was itself a bug found in review after a first version refused
it after the container was already running and serving.

**Confirmed as written**, by the same run, and listed because each was a claim
rather than an implementation detail: `send()` resolving only once the row is
committed on the host (measured at 1 ms, steady state); `attempts` incremented
at lease time, so the first delivery sees `attempts = 1` and the stored row
reads 0 before it; a queue's state being `running` from creation and never
changing; the control server published to host loopback only; the codec
carrying a `Date` intact across a container's death and rebirth; and a queue
named only in a manifest being created by the deploy with no
`hobby queue create` step.
