# 0013. Queues, and the broker that lives outside the runtime

Status: ACCEPTED
Date:   2026-08-13

Adds the `queue` resource kind, which appears in no phase table. Depends on ADR
0011 (workerd via Miniflare) and follows ADR 0012, which named Queues as one of
the capabilities expected to come next. Does not disturb ADRs 0001 through 0005.

## Context

ADR 0012 widened scope to Durable Objects and said so in its own text: "This is
new scope, requested directly, with Queues, Workers KV and D1 named as following
it." This is that one, requested directly, and it needs an ADR for two of the
reasons `docs/decisions/CLAUDE.md` lists: a new capability folder, and a new
resource kind that ADR 0007's phase table does not contain.

The usual scope argument would be about whether Queues are worth building. It is
not the argument here, because **a queue is already reachable today and already
loses data.**

`packages/worker/src/manifest.ts:172` parses `queues.producers` and
`queues.consumers` out of a user's wrangler manifest, and
`packages/worker/src/runtime-image.ts:77-78` passes them to Miniflare. So a user
can deploy a worker with a queue right now, and it will appear to work. Then the
hibernator stops the container, and every unprocessed message is destroyed,
silently, because Miniflare's broker holds its backlog in a plain array with
storage explicitly configured in-memory:

```
package/dist/src/index.js:98204
        // Miniflare's Queue broker is in-memory only at the moment
        durableObjectStorage: { inMemory: kVoid },
```

Evidence, including the version pin and the reproduction, is in
`docs/queues/research/2026-08-13-miniflare-queues-are-in-memory.md`.

That reframes the decision. The choice is not "should we add Queues." It is
"which of three things do we do about a data-loss path that already exists":

1. **Remove the capability.** Reject `queues` in the manifest parser with an
   error saying queues are not supported. Honest, cheap, and it makes the
   platform smaller in a way that is felt: a worker with a queue is an ordinary
   thing to write.
2. **Keep it and warn.** Document that queued messages do not survive sleep.
   This is the worst option and is recorded here so nobody proposes it later: it
   asks the user to reason about hibernation timing, which is precisely the thing
   the whole product exists to make invisible.
3. **Build a broker that lives outside the runtime.** Hold messages where they
   are not destroyed when the container stops.

## Decision

**Build the broker, in the daemon, as `@hobby.sh/queue`. Register `queue` as a
resource kind. Never persist Miniflare's broker; do not construct it at all.**

Three parts to the decision.

**The broker is outside the runtime, for the same reason the alarm mirror is.**
ADR 0012 established the pattern: a stopped container has no timer, so the
daemon holds the alarm schedule. A stopped container has no queue either, so the
daemon holds the messages. This is the second instance of one idea, not a second
idea, and it reuses the same seam: the broker never starts a container, it calls
`wake(resourceId)` and waits, exactly as `packages/proxy` does.

**A queue is a resource, not a worker's property.** A Durable Object namespace
belongs to the worker that declares the class, which is why ADR 0012 could leave
`durable_object` as storage rather than a kind. A queue cannot: one queue joins a
producer worker to a *different* consumer worker, so it outlives and outranks
both. It gets a row, a name inside the project, and a lifecycle of its own.

**Miniflare's queue plugin is bypassed entirely.** Not configured, not
persisted, not wrapped. If both brokers existed, Miniflare's would accept sends
and never deliver them, and the symptom would be "messages disappear sometimes"
rather than a wiring error anyone could find. Producer bindings are supplied
through `wrappedBindings` instead, and delivery goes through
`Fetcher#queue(name, messages, metadata)`, which is the same call Miniflare's
own broker makes and which returns the acks a durable broker cannot work
without.

Scope is push delivery with parity on the keys that real handlers use: `send`,
`sendBatch`, `delaySeconds`, `max_batch_size`, `max_batch_timeout`,
`max_retries`, `retry_delay`, `dead_letter_queue`, `attempts`, at-least-once.
The design is at `docs/queues/specs/2026-08-13-queues-design.md`.

## What is deliberately not built

- **HTTP pull consumers.** Cloudflare's pull API is a second protocol with its
  own auth and lease semantics, for clients that are not Workers. Nothing here
  needs it yet, and adding it later is additive.
- **`max_concurrency` above 1.** One box, one consumer container. The key is
  accepted and reported as honoured-at-1 rather than silently ignored.
- **Exactly-once delivery, ordering guarantees, message dedupe.** Cloudflare
  does not offer the first two on push queues either. Handlers must be
  idempotent, which is the same contract they already have on Cloudflare.
- **Queues for the `app` kind.** An `app` is an arbitrary container with no
  binding mechanism. The enqueue endpoint would make this easy to add and it is
  not being added on speculation.

## Consequences accepted

**A resource kind with no container.** `queue` has no image, no port and nothing
to probe. Its `start` and `stop` are state transitions with no engine call, and
the hibernator must skip it. The registry has not been asked for this shape
before, and it is the part of this ADR most likely to need a second pass. It
overlaps with the `undeployed` resting state that the record-before-code work is
adding for a different reason, and the two should end up sharing one exemption
rather than growing two.

**The daemon gets a listener that is not on loopback, on Linux.** Producers run
inside containers and must reach the broker. On macOS with OrbStack a loopback
bind is reachable through `host.docker.internal` (measured). On Linux it will
not be, so the queue endpoint binds additionally on the project network's bridge
gateway. That is the first thing in this project to leave `127.0.0.1`, and it is
why the endpoint carries a per-resource token and exposes queue verbs only,
never the daemon API. ADR 0008 already accepted that Studio's auth is a security
boundary rather than a formality; this is a second, narrower one.

**A second published port per worker resource.** The delivery channel needs to
reach into the container. Fronting Miniflare with a proxy would put our code in
the path of every request, including Durable Object WebSocket upgrades and
streamed responses, to serve a control channel used a few times a second at
most. A second allocated port keeps the request path untouched.

**More surface that can rot.** `hobby queue` commands, MCP tools, a Studio view
and an eject path. The eject obligation is real and non-negotiable under ADR
0003's promise: leaving must not silently drop a backlog, so eject writes the
messages out as JSONL beside the compose file and states plainly that the broker
does not come with you.

**Bun still cannot run this.** ADR 0011's two-stage image stands, and the
producer path adds a dependency on `wrappedBindings` behaving inside workerd,
which has been read about and not yet run. If it does not work, the fallback is
one extra hop through the runner's own control server: slower, not incorrect.

## What would have to change for this to be revisited

- **Miniflare ships queue persistence.** If a `queuesPersist` option appears
  with durable storage behind it, most of this becomes unnecessary for the
  single-worker case. It would still not wake a sleeping consumer, which is the
  half no dev tool will ever implement, so the mirror-shaped part survives even
  then.
- **Queues turn out not to be used.** If six months of daily use produces no
  queue, this was scope that should have gone to option 1 above. Deleting it is
  cheap precisely because Miniflare's plugin is bypassed rather than extended:
  the code is ours, in one package, behind one kind.
- **The Linux gateway bind proves unworkable or unsafe.** Then the transport
  changes to the file outbox that was considered and rejected for latency, and
  nothing else in this ADR moves. The transport is deliberately the most
  replaceable part of the design.
