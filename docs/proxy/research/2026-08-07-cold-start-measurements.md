# Cold start measurements, first real hardware

Status: NOTES. Measurements. One machine only.
Date:   2026-08-07

First execution of the M0 harness against real Docker and real Postgres. The
target set in `2026-08-07-cold-start-budget.md` was under 1 second, with 3
seconds as a hard ceiling, measured on total p95.

## Hardware

Apple M5 Pro, 15 cores, 24GB, internal NVMe SSD, APFS, macOS 26.3.2.
Node v24.19.0, Docker via OrbStack 29.4.0, `postgres:18-alpine` unless stated.
50 iterations per cell. **Page cache was not dropped:** that path is Linux only
and no-ops on macOS, so every number here is warm.

**The five dollar VPS half of the matrix has not been run.** These numbers
describe the most generous hardware in the target range, not the representative
end, and `CLAUDE.md` names both as equal targets.

## Results, milliseconds

| scenario | n | fail | accept_parse p50 | wake_issue p50 | container_up p50 | pg_ready p50 | connect_splice p50 | total p50 | total p95 | total max |
|---|---|---|---|---|---|---|---|---|---|---|
| baseline-alpine-poll25 | 50 | 0 | 0.1 | 120.0 | 13.7 | 35.4 | 0.2 | 170.0 | 186.4 | 211.3 |
| poll100-alpine | 50 | 0 | 0.1 | 116.4 | 13.6 | 114.2 | 0.2 | 243.8 | 261.9 | 302.2 |
| poll1000-alpine | 50 | 0 | 0.1 | 120.9 | 12.9 | 1021.3 | 0.2 | 1155.2 | 1173.3 | 1179.0 |
| debian-poll25 | 50 | 0 | 0.1 | 114.0 | 13.2 | 33.5 | 0.2 | 159.9 | 175.7 | 185.4 |
| kill-alpine-poll25 | 50 | 0 | 0.1 | 105.2 | 12.8 | 88.6 | 0.2 | 207.3 | 232.9 | 241.9 |
| recreate-alpine-poll25 | 50 | 0 | 0.0 | 93.9 | 15.5 | 38.8 | 0.2 | 149.8 | 188.4 | 291.3 |
| coldcache-alpine-poll25 | 50 | 0 | 0.0 | 104.3 | 13.5 | 35.6 | 0.2 | 156.9 | 273.0 | 466.5 |

## The gate

**Shipping configuration passes with room: total p95 of 186ms against a 1000ms
target**, roughly five times under it, on this hardware, warm.

**The generated verdict line in the harness output is wrong and should not be
quoted.** It takes the worst p95 across every scenario, which includes
`poll1000-alpine` at 1173ms. That scenario is a deliberately degraded lever
comparison, not a configuration anyone would ship. Evaluating a release gate
against an experiment designed to be slow is a flaw in the report renderer,
recorded here rather than quietly fixed, because the number it printed would
otherwise enter the project's history as the real result.

## Findings

**1. The poll interval is the whole of `pg_ready`, exactly as predicted.**
25ms gives 35ms, 100ms gives 114ms, 1000ms gives 1021ms. Postgres is accepting
connections almost immediately after the container is up; nearly all of that
segment is us not having noticed yet. The budget doc called this "the single
most likely source of a needlessly bad number" and it is.

**2. `docker start` returning is the real floor, at roughly 110 to 120ms.**
`wake_issue` is the largest genuine segment in every scenario and nothing in our
control shrinks it. `container_up` is 13ms and `accept_parse` and
`connect_splice` are both under a millisecond, so the proxy's own overhead is
not measurable at this resolution. A JavaScript wire proxy is not the problem,
which settles the concern ADR 0006 accepted.

**3. Two documented assumptions are contradicted by the data.**

- **Keeping containers stopped rather than removed is not justified.**
  `docs/engine/CLAUDE.md` asserts "recreating a container on every wake spends
  time we do not have." Measured, recreate is 149.8ms p50 against baseline's
  170.0ms, so it is if anything slightly faster, with a worse tail (p95 188.4
  and max 291.3 against 186.4 and 211.3). The claim should be softened to a tail
  latency argument or dropped.
- **Alpine is not faster than Debian here.** Debian is 159.9ms p50 against
  alpine's 170.0ms. The plan called base image a "free lever"; on this hardware
  it is free in the other direction.

**4. A hard kill costs about 53ms of recovery**, 88.6ms `pg_ready` against
35.4ms. Real, and it validates insisting on clean shutdown, but it is a much
smaller penalty than the design discussion assumed. Crash recovery is not the
threat to the budget that `docs/engine/` and `docs/cli/` imply.

**5. The cold cache row means nothing on this machine** and should not be read.
Cache dropping is Linux only. Its worse p95 and max are unexplained and are
probably first-iteration noise.

## What this does not tell us

- **Nothing about a five dollar VPS**, which is half the stated audience and
  where the 110ms `docker start` floor and the 13ms container start will both be
  substantially worse.
- **Nothing about a genuinely cold page cache.**
- **Nothing about Bun**, which ADR 0006 names as the shipping runtime and which
  has still never been run.
- **Nothing about the production wake path.** This measures the spike's own
  proxy and fixture, not `packages/proxy` and `packages/pg`. Those are the same
  design and different code.

## Harness defect found while running

The runner shared one data directory across all seven scenarios and deleted it
between them. Deleting the source of a bind mount and recreating it at the same
path leaves the previous mount pointing at a dead inode, so scenario two died
with `mkdir: can't create directory '/var/lib/postgresql/18/'`. Fixed by giving
each scenario its own subdirectory. The first run produced no results at all.
