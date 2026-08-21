# Cold start on a five dollar VPS

Status: NOTES, measured 2026-08-22. Two runs: a 512MB box with swap, and a
1GB box without. Revision 2 adds the second run and the comparison, which is
the more interesting half.

The measurement the project had been hedging against since M0. Every published
cold start number came from Apple silicon, and the budget was written for a
cheap VPS that nobody had run this on. This is that box.

## The hardware

| | |
|---|---|
| Provider | DigitalOcean, `ubuntu-s-1vcpu-512mb-10gb-nyc1` |
| CPU | 1 vCPU, reported as `DO-Regular` |
| RAM | 458MB usable, plus 2GB of swap added during install |
| Disk | 10GB, 3.9GB free after install |
| Filesystem | **ext4**, no reflink support |
| OS | Ubuntu 24.04, kernel 6.8.0-124-generic |
| Docker | 29.7.2, native |
| Other load | none |

The swap is not incidental. Without it the TypeScript build is killed and the
install never completes, so 2GB was added before this run. A reader reproducing
this needs the same.

## Method

`scripts/measure-cold-start.sh`, n=30. Measured through the shipped product,
not a spike harness: the real daemon, the real proxy on 5432, a real `psql`
client. Each iteration sleeps the resource, polls `hobby ls --json` until the
daemon reports it genuinely `sleeping` rather than merely asked to stop, settles
500ms, then times a connect and `select 1`. Every iteration asserts the query
returned `1`, so a fast failure cannot be recorded as a fast wake. A warm query
follows immediately, as the client's own baseline.

## Results, milliseconds, client observed

| | n | min | p50 | p95 | max | mean |
|---|---|---|---|---|---|---|
| Cold, end to end | 30 | 648 | **710** | **859** | 968 | 731 |
| Warm, already awake | 30 | 84 | 102 | 122 | 150 | 104 |

The warm row is `psql` process spawn plus connect plus query, which the cold row
also carries. Subtracting it gives the wake work itself:

- **wake, p50: about 608ms**
- **wake, p95: about 757ms**

## Against the budget

The budget is a 1 second target and a 3 second hard ceiling.

- **0 of 30 exceeded 1 second.**
- **0 of 30 exceeded 3 seconds.**
- The slowest single wake was 968ms, which is 32ms inside the target.

The project's central claim survives contact with the hardware it was aimed at.

## Three things worth reading carefully

**The first wake was the slowest, by a wide margin.** Iteration 1 was 968ms, the
maximum of the run, and the next 29 settled between 648 and 904. That first
figure is the cold page cache case, and it is also the one a real user
experiences: the first connection after an install or a reboot. Quoting 710ms
without saying that the genuinely cold case is nearer 970ms would be reporting
the easy half.

**The margin is thin at the top.** 968ms against a 1 second target leaves 3
percent of headroom. This box was otherwise idle. On a VPS also running an app,
a queue and a worker, which is the case the project sells, the top of the
distribution should be expected to cross 1 second. It stays far inside the 3
second ceiling, which is the number that actually matters, because that is where
ORM and pool connect timeouts begin firing.

**Swap is doing work here.** 458MB of RAM is below what Postgres, Docker and the
daemon want resident. The run was stable across 30 iterations, so it is not
thrashing, but these numbers belong to a 512MB box *with swap*, not to 512MB.

## Comparison with the published Apple silicon numbers

`docs/proxy/research/2026-08-07-cold-start-measurements.md` reports 170ms p50
and 186ms p95 for `baseline-alpine-poll25` on an M5 Pro under OrbStack. That is
the proxy's own internal span and excludes client startup, so the honest
comparison is against the 608ms wake delta rather than the 710ms total.

On that basis a five dollar VPS is roughly **3.6x slower at p50** than the most
generous hardware in the target range. Same order of magnitude, no structural
surprise, and both ends of the range are inside budget.

## What this does not close

- **One provider, one region, one run.** DigitalOcean NYC1, on one afternoon.
  Hetzner, Vultr and a Pi are all still unmeasured.
- **Page cache state was not controlled.** `drop_caches` was not run between
  iterations, so only the first measurement is genuinely cold. That is the same
  gap recorded for the M0 harness, where `cachesDropped` is derived from the
  platform rather than from whether the drop succeeded.
- **Postgres only.** App and worker wake on this hardware are unmeasured; the
  published figures for those are still from a Mac.
- **Idle box.** No other resources were awake or under load.


---

# Second run: 1GB, no swap

Same provider, same region, same script, same day. The only variable changed is
memory: DigitalOcean `1vcpu-1gb`, 961MB usable, **no swap**, ext4, kernel
6.8.0-124, Docker 29.7.2, otherwise idle.

The install completed with no swap and printed no memory warning, which is the
threshold in `install.sh` behaving correctly at 961MB against its 640MB floor.

## Results, milliseconds, client observed

| | n | min | p50 | p95 | max | mean |
|---|---|---|---|---|---|---|
| Cold, end to end | 30 | 534 | 623 | 837 | **1336** | 668 |
| Warm, already awake | 30 | 73 | 86 | 102 | 110 | 89 |

## The comparison, which is the point

| | p50 wake | p95 wake | max | spread (max - p50) | over 1s |
|---|---|---|---|---|---|
| 512MB + 2GB swap | 608ms | 757ms | 968ms | 258ms | 0 of 30 |
| 1GB, no swap | 537ms | 751ms | 1336ms | 713ms | 1 of 30 |

Wake figures are net of the client's own cost, using each run's own warm p50.

**Doubling the memory improved the median by about 12 percent and did nothing
for the tail.** p95 wake work moved from 757ms to 751ms, which is noise. The
worst case got materially worse, and the spread between median and maximum
nearly tripled.

The reading: **memory sets the median, and the shared vCPU sets the tail.** More
RAM means more page cache, so the typical wake gets faster. It does not buy
scheduler priority, so when a noisy neighbour takes the CPU, a wake stalls
regardless of how much memory is free. Iteration 13's 1336ms is more than twice
its own run's median, on an otherwise idle box, which is the signature of CPU
steal rather than anything Hobbyist did.

Both runs combined, n=60: min 534, p50 691, p95 845, max 1336.
**1 of 60 exceeded the 1 second target. 0 of 60 exceeded the 3 second ceiling.**

## What this means for the claim

The honest sentence is not "no wake takes a second". It is that a wake is
typically about two thirds of a second on this class of hardware, that roughly
one in sixty crosses a second on a shared CPU, and that nothing came within a
factor of two of the 3 second ceiling, which is the number that actually
matters because that is where clients give up.

Anyone choosing a tier for wake latency specifically should note that the 1GB
box was not more predictable than the 512MB one. If tail latency matters more
than median, a dedicated CPU is the thing to buy, not more memory. That is
untested here and would be the next useful measurement.
