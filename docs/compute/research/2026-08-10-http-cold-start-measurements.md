# HTTP cold start, measured

Status: NOTES. Real numbers from one machine. The five dollar VPS half of the
matrix is NOT done, and the budget stays provisional until it is.
Date:   2026-08-10

Closes the first half of M10 in
`docs/compute/specs/2026-08-10-phase-2-compute-design.md`. The budget it tests
against is 1 second target, 3 second hard ceiling, for both kinds, with a
300ms stretch target for `worker`.

## What was measured

End to end through the real wake router, not container start time.

The clock starts when the HTTP request is written and stops when the response
body has been read. Everything a browser actually waits for is inside it: the
router's hostname resolve, the wake call, the kind handler's container start,
its readiness wait, and the proxied response. A container-start figure would
have been a smaller and less honest number.

Each sample stops the resource first, so every one of them is a genuine cold
start rather than a warm hit.

## Results

```
app      n=10  min=113  p50=121  p95=133  max=133  (ms)
worker   n=10  min=289  p50=299  p95=321  max=321  (ms)
```

| | Target 1s | Ceiling 3s | Stretch 300ms |
|---|---|---|---|
| `app` p95 133ms | passes | passes | passes |
| `worker` p95 321ms | passes | passes | misses at p95, meets at p50 |

## Hardware, because a benchmark without it is a rumour

| | |
|---|---|
| Machine | Apple M5 Pro, 15 cores, 24 GB |
| OS | macOS 26.3.2 |
| Container runtime | Docker 29.4.0, server linux/arm64 |
| Node | v24.19.0 |
| Filesystem | APFS |

**This is a laptop, and it is the easy end of the matrix.** The Postgres cold
start work (`docs/proxy/research/2026-08-07-cold-start-measurements.md`) holds
the same shape of result and the same gap.

## What the two kinds are actually doing

`app` is a `node:22-bookworm-slim` image running a nine line HTTP server. 121ms
at p50 is close to the floor for "start a container and have a process bind a
port", and a real application with a framework to boot will be slower. Read it
as the cost hobby adds, not as what a Next.js app will do.

`worker` is Miniflare starting workerd inside the container. The ~180ms it
costs over `app` is that runtime coming up, and it buys the storage APIs
(ADR 0011). Worth noting plainly: a `worker` cold start is a CONTAINER start,
not an isolate start, because the author chose one workerd per worker over one
shared across a project. The sub-5ms isolate figure applies only once the
container is already running.

## What this does not tell us

- **Nothing about a five dollar VPS**, which is the machine the project is
  actually aimed at and the one where a 3 second ceiling could plausibly be
  hit. Until that is run, the budget is an assertion supported by one
  favourable data point.
- **Nothing about concurrency.** Every sample here is one request against an
  otherwise idle box. Ten simultaneous requests to ten sleeping resources on a
  small VPS is a different question and is not answered.
- **Nothing about a cold image cache.** Both images were already built and
  local. A first deploy pays a build (34 seconds for the worker, most of it
  installing miniflare and pulling the workerd binary), and that is a deploy
  cost, not a wake cost, but it is the number a user will see first.
- **Nothing about a real application.** A framework that reads config, opens a
  connection pool and warms a cache is doing more work than either fixture
  here.

## Method

`docker ps` was clean before and after. Both resources were created, measured,
destroyed, and their network removed, in an isolated `HOBBY_HOME` so nothing
touched an existing daemon or its projects.

The measurement script was written to the session scratchpad rather than to
the repository, since `docs/` takes no executables (see `docs/CLAUDE.md`). It
does three things worth repeating if this is re-run:

1. Uses `node:http` rather than `fetch`, because undici forbids setting the
   `Host` header and the `Host` header IS the routing key.
2. Stops the resource before every sample.
3. Reports p50 and p95 rather than a mean, because a mean hides exactly the
   tail this budget exists to bound.
