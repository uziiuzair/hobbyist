# App cold start on a five dollar VPS

Status: NOTES, measured 2026-08-22. Closes the last row of the published cold
start table that had only ever been measured on a laptop.

## Hardware

Two DigitalOcean droplets on ext4, kernel 6.8.0-124, Docker 29.7.2, both idle.

- **vm-01**: 1 vCPU, 458MB usable plus 2GB swap
- **vm-02**: 1 vCPU, 961MB, no swap

Measured with `scripts/measure-cold-start.sh KIND=app`, which deploys a 4.0MB
alpine and busybox-extras static server and times HTTP requests through the wake
router on `httpPort`. The router keys off the Host header, so this needs no
Caddy. Every request asserts HTTP 200.

## Results, milliseconds, client observed

| Run | Box | Image state | n | min | p50 | p95 | max |
|---|---|---|---|---|---|---|---|
| 1 | vm-02, 1GB | freshly built | 20 | 342 | 386 | 1546 | **3435** |
| 2 | vm-02, 1GB | cached | 20 | 350 | 405 | 632 | 911 |
| 3 | vm-01, 512MB | freshly built | 20 | 409 | 462 | 803 | 868 |

Warm baselines were 20 to 29ms across all three runs, an order of magnitude
below the Postgres runs' 86 to 102ms, because `curl` starts far faster than
`psql`. Net of that, app wake work is roughly **365 to 436ms at p50**.

## Apps wake faster than databases, by about a third

On the same hardware, same day:

| | p50 wake work |
|---|---|
| App | about 385ms |
| Postgres | about 537ms |

Expected: waking an app is a container start plus a first HTTP 200, while
waking Postgres is a container start plus polling until the database actually
accepts a query, and the second is strictly more work.

Against the laptop figures in
`docs/compute/research/2026-08-10-http-cold-start-measurements.md`, p50 121ms
and p95 133ms on an M5 Pro, a five dollar box is about **3.3x slower**. The
Postgres ratio measured the same day was 3.6x, so the two agree and neither
suggests a structural problem on slow hardware.

## One wake in sixty exceeded the three second ceiling

Run 1, on its first container start after building the image, produced a single
**3435ms** wake. That is past the 3 second hard ceiling, which the project
treats as a release blocker rather than a slow path, so it is recorded here
rather than averaged away.

What is known about it:

- It happened on the first start after an image build, when the layers had not
  been read before.
- It did not reproduce. Run 2 on the same box with the image cached had a max of
  911ms, and run 3 on the *other* box, also freshly built, had a max of 868ms.
- Its shape matches the 1336ms Postgres outlier measured the same day on the
  same class of hardware, which was attributed to CPU steal on a shared vCPU.

So the honest statement is that one of sixty app wakes crossed the ceiling, the
cause is not established, and the two candidates are a cold image cache and a
noisy neighbour. Distinguishing them needs a run that drops caches between
iterations, which the current harness does not do and which
`docs/proxy/research/2026-08-07-cold-start-measurements.md` already records as a
gap in the M0 harness for the same reason.

**This matters more than the number suggests.** The slow case is the first
request after a deploy, which is exactly when someone is watching, having just
run `hobby deploy` and clicked the URL.

## What this does not cover

- **Worker wake is still laptop only.** The published p50 299ms and p95 321ms
  come from an M5 Pro. Workers are the slowest kind and the most likely to
  breach on cheap hardware, and `KIND=worker` does not exist in the harness yet.
- One provider, one region.
- The app is a static file server. A real app with a runtime to boot will be
  slower, and the readiness probe waits for a real HTTP status, so that cost is
  the application's rather than Hobbyist's.
