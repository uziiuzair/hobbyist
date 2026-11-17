# autoprewarm after a wake: measured, not built

**Status:** NOTES. **Date:** 2026-11-17. **Verdict:** not worth shipping. The first queries after a
wake got slower, not faster, and the gain that does exist arrives after a
second of sustained querying and amounts to about a tenth of a second.

## The question

Neon prewarms a compute's cache after a restart. Stock Postgres ships the same
idea as `pg_prewarm` with `autoprewarm`: with
`shared_preload_libraries=pg_prewarm`, a background worker writes the list of
blocks in shared_buffers to `autoprewarm.blocks` in the data directory at
shutdown (and every `pg_prewarm.autoprewarm_interval`, 300 s by default), and
on the next start reads those blocks back in. A Hobbyist wake is `docker
start` on a stopped container (`startPostgres`, `packages/pg/src/postgres.ts`),
so every wake starts with empty shared_buffers. Would loading them back make
the first queries after a wake feel better?

## Setup

| | |
|---|---|
| Machine | Apple M2 Pro, macOS 26.3, Docker Desktop 28.4.0, VM with 12 CPUs and 7.65 GiB |
| Image | `postgres:18-alpine` (PostgreSQL 18.7), stock config, `shared_buffers` 128 MB |
| Data | bind-mounted host directory at `/var/lib/postgresql`, as `containerSpec` does |
| Database | pgbench scale 100: 1503 MB total, `pgbench_accounts` 1281 MB, its index 214 MB |
| Hot set | `aid` 1 to 500,000, about 74 MB (autoprewarm reported 9,505 blocks) |
| Containers | `exp-pw-off` (no args) and `exp-pw-on` (`postgres -c shared_preload_libraries=pg_prewarm`), one data directory, never both running |

Each run: start, warm with 30,000 random primary-key lookups in the hot set,
`docker stop -t 30` (what `stopPostgres` does), `docker start`, poll a real
connection plus `select 1` every 25 ms until it answers (time to ready), then
2,000 random hot-set lookups from the host through the published port, then
one aggregate over the whole hot set. Modes alternate run to run. "Warm OS
cache" is the case the hibernator produces on one box: the page cache keeps
whatever the stopped container read. "VM cache dropped" adds `echo 3 >
/proc/sys/vm/drop_caches` in the Docker VM between stop and start. That is
not a fully cold read on this Mac, because the bind mount goes through
virtiofs and macOS keeps its own cache of the files.

The harness is a 100-line Node script using the repo's `pg` driver. It was not
committed; the numbers below are its output.

## Results

Medians, with the range across runs in brackets. Times in milliseconds.

**Warm OS cache, 6 runs per mode**

| | without autoprewarm | with autoprewarm |
|---|---|---|
| `docker stop -t 30` | 406 (322 to 587) | 399 (345 to 733) |
| `docker start` to first answered query | 438 (421 to 596) | 440 (395 to 597) |
| first query | 5.6 (4.6 to 6.0) | 4.5 (2.3 to 8.6) |
| first 100 queries, total | **50.5** (45 to 56) | **92.7** (73 to 156) |
| first 2,000 queries, total | 786 (752 to 1077) | 615 (603 to 940) |
| per-query p50 over the 2,000 | 0.34 | 0.26 |
| aggregate over the hot set | 114 (88 to 215) | 22 (20 to 57) |

**VM cache dropped, 4 runs per mode**

| | without autoprewarm | with autoprewarm |
|---|---|---|
| `docker stop -t 30` | 377 (343 to 425) | 483 (399 to 705) |
| `docker start` to first answered query | 677 (583 to 1341) | 710 (573 to 1351) |
| first query | 7.6 (5.7 to 12.1) | 7.7 (6.5 to 12.7) |
| first 100 queries, total | **60.1** (45 to 104) | **127.4** (103 to 278) |
| first 2,000 queries, total | 925 (789 to 2088) | 995 (852 to 1420) |
| aggregate over the hot set | 140 (113 to 541) | 43 (30 to 71) |

The server log shows the reload finishing about 135 ms after "ready to accept
connections" (`autoprewarm successfully prewarmed 9505 of 9505
previously-loaded blocks`).

## Reading

- **Time to ready is unchanged.** The worker loads blocks after the postmaster
  accepts connections, so it never delays readiness, which is what the wake
  router waits on. Stop was not measurably slower with the cache warm; with
  the VM cache dropped it was about 100 ms slower at the median, inside the
  spread.
- **The first 100 queries got slower in both cases, by roughly 40 to 70 ms.**
  For those first ~150 ms the prewarm worker competes with the client for the
  same I/O and buffer mapping. The first queries after a wake are the ones
  the wedge is about: a request that woke the database is waiting on them.
- **The gain is real but late and small.** Over 2,000 sequential lookups,
  about one second of continuous querying, the warm case saved about 170 ms.
  The cold case saved nothing. A scan over the whole hot set was 4 to 5 times
  faster, but that is 90 ms on a query a wake-sized workload does not run
  first.
- **The reason is the OS page cache.** On one box a stopped container's file
  pages stay in the page cache, so a shared_buffers miss after a wake costs
  microseconds, not a disk read. autoprewarm saves a copy from the page cache
  into shared_buffers, which is cheap to begin with. Neon gets more from
  prewarming because its compute and storage are separate machines (the
  thing ADR 0001 decided not to build): a cache miss there is a network
  round trip to a pageserver.

## Side checks

- **It does not keep a database awake.** Sampled `pg_stat_activity` from the
  first moment a connection was accepted for 4 seconds: the worker appears as
  `backend_type = 'autoprewarm worker'`, never `client backend`, so the
  hibernation guard (`ACTIVE_QUERY_SQL`, `packages/pg/src/activity-guard.ts`)
  never counted it. The guard's count read 0 in every run.
- **It writes a file into PGDATA.** `autoprewarm.blocks` (226 KiB here). That is
  stock Postgres behaviour and harmless for ADR 0003, but it is one more thing
  in the data directory that branching and snapshots would copy.

## What would change this

A box under memory pressure, where the page cache has evicted a sleeping
database's pages by the time it wakes, is the case where autoprewarm could pay
for itself, and it is not what was measured: on this Mac, dropping the VM
cache did not empty the virtiofs cache underneath it. If someone measures a
real Linux VPS with local disk, `drop_caches` between stop and start, and the
first-100-queries number improves, this should be re-measured there, not
assumed. Shipping it would mean passing `-c shared_preload_libraries=pg_prewarm`
as a server argument from `containerSpec` and the same `command:` in
`renderCompose` (ADR 0003 invariant 3), opt-in per resource.
