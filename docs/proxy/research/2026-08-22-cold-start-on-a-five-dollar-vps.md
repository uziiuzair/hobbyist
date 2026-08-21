# Cold start on a five dollar VPS

Status: NOTES, measured 2026-08-22.

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
