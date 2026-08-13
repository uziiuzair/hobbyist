# The runner's control channel, verified against real Docker

Status: NOTES. Evidence gathered 2026-08-14, against the actual implementation
landed by Task 13 (`packages/worker/src/runtime-image.ts`,
`packages/worker/src/worker.ts`).
Date:   2026-08-14

Task 13 gave the worker container a second port and a control channel the
daemon can deliver queue batches through, and replaced Miniflare's queue
producer binding with our own `wrappedBindings` shim. Unit tests exercise the
manifest and the container spec against a fake runtime with no Docker in the
loop, which is necessary and not sufficient: `packages/worker/src/runtime-image.ts`
lines 23 to 44 record two prior bugs (Bun cannot run Miniflare, Alpine cannot
spawn workerd) that only a real container run ever found. This doc is that
real run for the control channel.

## What had to hold

1. A real `docker build` produces an image from the generated Dockerfile,
   with the new `queue-shim.mjs` and `control.mjs` written at container start
   and no `ERR_INVALID_WRAPPED` at Miniflare startup (the fact the spike
   settled: a `wrappedBindings` target worker must carry no
   `compatibilityDate` of its own).
2. `env.VERIFY_QUEUE.send()`, called from the user's own `fetch` handler
   running inside the container, reaches a listener on the host, codec-encoded,
   with the per-resource bearer token intact.
3. `POST /queue` on the container's published control port returns a real
   `QueueResponse` (`outcome`, `retryBatch`, `retryMessages`), and the user's
   own `queue()` handler actually runs and receives a correctly decoded body.

## Setup

Host: macOS 25.3.0, Apple Silicon, OrbStack (`docker info` reports
`OperatingSystem: OrbStack`, server `linux/arm64`).

The verification drove the real production code path, not a reduced spike:
`createWorkerResource`, `startWorker`, `stopWorker` and `destroyWorker` from
`packages/worker/dist/src/worker.js`, against `createDockerRuntime()` from
`packages/core/dist/src/docker.js` (real `docker` CLI calls, no fake). A
worker fixture with a real `wrangler.toml`:

```toml
name = "verify-worker"
main = "src/index.ts"
compatibility_date = "2026-08-01"

[[queues.producers]]
queue = "verify-queue"
binding = "VERIFY_QUEUE"

[[queues.consumers]]
queue = "verify-queue"
```

and a user worker (`src/index.ts`) with a `/send` route that calls the
producer binding, and a `queue()` handler that logs what it received,
including whether `timestamp` came through as a `Date` and whether a `Date`
nested inside the message body survived the round trip:

```ts
export default {
  async fetch(request: Request, env: any): Promise<Response> {
    const url = new URL(request.url)
    if (url.pathname === '/send') {
      const result = await env.VERIFY_QUEUE.send({ hello: 'world', at: new Date(1786375171389) })
      return Response.json({ sent: result })
    }
    return new Response('ok')
  },
  async queue(batch: any, env: any): Promise<void> {
    for (const message of batch.messages) {
      console.log(
        'QUEUE_RECEIVED id=' + message.id +
          ' attempts=' + message.attempts +
          ' timestampIsDate=' + (message.timestamp instanceof Date) +
          ' body=' + JSON.stringify(message.body) +
          ' bodyDateIsDate=' + (message.body && message.body.at instanceof Date)
      )
    }
  },
}
```

A Node script (`verify.mjs`, not committed, scratchpad only) ran a host
listener on `127.0.0.1:7799/enqueue` standing in for the daemon's future
enqueue endpoint (not built by this task), built a `HobbyConfig` with
`queuePort: 7799` so `buildRunnerManifest` would point the shim at it, called
`createWorkerResource` for real, then `startWorker` again for manual poking,
then drove both legs from the host with the real `fetch` API.

## The build

```
$ node verify.mjs
VERIFY: host listener up on 127.0.0.1:7799
VERIFY: building and creating the worker resource (real docker build)...
```

The Dockerfile build ran to completion with no error. The stages that matter
(the RUN embedding the runner script is a base64 blob and is elided here; it
is exactly `renderWorkerDockerfile`'s own generated line, and the two claims
that matter, "it produced a working image" and "Miniflare did not refuse to
start", are both verified by everything below rather than by that one line):

```
#14 [build 4/5] RUN bun install --frozen-lockfile 2>/dev/null || bun install 2>/dev/null || true
#14 DONE 0.2s

#15 [build 5/5] RUN bun build "src/index.ts" --outfile /out/worker.mjs --target=browser --format=esm --conditions=workerd,worker,browser --external "cloudflare:*"
#15 0.122 Bundled 1 module in 12ms
#15 0.122 
#15 0.122   worker.mjs  0.71 KB  (entry point)
#15 0.122 
#15 DONE 0.1s

#16 [stage-1 6/6] COPY --from=build /out/worker.mjs /hobby/worker.mjs
#16 DONE 0.1s

#17 exporting to image
#17 exporting layers 0.1s done
#17 exporting manifest sha256:a3cbabcef334672ed63bb4292b682dc71228e9edce7e7c201501b0e96dc7f448 0.0s done
#17 exporting config sha256:b17ef9817bbc1a01a15be51543b717562ebc0144ebb94b602c86cd0c0473fa3f 0.0s done
#17 exporting attestation manifest sha256:44b3af48f147dd42d7b72e1e13e8fffca5fe2d127f4539d5bfaafb6e676b5f0b 0.0s done
#17 exporting manifest list sha256:3a7e6c17df4a250f728c19bac2b3542256177ecb88d50d8bf1e5c3b4f6222d9a 0.0s done
#17 naming to docker.io/hobby/verify-api-worker:1786649332 done
#17 unpacking to docker.io/hobby/verify-api-worker:1786649332 0.1s done
```

`createWorkerResource` proceeded past this to its own `startWorker` +
`stopWorker` proof-of-serving step (the same one every worker create does)
and returned successfully:

```
VERIFY: created and proven asleep. state=sleeping
VERIFY: hostPort=35433 controlPort=35434
```

Two ports were allocated for one worker, from the same range, and they are
distinct: `35433` (the existing worker port range starts at 35433) and
`35434`, confirming `store.allocatePort`'s new `exclude` argument did its job
inside `createWorkerResource` (`hostPort` and `controlPort` are both allocated
before either is written to the store).

No `ERR_INVALID_WRAPPED`, and no Miniflare startup error of any kind: the
build finished, the container started, and the readiness probe against the
main port succeeded (`createWorkerResource` would have thrown and set the
resource `failed` otherwise; it did not, and `state=sleeping` is the state a
worker reaches only after being proven to serve, per
`packages/worker/src/worker.ts`'s `createWorkerResource`).

## The producer leg

```
VERIFY: starting the worker for manual testing...
VERIFY: worker running. hostPort=35433 controlPort=35434
VERIFY: GET http://127.0.0.1:35433/send
LISTENER: POST /enqueue
LISTENER: authorization=Bearer 954c50eb-b179-46ad-8b9d-50f939a159f4
LISTENER: body={"queue":"verify-queue","messages":[{"body":"[[\"object\",[[\"hello\",1],[\"at\",2]]],[\"prim\",\"world\"],[\"date\",1786375171389]]","contentType":"json"}]}
VERIFY: /send status=200 body={"sent":{"ids":["verify-1"]}}
```

`env.VERIFY_QUEUE.send({ hello: 'world', at: new Date(...) })`, called from
inside the container's user worker, reached the host listener over
`host.docker.internal`, encoded with the inlined codec (the `["date", ...]`
tagged node is the codec's own encoding of the `Date`, not a flattened
string), with the bearer token set to the resource's own id
(`954c50eb-b179-46ad-8b9d-50f939a159f4`), matching the `queueToken` design
recorded in `packages/worker/src/worker.ts`'s `buildRunnerManifest`. The
listener's `{"ids":["verify-1"]}` response flowed back through `send()`
unmodified, into the worker's own JSON response.

## The consumer leg, and the control port

```
VERIFY: POST http://127.0.0.1:35434/queue
VERIFY: request body={"queue":"verify-queue","messages":[{"id":"01JQVERIFYCONTROLCHANNEL01","timestamp":1786375171389,"body":"[[\"object\",[[\"a\",1],[\"at\",2]]],[\"prim\",1],[\"date\",1700000000000]]","attempts":1}],"metadata":{"metrics":{"backlogCount":0,"backlogBytes":0,"oldestMessageTimestamp":0}}}
VERIFY: /queue status=200 body={"outcome":"ok","ackAll":false,"retryBatch":{"retry":false},"explicitAcks":[],"retryMessages":[]}
```

`POST /queue` against the published control port (`35434` on the host,
`8788` inside the container) returned a real `QueueResponse`: `outcome`,
`retryBatch` and `retryMessages` are all present, exactly the three fields
the task brief asked to confirm, plus `ackAll` and `explicitAcks`, which
workerd's own `Fetcher#queue` extra handler adds and which
`packages/worker/src/runtime-image.ts`'s `CONTROL_SOURCE` passes through
verbatim rather than reshaping.

The container's own log confirms the request did not just get a plausible
looking response: the user's `queue()` handler actually ran.

```
--- container logs (tail 200) ---
hobby: worker listening on http://127.0.0.1:8787/
hobby: control channel listening on container port 8788, published on host port 35434
hobby: worker listening on http://127.0.0.1:8787/
hobby: control channel listening on container port 8788, published on host port 35434
QUEUE_RECEIVED id=01JQVERIFYCONTROLCHANNEL01 attempts=1 timestampIsDate=true body={"a":1,"at":"2023-11-14T22:13:20.000Z"} bodyDateIsDate=true

--- end container logs ---
```

(Two copies of the startup lines appear because the same container was
started twice in this run: once by `createWorkerResource`'s own
proof-of-serving start/stop, and again by the script's explicit `startWorker`
for manual testing. Both starts logged the control channel coming up, which
is itself a small confirmation that the control server survives a stop and a
fresh start, i.e. a sleep and a wake, cleanly.)

`timestampIsDate=true` confirms `CONTROL_SOURCE`'s `new Date(message.timestamp)`
conversion: the wire carries milliseconds since the epoch (`1786375171389`),
and the handler saw a real `Date`, matching Cloudflare's own
`Message.timestamp` contract (found by reading Miniflare's own
`broker.worker.js`, not assumed). `body={"a":1,"at":"2023-11-14T22:13:20.000Z"}`
with `bodyDateIsDate=true` confirms the round trip the whole codec exists for:
the message body sent to `/queue` was the codec-encoded string
`[["object",[["a",1],["at",2]]],["prim",1],["date",1700000000000]]`
(`decodeBody` compiled into `CONTROL_SOURCE`), and what the user's handler
received was a plain object with a real `Date` inside it, not a flattened
timestamp or a raw encoded string.

## Cleanup

```
VERIFY: cleanup complete
```

`stopWorker` and `destroyWorker` ran without error; the container, its
image, and the temporary `HOBBY_HOME` were all torn down. `docker ps -a`
after the run shows nothing left behind from this verification.

## Verdict

All three things that had to hold, held, on the first real run, with no
fallback needed:

1. **A real `docker build` produces a working image, with no
   `ERR_INVALID_WRAPPED`: yes.** The multi-worker Miniflare config (`user`,
   `hobby-queue-shim` with no `compatibilityDate`, `hobby-control`) started
   cleanly.
2. **`env.VERIFY_QUEUE.send()` reaches a host listener, codec-encoded, with
   the bearer token intact: yes.** Confirmed by the listener's own log, not
   by the worker's report of what it sent.
3. **`POST /queue` returns a real `QueueResponse`, and the user's `queue()`
   handler actually runs on a correctly decoded body: yes.** Confirmed by the
   container's own log, not by the HTTP response alone.

One thing worth flagging for whoever builds the daemon's real enqueue
listener and delivery loop next: `wrappedBindings`' extended form,
`{ scriptName, bindings }`, does accept a per-entry `bindings` object (checked
against `miniflare@4.20260730.0`'s own shipped `.d.ts`, not assumed), which is
what lets one `hobby-queue-shim` worker serve every producer binding a worker
declares, each with its own `HOBBY_QUEUE_NAME`. This was not exercised by the
2026-08-13 spike (which had exactly one producer) and is exercised here only
with one producer too, since the fixture worker declares one; a worker with
two or more distinct producer bindings has not yet been run for real.

## Addendum: readiness now covers both ports

Added after the run above, in a later fix round on the same date, so this
section is appended rather than folding into the narrative that already
happened: at the time of the run this document records, `startWorker`'s
readiness probe checked only the main port. A worker whose control server
failed to bind, or whose runner crashed in the moment between the main port
coming up and the control server's own `.listen()` call, would have been
recorded `running` on the strength of the main port alone, main port serving
fine, control port answering nothing, and the daemon would have gone on to
deliver every batch to a port with nothing behind it. Queue delivery would
have silently never worked while the worker looked entirely healthy, which
is the exact symptom this whole capability exists to prevent, arriving
through the readiness probe instead of the broker.

Fixed in `packages/worker/src/worker.ts`: `defaultProbeFactory` now checks
the control port too, whenever the worker declares a producer or a consumer
(`declaresQueueBindings`), with the same "send a real request, require a
real status line" discipline the main port's probe already used, POSTing an
empty body to `/queue` rather than opening a bare TCP connection. This was
not re-verified against a fresh real container build: the readiness change
is exercised end to end with real local sockets in
`packages/worker/test/worker.test.ts` (two tests, one asserting a worker
with a queue binding is NOT ready until both ports answer, one asserting a
worker with no queue binding is never made to wait on the control port at
all), and the transport itself, what the control port actually does once it
answers, is unchanged from what the run above already confirmed against real
Docker. A full container rebuild to re-confirm the same transport again was
judged not worth the build time; the readiness LOGIC is what changed, and
that is covered by real sockets, just not inside a real container.

## Reproducing

Fixture and script lived in a scratchpad directory, none of them kept:
`wrangler.toml`, `src/index.ts`, and `verify.mjs`. The fixture and the
relevant parts of `verify.mjs` are quoted above in full. Nothing under
`packages/` was touched by the verification itself; the code under test is
already committed.
