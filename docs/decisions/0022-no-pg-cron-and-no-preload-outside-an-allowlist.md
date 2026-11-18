# 0022. No pg_cron, and no preload library outside an allowlist

Status: ACCEPTED
Date:   2026-11-17

## Context

Postgres server settings became declarable per postgres resource on
2026-11-17 (`docs/engine/CLAUDE.md`, amendment of that date), passed as
`postgres -c name=value` from `containerSpec` and from the eject compose
file's `command:`, never written into the data directory (ADR 0003). One of
those settings is `shared_preload_libraries`, which decides which extensions
can work at all. `pg_stat_statements` is created by `CREATE EXTENSION`
without it and then answers every read with "must be loaded via
shared_preload_libraries".

Two libraries are the obvious next asks: `pg_cron`, the usual way to
schedule SQL inside Postgres, and `pg_prewarm`'s autoprewarm worker. The
root `CLAUDE.md` asks for an ADR for every deliberate non-build.

## Decision

**`shared_preload_libraries` accepts an allowlist, today
`pg_stat_statements` and `auto_explain`** (`PRELOAD_LIBRARIES`,
`packages/pg/src/settings.ts`). Both ship in `postgres:18-alpine`, start no
background worker, and were checked live: with the preload,
`pg_stat_statements` answers, and the cold start did not measurably change
(three stop and start cycles each on Docker Desktop, Apple silicon,
1.0 to 1.3 seconds with it, 1.1 to 1.5 seconds without; noise, not a
benchmark). Anything else is refused by name.

**`pg_cron` is not allowed, and `hobby pg ext add pg_cron` is refused**
(`EXTENSION_PRELOADS`, same file). The stock image does not ship it, but
`HOBBY_IMAGE` can name one that does, so the refusal is explicit rather
than incidental. Two reasons, both the wedge (ADR 0007):

1. Its jobs run only while the database is awake. On a database that
   sleeps, a schedule silently stops firing, which is worse than no
   scheduler because nothing says so.
2. Its launcher is a background worker with its own connection. Hibernation
   would have to learn to ignore it, and a job firing would have to count
   as activity or not; either answer is wrong for someone.

Worker cron triggers (`hobby cron ls`, `docs/compute/`) are the scheduler
here: they run outside the database and wake what they call.

**`pg_prewarm` stays out**, for the reason ADR 0020 already records:
autoprewarm made the first queries after a wake slower. Offering it as a
preload would reopen that decision without new evidence.

`auth_delay`, `passwordcheck` and `pg_overexplain` also ship and are left
out as not worth the surface on a box with one owner (ADR 0019 already
declined login throttling at the proxy).

## Consequences accepted

- Scheduling SQL means a worker with a cron trigger, not `cron.schedule`.
- Someone running a custom image with another preload library (TimescaleDB,
  pgaudit) cannot preload it through hobby. Adding a library is a one-line
  change to `PRELOAD_LIBRARIES` once it has been checked against sleep.

## What would have to change to revisit

- **pg_cron:** a way for a schedule to wake a sleeping database (the daemon
  reading `cron.job` and waking the database before each run), so that jobs
  do not silently stop. That is a feature of its own and needs its own case.
- **Another library:** that it ships in the image in use, starts no
  background worker that holds a connection or keeps the database busy, and
  measurably leaves the cold start inside budget.
