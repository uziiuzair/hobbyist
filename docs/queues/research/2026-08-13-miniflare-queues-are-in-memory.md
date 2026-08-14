# Miniflare's queue broker is in memory, and what that costs us

Status: NOTES. Evidence gathered 2026-08-13, before any queue code existed.
Date:   2026-08-13

Three questions, answered by reading the pinned dependency and by running two
container probes rather than by reasoning about them. Everything here is
reproducible from the commands quoted.

## 1. Does a queued message survive a worker going to sleep?

**No. It is destroyed.**

`packages/worker/src/runtime-image.ts` pins `MINIFLARE_VERSION =
'4.20260730.0'` and the runner passes `queueProducers` and `queueConsumers`
straight through to Miniflare (`runtime-image.ts:77-78`). In that version:

```
$ npm pack miniflare@4.20260730.0 && tar xzf miniflare-4.20260730.0.tgz
$ grep -n "in-memory only" package/dist/src/index.js
98204:        // Miniflare's Queue broker is in-memory only at the moment
98205:        durableObjectStorage: { inMemory: kVoid },
```

The comment is Miniflare's own, not ours. The broker is a Durable Object
(`QUEUE_BROKER_OBJECT_CLASS_NAME = "QueueBrokerObject"`, `index.js:98147`)
whose backlog is a plain field, `#messages = []`, and whose storage is
explicitly configured as in-memory. There is no `queuesPersist` option to set,
the way there is `kvPersist`, `r2Persist`, `d1Persist` and
`durableObjectsPersist`. Persistence is not switched off by our configuration;
it is not implemented.

Consequences, in the order a user meets them:

1. A worker with a queue backlog is stopped by the hibernator. The container
   exits. Every unprocessed message is gone.
2. Nothing reports this. The container stopped cleanly, the state column reads
   `sleeping`, and the messages were never written anywhere that could be
   inspected afterwards.
3. `wrangler dev` behaves the same way, so this is not a hobby defect a user
   would recognise as ours. It is a dev-tool property that becomes a data-loss
   property the moment the process is expected to stop and start on its own.

This is the gap `.remember/recent.md` recorded on 2026-08-11 as "Identified
Miniflare Queues persistence gap (awaiting direction)".

## 2. Are the primitives for an external broker exposed?

**Yes, all three.**

| Primitive | Where | What it buys |
|---|---|---|
| `wrappedBindings` | `dist/src/index.d.ts`, 14 occurrences across the worker option schemas | The binding object itself is ours, so `env.MY_Q.send()` can be our JS rather than workerd's queue binding |
| `Fetcher#queue(name, messages, metadata)` | used at `index.js` `#dispatchBatch`, gated behind the `service_binding_extra_handlers` compatibility flag (`index.js:98192`) | Delivery that returns `{outcome, retryBatch, retryMessages}`, so a caller can know what was acked |
| `getWorker(workerName?)` | `dist/src/index.d.ts:4053` | The Node side of the runner can reach a named worker in the same instance |

The second row is the load-bearing one. Miniflare's own broker delivers exactly
this way, so the delivery path an external broker needs is the delivery path
Cloudflare's local simulator already uses. Without a return value carrying acks,
no durable broker is possible and the only honest offering would be
at-most-once.

`getQueueProducer(bindingName, workerName?)` also exists
(`dist/src/index.d.ts:4080`) and is deliberately **not** what we want: it pushes
into the in-memory broker, which then owns batching and retries and tells us
nothing about what succeeded.

## 3. How does a container reach the daemon on the host?

Nothing in the repo does this yet, so both candidate transports were run.

Host: macOS 25.3.0, Apple Silicon, **OrbStack** (`docker info` reports
`OperatingSystem: OrbStack`, server `linux/arm64 29.4.0`). Container:
`node:22-bookworm-slim`.

### Bind-mounted host unix socket: does not work

A Node HTTP server listening on a host unix socket, mounted with `-v
/tmp/hqspike:/hobbysock`:

```
srw-rw-rw-@ 1 uzairhayat wheel 0 Aug 13 18:35 queue.sock   # visible in the container
ERROR: ECONNREFUSED connect ECONNREFUSED /hobbysock/queue.sock
```

The socket inode crosses the filesystem boundary; the connection does not.
`ECONNREFUSED` rather than `ENOENT` is the whole finding: the file is there and
nothing on the other side can be reached. Ruled out, because it fails on the
author's own machine.

Incidental, and worth knowing before anyone designs a socket path: the first
attempt failed with `EINVAL` on `listen`, not because of Docker but because the
path was 122 bytes. macOS caps `sun_path` at 104. Any unix socket path this
project generates has to be checked against that limit.

### Loopback-bound host TCP: works on macOS, and will not on Linux

A Node HTTP server bound to `127.0.0.1:7799`, reached from inside a container:

```
host.orb.internal    => RESULT 200 LOOPBACK_OK /enqueue
host.docker.internal => RESULT 200 LOOPBACK_OK /enqueue
```

OrbStack proxies both names to the Mac's loopback, so a listener that never
leaves `127.0.0.1` is reachable from a container. That is the convenient
answer and it is convenient only here.

**On Linux this will fail, and Linux is the target.** `host.docker.internal`
resolves via `--add-host=host.docker.internal:host-gateway` to the bridge
gateway address (`172.x.y.1`). A connection from a container arrives at the
host on the bridge interface, and a socket bound to `127.0.0.1` does not accept
it. So the daemon needs a second bind on the project network's gateway address
on Linux, which is the first listener in this project to leave loopback and
therefore needs a token rather than trusting the network.

**Not verified on a five dollar VPS.** This is reasoning about how Docker
bridge networking works, not a measurement, and it stays marked as such until
someone runs it. It joins cold start on the list of things this project claims
about Linux having only ever tested on a Mac.

## Reproducing

The probes were three files in a scratchpad and are not kept: a Node HTTP
server on a unix socket, the same on `127.0.0.1:7799`, and a one-line
`docker run node:22-bookworm-slim node -e ...` client for each. Everything
needed to rebuild them is quoted above.
