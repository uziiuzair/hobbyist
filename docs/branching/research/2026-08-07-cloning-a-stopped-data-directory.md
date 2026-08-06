# Cloning a stopped data directory instead of `CREATE DATABASE`

Status: NOTES. A hypothesis to benchmark. **Nothing here is decided, and ADR 0005
stands until it is measured.**
Date:   2026-08-07

## The claim

ADR 0005 names one constraint as the main unsolved implementation problem:
`CREATE DATABASE ... STRATEGY = FILE_COPY` requires no active connections on the
source database, which makes branching a live database a real engineering problem
rather than a one-liner.

Choosing sleep as the project's wedge may dissolve that problem instead of
solving it. Hibernation produces **cleanly stopped** Postgres instances as a
matter of course. A cleanly shut down data directory is internally consistent, so
it can be copied at the filesystem level and started as a new instance directly.

If that holds, branching a sleeping instance is:

```
1. confirm the instance is stopped after a clean shutdown
2. cp --reflink=auto -r <src PGDATA> <dst PGDATA>
3. register a new postgres resource pointed at the clone
4. start it
```

No SQL. No quiesce, clone, restore sequence. No `CREATE DATABASE` at all.

## Why this matters beyond convenience

**It may remove PostgreSQL 18 as a floor.** `file_copy_method = clone` is a
PostgreSQL 18 feature, but filesystem-level cloning of a stopped data directory
is version independent. PostgreSQL 18 would become the fast path for branching a
database that is **awake**, rather than the requirement for branching at all.
That is a meaningful relaxation of a constraint currently listed as hard in the
root `CLAUDE.md`.

**The unit of branching changes.** A data directory clone copies the whole
instance, every database in it, which maps to branching a `postgres` resource
rather than branching one database inside it. Given `docs/engine/` settled on one
Postgres process per resource, that is probably the unit we wanted anyway, but it
is a real difference from the ADR 0005 model and it needs stating.

## What is not solved

- **Branching an awake instance.** Reflink-copying a running `PGDATA` is not
  safe: the copy is not atomic across files and the result is a torn directory,
  not a consistent one. The options are a brief stop, `pg_basebackup`, or the
  PostgreSQL 18 SQL path. Sleep makes the common case easy, not every case.
- **Everything reflink-related is unchanged.** ext4 still has no reflinks, so
  this degrades to a real copy there exactly as before.
- **Tablespaces spanning mount points** still break cloning.

## What has to be measured before any of this is believed

Per the repo rule that a benchmark without hardware is a rumour, each of these
gets recorded with filesystem, disk type and dataset size:

1. Clone time for a stopped `PGDATA` at 1GB, 6GB and 50GB, on XFS with reflinks
   and on APFS, against the ADR 0005 figure of 212ms for a 6GB `CREATE DATABASE`
   clone.
2. Correctness: does the cloned instance start clean, pass `pg_amcheck`, and
   survive a restart.
3. The degraded ext4 path, so the warning we print has a real number behind it.
4. Whether a clone taken from an instance stopped by our own hibernation is
   reliably clean, including after `SIGKILL` of a container, which is the case
   that will actually happen.

Until 1 through 4 exist, this file is a hypothesis and ADR 0005 is the decision.
