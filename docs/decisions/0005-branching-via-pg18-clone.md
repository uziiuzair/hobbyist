# 0005. Branching via PostgreSQL 18 file clone

Status: ACCEPTED
Date:   2026-08-06

## Context

ADR 0001 rules out a custom storage engine, so branching has to come from
somewhere else. Three candidates:

1. **PostgreSQL 18 `file_copy_method = clone`** with
   `CREATE DATABASE ... STRATEGY = FILE_COPY`, which uses filesystem reflinks.
2. **ZFS or LVM thin clones**, the approach PostgresAI's DBLab Engine has used in
   production for years.
3. **NVMe-over-Fabrics with a replicated storage layer**, which is what Xata
   built on OpenEBS and CloudNativePG.

Option 3 is designed for multi-node Kubernetes and is far more machinery than a
single host justifies. Option 2 works today and ties branching to a specific
volume manager. Option 1 is native to Postgres, needs no extra layer, and a
published benchmark showed a 6GB database cloning in 212ms versus roughly 67
seconds with the default WAL_LOG strategy.

## Decision

**Option 1 is the primary path.** Option 2 is the documented fallback if reflinks
disappoint in real use.

## Consequences accepted

- **PostgreSQL 18 or newer is required** for instant branching.
- **A reflink-capable filesystem is required:** XFS with reflinks, ZFS, or APFS.
  **ext4 does not support reflinks and is the default on many cheap VPS images.**
  This is the single most user-visible constraint in the project. It is detected
  at `hobby init` and warned about loudly rather than discovered later.
- **The source database must have no active connections during a clone**, which
  makes branching a live database a real engineering problem rather than a
  one-liner. This is the main implementation risk in `docs/branching/`.
- Tablespaces spanning multiple mount points break cloning.
- Copy-on-write clones diverge as they are written to, so disk accounting has to
  be explained to users or it will surprise them.

## What would have to change to revisit

Benchmarks on real hardware showing the clone path is slower or less reliable
than ZFS thin clones, or the quiesce requirement proving unworkable in daily use.
Both are plausible. Benchmark before committing code, and file the results in
`docs/branching/research/` with the hardware stated.
