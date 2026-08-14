# Queues across sleep, against real Docker: both runs, and the two numbers

Status: NOTES. Two real runs on one machine, plus twenty timed samples. Single
machine, single session; the numbers are measurements, not a benchmark suite.
Date:   2026-08-14

## Verdict first

**Both runs passed. Nothing was lost. The 3 second ceiling was not breached.**

| | Result |
|---|---|
| RUN 1, survival | **PASS.** Three messages queued, container stopped and confirmed not running, three rows still on the host, all three delivered on wake, table empty afterwards. |
| RUN 2, the wake | **PASS.** Consumer `sleeping`, no HTTP request of any kind, one message sent, container started by itself, `queue()` handler ran, and the row it wrote is readable from the host with the container stopped again. |

| Number | p50 | p95 |
|---|---|---|
| Enqueue latency, `send()` inside the container to the row committed on the host | **1 ms** | **12 ms** |
| Wake to first delivery, default consumer config, one message | **1569 ms** | **1728 ms** |
| Wake to first delivery, batch already full (`max_batch_size` reached) | **514 ms** | **600 ms** |

**The 1569 ms figure misses the project's 1 second target and is nowhere near
the 3 second ceiling, and the reason is not the wake.** It is
`max_batch_timeout`, which defaults to 1 second: a lone message is not
considered a ready batch until it has waited that long
(`isBatchReady`, `packages/queue/src/broker.ts:152-164`, the
`nowMs - row.oldest >= opts.maxBatchTimeoutSeconds * 1000` branch). Subtract
the batching wait, by sending a full batch of `max_batch_size` instead, and the
same path measures 514 ms p50. The wake itself is comfortably inside budget;
the default configuration adds a fixed second in front of it, deliberately, and
the project's number was never written with a batching broker in mind. Named
here rather than tuned quietly: see "What the numbers actually decompose into"
below.

## Setup, and the three ways this differed from `hobby daemon`

Host, because a benchmark without it is a rumour:

| | |
|---|---|
| Machine | Apple M5 Pro, 15 cores, 24 GB |
| OS | macOS 26.3.2 (build 25D2150), Darwin 25.3.0 arm64 |
| Filesystem | APFS |
| Container runtime | Docker client 29.7.1, server 29.4.0 (OrbStack), server linux/arm64, overlayfs, 15 CPUs / 11.7 GB to the VM |
| Node | v24.19.0 |
| miniflare | 4.20260730.0, pinned (`packages/worker/src/runtime-image.ts:21`) |
| Repo | branch `queues` at d7f996f |

The daemon under test was the **real one**: `createDaemonContext`, `reconcile`
and `startDaemon` from `packages/cli/dist/src/daemon/`, so the real queue tick
(`startQueueTick`, `server.ts:346`), the real enqueue listener
(`startQueueEndpoint`, `server.ts:331`), the real wake (`getOrCreateWake`) and
the real kind registry. Three deviations from what `hobby daemon` itself does
(`cmdDaemon`, `packages/cli/src/cli/commands.ts:227`), all deliberate, none of
them in the queue path:

1. **The box-wide lock was taken at `/tmp/hobby-daemon-task18.lock`, not
   `/tmp/hobby-daemon.lock`.** The author's own daemon was already running and
   holding the real lock:

   ```
   $ cat /tmp/hobby-daemon.lock
   {"pid":82729,"home":"/Users/uzairhayat/.hobby","startedAt":"2026-08-14T07:01:07.119Z"}
   $ ps -p 82729 -o pid=,command=
   82729 node packages/cli/bin/hobby.js daemon
   ```

   That daemon was not killed, not signalled and not touched. It is still
   running, still holding its own lock, and the same two lines print unchanged
   after this run. The lock exists to stop two daemons contending over Docker
   and over one host port range, so this run used a separate `HOBBY_HOME`, a
   separate store, and every daemon-level port moved out of the way
   (`proxyPort` 55432, `httpPort` 55433, `queuePort` 55434, plus a measurement
   listener on 55435). The one range that could NOT be moved is the worker
   port range, 35433 to 45432, which is a constant
   (`packages/worker/src/worker.ts:56-57`), so this run's worker took 35433 and
   35434 from an empty store. That is a real hazard, checked rather than
   assumed: the other daemon's only worker, `blog/cron`, holds 35433 in its own
   store but is `undeployed` with `image: null`, so it has no container and
   nothing to bind with. Anyone repeating this on a box where that is not true
   should stop the other daemon instead.
2. **`apiPort` was passed as `null`**, so Studio's loopback listener never
   started. Nothing here is a Studio client.
3. **`HOBBY_HOME` was `/tmp/hobby-t18`, not a path under the session
   scratchpad.** Not a preference: macOS caps a unix socket path at 104 bytes
   and the scratchpad path made `hobby.sock` 122, which fails at `listen()`
   with `EINVAL: invalid argument`. Worth knowing, because it is a failure a
   user with a deep home directory could hit.

Everything else was driven through the shipped CLI (`hobby deploy`,
`hobby wake`, `hobby sleep`, `hobby queue ls`, `hobby queue peek`,
`hobby queue send`, `hobby rm`) against that daemon's unix socket.

`sleepAfterSeconds` was set to `null`, so the hibernator never chose to sleep
anything on its own. Every stop in both runs is an explicit `hobby sleep`. That
makes the runs deterministic and it means **`queueDeliveryGuard` was never
exercised here**: it is covered by unit tests only, and still is.

### The fixture

One worker, two producer bindings, one consumer, one Durable Object.
`wrangler.toml`, verbatim:

```toml
name = "qverify"
main = "src/index.ts"
compatibility_date = "2026-08-01"

[vars]
BEACON_URL = "http://host.docker.internal:55435/beacon"

[[queues.producers]]
queue = "survive-q"
binding = "SURVIVE_Q"

[[queues.producers]]
queue = "bench-q"
binding = "BENCH_Q"

[[queues.consumers]]
queue = "survive-q"
max_batch_size = 5
max_batch_timeout = 1

[[durable_objects.bindings]]
name = "RECORDER"
class_name = "Recorder"
```

Two producer bindings on one worker is deliberate. The control channel
verification (`2026-08-14-control-channel-verified.md`) closed with exactly
this gap: `wrappedBindings`' per-entry `bindings` object was read out of
miniflare's `.d.ts` but "a worker with two or more distinct producer bindings
has not yet been run for real." It has now, and both bindings work, each
posting to its own queue name.

`bench-q` is declared as a producer and never as a consumer, so
`drainableQueues` (`packages/cli/src/daemon/queues.ts:89`) skips it and the tick
never drains it. That is what makes it usable as an enqueue-latency target with
nothing racing the measurement.

The user worker, `src/index.ts`, in the parts that matter. `Recorder` is a
`DurableObject` whose `record()` inserts into its own SQLite storage, which
lands on the host under `<resourceDir>/do/<resourceId>-Recorder/*.sqlite`; that
is the durable, host-readable record RUN 2 requires, written from inside
`queue()` and therefore unfakeable by anything on the host:

```ts
export class Recorder extends DurableObject {
  constructor(ctx: any, env: any) {
    super(ctx, env)
    ctx.storage.sql.exec(
      'CREATE TABLE IF NOT EXISTS processed (msg_id TEXT PRIMARY KEY, queue TEXT, body TEXT, attempts INTEGER, at_ms INTEGER)'
    )
  }
  record(rows) { /* INSERT OR REPLACE one row per message, returns the new count */ }
  count() { /* SELECT count(*) */ }
}

export default {
  async fetch(request, env) {
    // GET /send?n=&delay=&tag=   -> n x await env.SURVIVE_Q.send({...}, { delaySeconds })
    // GET /bench?n=              -> n x (t0 = Date.now(); await env.BENCH_Q.send(...); push(Date.now() - t0))
  },
  async queue(batch, env) {
    // The beacon FIRST, before anything else, so the moment the host records
    // is as close as possible to "queue() started running".
    await fetch(`${env.BEACON_URL}?queue=..&n=..&id=..&body=..`)
    const total = await recorder(env).record(batch.messages.map(/* ... */))
    for (const message of batch.messages) console.log('QUEUE_HANDLER ...')
  },
}
```

The beacon listener is not part of hobby. It is an `http.Server` inside the
harness process that appends `{at: Date.now(), url}` to a file. It exists so
that both ends of "wake to first delivery" are read off **one** clock, the
host's, with nothing depending on the container's clock agreeing with it.

### The deploy

```
$ ./hb deploy ./fixture --project qverify --name api
deployed qverify/api
  image     hobby/qverify-api-worker:1786693077
  url       https://api.qverify.localhost

It is asleep. The first request wakes it.
```

```
$ ./hb queue ls qverify
qverify
  survive-q  depth 0  empty  consumer api  no dlq
  bench-q  depth 0  empty  consumer (none)  no dlq
```

Both queues were auto-created from the manifest, `survive-q` claimed `api` as
its consumer, `bench-q` correctly has none. No `hobby queue create` was run at
any point.

```
worker api 3b613dc3-ccd0-4aba-a70f-3ef2a372f8a6 sleeping {"hostPort":35433,"controlPort":35434}
queue survive-q f1d8bab4-5912-4990-829f-27caf8883c18 running {"hostPort":0,"consumerResourceId":"3b613dc3-ccd0-4aba-a70f-3ef2a372f8a6","retentionSeconds":345600,"maxBatchSize":5,"maxBatchTimeoutSeconds":1}
queue bench-q e3923d29-adb1-4d01-9d11-42915f72ee57 running {"hostPort":0,"consumerResourceId":null,"retentionSeconds":345600,"maxBatchSize":null,"maxBatchTimeoutSeconds":null}
```

Both queues read `running` and never changed state, which is what the design
says a queue does. The consumer's tuning keys were copied onto the queue row
from the manifest and the ones the manifest omitted stayed `null`.

## RUN 1: survival

Wake the worker, and confirm it is genuinely serving:

```
$ ./hb wake qverify/api
api  worker  running  api.qverify.localhost
$ docker ps --filter name=hobby-qverify --format '{{.Names}}\t{{.Status}}\t{{.Ports}}'
hobby-qverify-api	Up Less than a second	127.0.0.1:35433->8787/tcp, 127.0.0.1:35434->8788/tcp
```

Both ports are published on the host **loopback only**, which is what the
design says they should be.

Three messages, through the real producer binding inside the container, each
delayed 60 seconds so none can be delivered while the checks below run:

```
$ curl -sS 'http://127.0.0.1:35433/send?n=3&delay=60&tag=survive'
{"sent":[{"ids":["01KZZKBBQYYXF0EWCBXWBQS3VV"]},{"ids":["01KZZKBBQZ9VK00TVKQMST8BJD"]},{"ids":["01KZZKBBR0KWZPMRMP63NXDV24"]}]}
```

On the host, in the queue's own sqlite file, before anything is stopped:

```
$ sqlite3 -header -column /tmp/hobby-t18/projects/qverify/survive-q/queue/messages.sqlite \
    "select id, content_type, bytes, attempts, lease_id, enqueued_at, visible_at, visible_at - enqueued_at as delay_ms from messages order by id;"
id                          content_type  bytes  attempts  lease_id  enqueued_at    visible_at     delay_ms
--------------------------  ------------  -----  --------  --------  -------------  -------------  --------
01KZZKBBQYYXF0EWCBXWBQS3VV  json          94     0                   1786693136126  1786693196126  60000   
01KZZKBBQZ9VK00TVKQMST8BJD  json          94     0                   1786693136127  1786693196127  60000   
01KZZKBBR0KWZPMRMP63NXDV24  json          94     0                   1786693136128  1786693196128  60000
```

`attempts` is 0 before any delivery, which is what makes the `attempts=1` the
handler later sees the *first* attempt rather than a second one.

The bodies are the codec's own encoding, not JSON, and the `Date` inside each
body survived as a tagged node rather than a string:

```
$ sqlite3 /tmp/hobby-t18/projects/qverify/survive-q/queue/messages.sqlite "select id, body from messages order by id;"
01KZZKBBQYYXF0EWCBXWBQS3VV|[["object",[["tag",1],["i",2],["at",3]]],["prim","survive"],["prim",0],["date",1786693136113]]
01KZZKBBQZ9VK00TVKQMST8BJD|[["object",[["tag",1],["i",2],["at",3]]],["prim","survive"],["prim",1],["date",1786693136127]]
01KZZKBBR0KWZPMRMP63NXDV24|[["object",[["tag",1],["i",2],["at",3]]],["prim","survive"],["prim",2],["date",1786693136128]]
```

```
$ ./hb queue peek qverify/survive-q
01KZZKBBQYYXF0EWCBXWBQS3VV  attempts 0  {"tag":"survive","i":0,"at":"2026-08-14T07:38:56.113Z"}
01KZZKBBQZ9VK00TVKQMST8BJD  attempts 0  {"tag":"survive","i":1,"at":"2026-08-14T07:38:56.127Z"}
01KZZKBBR0KWZPMRMP63NXDV24  attempts 0  {"tag":"survive","i":2,"at":"2026-08-14T07:38:56.128Z"}
```

Now stop the worker:

```
$ ./hb sleep qverify/api
api  worker  sleeping  api.qverify.localhost
$ docker ps --filter name=hobby-qverify --format '{{.Names}}\t{{.Status}}'
$ docker ps -a --filter name=hobby-qverify --format '{{.Names}}\t{{.Status}}'
hobby-qverify-api	Exited (143) Less than a second ago
```

The first `docker ps` prints nothing at all: no running container. The second,
with `-a`, shows the stopped one. **Precisely: hobby's sleep is a `docker
stop`, so the container object still exists and the process does not.** Three
further checks, because "gone" should mean gone:

```
$ docker inspect -f '{{.Name}} running={{.State.Running}} pid={{.State.Pid}} exitcode={{.State.ExitCode}}' hobby-qverify-api
/hobby-qverify-api running=false pid=0 exitcode=143
$ lsof -nP -iTCP:35433 -sTCP:LISTEN
$ lsof -nP -iTCP:35434 -sTCP:LISTEN
$ curl -sS -m 3 http://127.0.0.1:35433/
curl: (7) Failed to connect to 127.0.0.1 port 35433 after 0 ms: Couldn't connect to server
```

No process, no listener on either port, and a connection refused. **The
messages, on the host, with all of that true:**

```
$ sqlite3 -header -column /tmp/hobby-t18/projects/qverify/survive-q/queue/messages.sqlite \
    "select id, content_type, bytes, attempts, lease_id, enqueued_at, visible_at from messages order by id;"
id                          content_type  bytes  attempts  lease_id  enqueued_at    visible_at   
--------------------------  ------------  -----  --------  --------  -------------  -------------
01KZZKBBQYYXF0EWCBXWBQS3VV  json          94     0                   1786693136126  1786693196126
01KZZKBBQZ9VK00TVKQMST8BJD  json          94     0                   1786693136127  1786693196127
01KZZKBBR0KWZPMRMP63NXDV24  json          94     0                   1786693136128  1786693196128
$ sqlite3 ... "select count(*) from messages;"
3
```

That is the whole point of the capability, and it holds. Start the worker
again, before the 60 second delay elapses, so the delivery below is against a
worker this run started by hand rather than one the tick woke:

```
$ node -e "console.log('wake issued at', new Date().toISOString())"
wake issued at 2026-08-14T07:39:44.034Z
$ ./hb wake qverify/api
api  worker  running  api.qverify.localhost
$ node -e "console.log('wake returned at', new Date().toISOString())"
wake returned at 2026-08-14T07:39:44.696Z
```

Polling the depth from the host, every 100 ms, printing only changes
(`visible_at` for all three was 07:39:56.126Z):

```
2026-08-14T07:39:51.696Z depth = 3
2026-08-14T07:39:57.344Z depth = 0
```

Three to zero, right after the delay expired. What the handler recorded, read
out of the Durable Object's SQLite file on the host:

```
$ sqlite3 -header -column /tmp/hobby-t18/projects/qverify/api/do/3b613dc3-ccd0-4aba-a70f-3ef2a372f8a6-Recorder/20cf2e082c44ba24b3c821d99cc97f12dc89429dcb07492348cc3a9664a1ad5f.sqlite \
    "select msg_id, queue, body, attempts, at_ms from processed order by msg_id;"
msg_id                      queue      body                                                     attempts  at_ms        
--------------------------  ---------  -------------------------------------------------------  --------  -------------
01KZZKBBQYYXF0EWCBXWBQS3VV  survive-q  {"tag":"survive","i":0,"at":"2026-08-14T07:38:56.113Z"}  1         1786693197276
01KZZKBBQZ9VK00TVKQMST8BJD  survive-q  {"tag":"survive","i":1,"at":"2026-08-14T07:38:56.127Z"}  1         1786693197276
01KZZKBBR0KWZPMRMP63NXDV24  survive-q  {"tag":"survive","i":2,"at":"2026-08-14T07:38:56.128Z"}  1         1786693197276
```

The three ids are exactly the three ids the producer returned before the sleep.
And the container's own log, which is the only place the handler's view of the
message is visible:

```
$ docker logs hobby-qverify-api 2>&1 | tail -3
QUEUE_HANDLER queue=survive-q id=01KZZKBBQYYXF0EWCBXWBQS3VV attempts=1 timestampIsDate=true body={"tag":"survive","i":0,"at":"2026-08-14T07:38:56.113Z"} bodyDateIsDate=true total=3
QUEUE_HANDLER queue=survive-q id=01KZZKBBQZ9VK00TVKQMST8BJD attempts=1 timestampIsDate=true body={"tag":"survive","i":1,"at":"2026-08-14T07:38:56.127Z"} bodyDateIsDate=true total=3
QUEUE_HANDLER queue=survive-q id=01KZZKBBR0KWZPMRMP63NXDV24 attempts=1 timestampIsDate=true body={"tag":"survive","i":2,"at":"2026-08-14T07:38:56.128Z"} bodyDateIsDate=true total=3
```

`bodyDateIsDate=true`: a `Date` put into a message body by a container that was
then destroyed came back out of a different container's process as a real
`Date`. That is the codec doing the job it exists for, across a sleep, which is
the case no unit test can create.

**RUN 1: PASS.**

## RUN 2: the wake

The feature. Consumer `sleeping`, no HTTP request of any kind, a message
arrives, and the consumer starts itself.

```
$ ./hb sleep qverify/api
api  worker  sleeping  api.qverify.localhost
$ docker ps --filter name=hobby-qverify --format '{{.Names}}\t{{.Status}}'
$ docker ps -a --filter name=hobby-qverify --format '{{.Names}}\t{{.Status}}'
hobby-qverify-api	Exited (143) Less than a second ago
$ lsof -nP -iTCP:35433 -sTCP:LISTEN
$ lsof -nP -iTCP:35434 -sTCP:LISTEN
```

Nothing running, nothing listening. The baseline of what the handler has ever
recorded:

```
$ sqlite3 .../20cf2e08....sqlite "select count(*) as rows_before_run2 from processed;"
3
```

One message. `hobby queue send` goes to the daemon over its unix socket
(`POST /v1/resources/:id/queue/messages`, `packages/cli/src/cli/client.ts:324`).
**Nothing in this step touches the container, on any port, in any protocol.**

```
$ node -e "console.log('send issued at', new Date().toISOString())"
send issued at 2026-08-14T07:41:21.876Z
$ ./hb queue send qverify/survive-q '{"wake":"me","run":2}'
sent 01KZZKFT57S7X4DP5ENTT7VH89
$ node -e "console.log('send returned at', new Date().toISOString())"
send returned at 2026-08-14T07:41:21.978Z
```

Polling `docker ps` from the host, every 150 ms, and issuing nothing else:

```
2026-08-14T07:41:28.430Z docker ps: hobby-qverify-api Up 5 seconds
2026-08-14T07:41:29.497Z docker ps: hobby-qverify-api Up 6 seconds
2026-08-14T07:41:30.396Z docker ps: hobby-qverify-api Up 7 seconds
2026-08-14T07:41:31.449Z docker ps: hobby-qverify-api Up 8 seconds
2026-08-14T07:41:32.362Z docker ps: hobby-qverify-api Up 9 seconds
2026-08-14T07:41:33.410Z docker ps: hobby-qverify-api Up 10 seconds
2026-08-14T07:41:34.497Z docker ps: hobby-qverify-api Up 11 seconds
2026-08-14T07:41:35.378Z docker ps: hobby-qverify-api Up 12 seconds
2026-08-14T07:41:36.433Z docker ps: hobby-qverify-api Up 13 seconds
2026-08-14T07:41:37.494Z docker ps: hobby-qverify-api Up 14 seconds
2026-08-14T07:41:38.395Z docker ps: hobby-qverify-api Up 15 seconds
2026-08-14T07:41:39.450Z docker ps: hobby-qverify-api Up 16 seconds
2026-08-14T07:41:40.363Z docker ps: hobby-qverify-api Up 17 seconds
```

(The polling loop started after the send and its first `docker ps` completed at
07:41:28.430 reporting "Up 5 seconds", so the container had already been
started by then. The precise start-to-handler interval is measured properly
below, not read off this loop.)

The beacon the handler fetched as its first statement, timestamped by the host:

```
{"at":1786693283781,"url":"/beacon?queue=survive-q&n=1&id=01KZZKFT57S7X4DP5ENTT7VH89&body=%7B%22wake%22%3A%22me%22%2C%22run%22%3A2%7D"}
```

Same id the send returned. The Durable Object storage, on the host:

```
$ sqlite3 -header -column .../20cf2e08....sqlite "select msg_id, queue, body, attempts, at_ms from processed order by at_ms, msg_id;"
msg_id                      queue      body                                                     attempts  at_ms        
--------------------------  ---------  -------------------------------------------------------  --------  -------------
01KZZKBBQYYXF0EWCBXWBQS3VV  survive-q  {"tag":"survive","i":0,"at":"2026-08-14T07:38:56.113Z"}  1         1786693197276
01KZZKBBQZ9VK00TVKQMST8BJD  survive-q  {"tag":"survive","i":1,"at":"2026-08-14T07:38:56.127Z"}  1         1786693197276
01KZZKBBR0KWZPMRMP63NXDV24  survive-q  {"tag":"survive","i":2,"at":"2026-08-14T07:38:56.128Z"}  1         1786693197276
01KZZKFT57S7X4DP5ENTT7VH89  survive-q  {"wake":"me","run":2}                                    1         1786693283782
$ sqlite3 /tmp/hobby-t18/projects/qverify/survive-q/queue/messages.sqlite "select count(*) as depth_after_run2 from messages;"
0
$ docker logs hobby-qverify-api 2>&1 | tail -1
QUEUE_HANDLER queue=survive-q id=01KZZKFT57S7X4DP5ENTT7VH89 attempts=1 timestampIsDate=true body={"wake":"me","run":2} bodyDateIsDate=false total=4
```

And, after everything else in this session had finished, with the container
stopped again so nothing could be holding the write in memory:

```
$ ./hb sleep qverify/api
api  worker  sleeping  api.qverify.localhost
$ docker ps --filter name=hobby-qverify --format '{{.Names}} {{.Status}}'
$ sqlite3 -header -column .../20cf2e08....sqlite "select count(*) as processed_rows, min(at_ms) as first_at, max(at_ms) as last_at from processed;"
processed_rows  first_at       last_at      
--------------  -------------  -------------
65              1786693197276  1786693516784
```

65 is every message this session ever enqueued onto `survive-q`: 3 (RUN 1) + 1
(RUN 2) + 1 (a first aborted measurement iteration, see below) + 10 (the
single-message timing loop) + 50 (the full-batch timing loop). `survive-q`'s
own depth was 0 at the end. **Nothing was lost and nothing was duplicated
across 65 messages and 24 stop-and-wake cycles.**

**RUN 2: PASS.**

## The numbers

### Enqueue latency: `send()` inside the container to the row on the host

Measured inside the container, around the awaited `send()`, against `bench-q`,
which has no consumer and is therefore never drained. Ten sends in one request,
plus two repeats of the same ten to show the shape:

```
host-observed total for the /bench request: 57 ms
container-measured samples (ms): [12,1,1,1,1,0,1,1,1,0]

repeat-2: host-total=31ms container-sum=9ms  samples=[2,1,1,1,1,0,1,1,1,0]
repeat-3: host-total=8ms  container-sum=6ms  samples=[1,0,1,0,1,1,0,1,0,1]
```

**Headline set, the first ten: p50 1 ms, p95 12 ms**, and the p95 is entirely
the first sample of a cold binding. The steady state is 0 to 1 ms.

All thirty landed on the host, counted from the host:

```
$ sqlite3 /tmp/hobby-t18/projects/qverify/bench-q/queue/messages.sqlite "select count(*) as bench_rows_on_host from messages;"
30
$ ./hb queue ls qverify
qverify
  survive-q  depth 0  empty  consumer api  no dlq
  bench-q  depth 30  oldest 31s ago  consumer (none)  no dlq
```

**What was measured versus what is inferred.** Measured: the delta between two
`Date.now()` reads inside workerd that bracket exactly one awaited I/O, the
producer shim's `fetch` to the daemon. Inferred, and worth stating because
workerd's clock only advances on I/O: `t0` is the timestamp of the *previous*
I/O completion, which in this loop is the previous send's own response, so the
delta approximates the send's duration and slightly over-reads on the first
iteration, where the previous I/O was the inbound request arriving. That is
exactly the shape of the 12 / 2 / 1 first samples across the three runs. Also
inferred rather than separately measured: the row is committed marginally
before this number ends, because the daemon writes it and then replies
(`handleEnqueue`, `packages/cli/src/daemon/queue-endpoint.ts:298-303`), so the
figure is an upper bound that includes the response hop back. Cross-check
against a clock that is definitely the host's: the whole `/bench?n=10` request
took 8 ms wall time on the third run, which cannot be true if ten enqueues cost
meaningfully more than 1 ms each.

### Wake to first delivery: enqueue returning to `queue()` running

Both timestamps are the harness process's own `Date.now()`, on the host. `t0`
is taken on the enqueue response's `end` event; `t1` is the beacon the handler
fetches as its first statement, timestamped by the beacon server. **No
container clock is read.** Each iteration stops the worker first and asserts
the store says `sleeping` before enqueuing.

Ten iterations, one message each, the default consumer configuration:

```
iteration 0: enqueue returned at 1786693417575, queue() handler ran at 1786693419303, delta 1728 ms (id 01KZZKKYK7PRR6EJFQT5834YTC)
iteration 1: enqueue returned at 1786693420965, queue() handler ran at 1786693422503, delta 1538 ms (id 01KZZKM1X4S42R3Z5D3NR9AAVQ)
iteration 2: enqueue returned at 1786693424156, queue() handler ran at 1786693425719, delta 1563 ms (id 01KZZKM50VMAYH5D4TQK9N7ZPX)
iteration 3: enqueue returned at 1786693427364, queue() handler ran at 1786693428914, delta 1550 ms (id 01KZZKM853HXEC8NF986QMB2E0)
iteration 4: enqueue returned at 1786693430559, queue() handler ran at 1786693432138, delta 1579 ms (id 01KZZKMB8ZMEVK0JWTFSQTYC1E)
iteration 5: enqueue returned at 1786693433785, queue() handler ran at 1786693435354, delta 1569 ms (id 01KZZKMEDSNR86GAMGXQCZN59K)
iteration 6: enqueue returned at 1786693437005, queue() handler ran at 1786693438690, delta 1685 ms (id 01KZZKMHJCNS1NXS20EGAEV4A5)
iteration 7: enqueue returned at 1786693440353, queue() handler ran at 1786693441941, delta 1588 ms (id 01KZZKMMV0AED913W3EQJVTB4Z)
iteration 8: enqueue returned at 1786693443578, queue() handler ran at 1786693445169, delta 1591 ms (id 01KZZKMQZTJXGKCQG9YC1SJE4J)
iteration 9: enqueue returned at 1786693446841, queue() handler ran at 1786693448401, delta 1560 ms (id 01KZZKMV5RW4GE3NH4YR9WDM44)

samples (ms): [1728,1538,1563,1550,1579,1569,1685,1588,1591,1560]
sorted  (ms): [1538,1550,1560,1563,1569,1579,1588,1591,1685,1728]
min 1538  p50 1569  p95 1728  max 1728
```

The same ten, with `max_batch_size` (5) messages per iteration instead of one,
so `isBatchReady` returns on its count branch and the batching wait is removed:

```
iteration 0: last enqueue returned at 1786693496667, queue() handler ran at 1786693497267, delta 600 ms, batch size 5
iteration 1: last enqueue returned at 1786693498938, queue() handler ran at 1786693499479, delta 541 ms, batch size 5
iteration 2: last enqueue returned at 1786693501125, queue() handler ran at 1786693501658, delta 533 ms, batch size 5
iteration 3: last enqueue returned at 1786693503317, queue() handler ran at 1786693503832, delta 515 ms, batch size 5
iteration 4: last enqueue returned at 1786693505489, queue() handler ran at 1786693505984, delta 495 ms, batch size 5
iteration 5: last enqueue returned at 1786693507648, queue() handler ran at 1786693508127, delta 479 ms, batch size 5
iteration 6: last enqueue returned at 1786693509791, queue() handler ran at 1786693510305, delta 514 ms, batch size 5
iteration 7: last enqueue returned at 1786693511949, queue() handler ran at 1786693512458, delta 509 ms, batch size 5
iteration 8: last enqueue returned at 1786693514122, queue() handler ran at 1786693514612, delta 490 ms, batch size 5
iteration 9: last enqueue returned at 1786693516258, queue() handler ran at 1786693516784, delta 526 ms, batch size 5

samples (ms): [600,541,533,515,495,479,514,509,490,526]
sorted  (ms): [479,490,495,509,514,515,526,533,541,600]
min 479  p50 514  p95 600  max 600
```

Every one of the twenty iterations reported `batch size` matching what was sent,
so no iteration delivered a stale message from a previous one.

### What the numbers actually decompose into

```
  1569 ms (p50, one message, default config)
=  1000 ms  max_batch_timeout, isBatchReady's wait branch
+     ~55 ms  average tick jitter and the tick's own work
+    ~514 ms  wake: docker start, Miniflare boot, readiness on BOTH ports,
               lease, POST /queue, handler entry
```

The 514 ms figure is measured directly (the full-batch loop above); the 1000 ms
is `max_batch_timeout` read off the config; the remainder is the difference,
which is where tick jitter lives, and that part is arithmetic rather than a
separate measurement.

Three things follow, and none of them is a code change made here:

1. **The wake is not the problem.** 514 ms p50 / 600 ms p95, including a full
   container cold start with a two-port readiness probe, is inside the 1 second
   target on its own.
2. **The default configuration cannot beat 1 second for a single message, by
   construction.** `max_batch_timeout` defaults to 1 second, taken from
   Miniflare's own constants so local behaviour matches the simulator (the
   design's stated reason, and a good one). Cloudflare's production default is
   5 seconds, so a user moving code here from Cloudflare will find this
   *faster* than they are used to, not slower. A user who wants lower latency
   sets `max_batch_timeout = 0` in their wrangler file, which the manifest
   parser already accepts as a number.
3. **The project's "1 second target" was written for a connection-triggered
   wake and is a slightly wrong frame for a batching broker.** Whether the
   number a queue should be judged on is end-to-end (1569 ms) or wake-only
   (514 ms) is a judgment this run does not get to make on its own. Both are
   filed, plainly labelled, so whoever decides is deciding against measurements
   rather than against a single averaged figure.

## What this found

### The readiness probe writes a stack trace on every start

Not a failure, and not fixed here, but it is the first thing anyone reading
`hobby logs` on a queue-bound worker will see, and it looks exactly like the
thing they are debugging:

```
$ docker logs hobby-qverify-api 2>&1 | head -4
hobby: worker listening on http://127.0.0.1:8787/
hobby: control channel listening on container port 8788, published on host port 35434
hobby: control channel error: SyntaxError: Unexpected end of JSON input
    at async ProxyServer.fetch (file:///hobby/node_modules/miniflare/src/workers/core/proxy.worker.ts:173:11)
```

Once per container start, every start, for every worker that declares a queue
binding. The cause is a direct read of two files rather than a guess:
`defaultProbeFactory` (`packages/worker/src/worker.ts:366`) probes the control
port with `httpProbe(config.controlPort, { method: 'POST', path: '/queue' })`,
which sends **no body**, and `CONTROL_SOURCE`
(`packages/worker/src/runtime-image.ts:293`) opens with
`await request.json()`, which throws on an empty body. The runner catches it,
logs it with a stack, and returns a 500. The probe is satisfied, because it
only requires a real status line, so the worker is correctly recorded
`running`.

Two consequences worth writing down, in decreasing severity:

- **A real control channel failure is now indistinguishable from this one in
  the logs**, because both arrive through the same `console.error` in
  `RUNNER_SOURCE`. That is the observability cost.
- **The readiness probe currently succeeds via an exception path.** It is
  correct today for the reason above, but it is resting on the control worker
  continuing to *fail* in a way that still produces a response.

Deliberately not fixed in this task. The image is the artifact these numbers
were measured against, and changing `runtime-image.ts` at the end of a
verification would mean the filed numbers describe a container that no longer
exists. The smallest correct fix is in `CONTROL_SOURCE`: read the body as text,
and answer an empty one as a readiness ping without logging. Filed as a
follow-up in `docs/queues/CLAUDE.md`.

### `hobby deploy` does not print the effective consumer values

The design says it does. It does not; see "Corrections to the spec" below.

### One measurement script bug, not a product bug

The first attempt at the timing loop asserted `status === 200` on the enqueue
route, which answers `201`. It failed on iteration 0 *after* enqueuing, so that
message was delivered normally on the next tick and shows up in the 65 count
above. Recorded because it is the reason 65 is not 64.

### Nothing else went wrong

The daemon logged nothing at all across the whole session other than its own
startup lines: no tick failures, no delivery errors, no expired leases, no
retries, no dead letters. That is stated as an observation, not as evidence
that those paths work; none of them was provoked here.

## What this does not tell us

- **Nothing about Linux, and nothing about a five dollar VPS.** The enqueue
  listener's Linux bridge-gateway bind (`queueEndpointHosts`,
  `packages/cli/src/daemon/server.ts:120`) is still reasoned and never run.
  This is a Mac, like every other measurement in this repo.
- **Nothing about `queueDeliveryGuard`.** `sleepAfterSeconds` was `null`, so
  the hibernator never ran a sleep decision. Whether it actually refuses to
  sleep a worker holding a lease is still covered only by unit tests.
- **Nothing about retries, dead letters, or lease expiry against a real
  container.** No handler threw, no container died mid-batch. Those are
  exercised against a fake clock in `packages/queue/test/` and have never met
  Docker.
- **Nothing about `hobby daemon` itself.** Three lines are untested by this run
  for the lock reason above: `cmdDaemon`'s own `acquireDaemonLock` at the real
  path, and the `apiPort` branch of `startDaemon`.
- **Nothing about concurrency.** One queue, one consumer, one message at a
  time. The tick's sequential loop over queues was never given a second queue
  to be slow about.
- **Nothing about a backlog larger than 5.** The deepest `survive-q` ever got
  was 5.

## Corrections to the spec

`docs/queues/specs/2026-08-13-queues-design.md` is a dated artifact and dated
artifacts are immutable, so nothing in its body was rewritten. Two things were
changed, both marked as corrections made on 2026-08-14, because a shipped spec
that disagrees with the machine is worse than no spec:

1. **Its Status line said "Nothing in this document is built ... implementation
   has not started."** That was the first line a reader met and it is now
   false in every particular. Corrected, with a pointer here.
2. **An addendum** records the three claims this run contradicts or settles:
   `hobby deploy` does not print the effective consumer values (it prints the
   image and the URL and nothing about queues, and neither does
   `hobby queue ls`); open question 1, `wrappedBindings` with an outbound
   fetch, is settled, now including the two-producer case; open question 4,
   two workers binding one queue, is designed and built rather than "not yet
   designed".

## Cleanup

```
$ ./hb rm qverify --yes
deleted qverify
$ ./hb ls
no projects yet. run `hobby new <name>` to create one.
```

`docker ps -a`, `docker images` and `docker network ls` were captured before
the session started and compared afterwards. All three are **identical**: the
same 6 containers, the same 14 images, the same 12 networks. `hobby rm` removed
the container, the image and the project network on its own. The harness daemon
was sent SIGTERM and exited, releasing `/tmp/hobby-daemon-task18.lock`;
`/tmp/hobby-t18` was deleted. The author's daemon at pid 82729 is still running
and still holds `/tmp/hobby-daemon.lock`.

## Reproducing

The fixture (`wrangler.toml`, `src/index.ts`) and the three harness scripts
(`daemon.mjs`, `wake-latency.mjs`, `wake-latency-full-batch.mjs`) lived in a
scratchpad directory and were not committed, matching what the control channel
verification did with its own. The fixture is quoted above in the parts that
matter; the harness is 50 lines of `createDaemonContext` + `reconcile` +
`startDaemon` plus an `http.Server` that appends `Date.now()` to a file.
Nothing under `packages/` was touched by this verification: the code under test
is what was already committed at d7f996f.
