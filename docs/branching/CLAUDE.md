# `docs/branching/` copy-on-write branches

**Status:** PROPOSED. Nothing built.

Instant database branches, the way Neon does them, without a storage engine.

## The mechanism

PostgreSQL 18 added `file_copy_method`. Set it to `clone` and:

```sql
CREATE DATABASE branch_x TEMPLATE main STRATEGY = FILE_COPY;
```

produces a filesystem-level copy-on-write clone via reflinks. Published
benchmark: a 6GB database cloned in 212ms versus roughly 67 seconds with the
default WAL_LOG strategy, around 315 times faster.

This is the single largest simplification available to the project. Xata had to
build NVMe-over-Fabrics storage plumbing to get copy-on-write branching, because
they are multi-node on Kubernetes. On one box, Postgres does it natively.

## The constraints, which are real

- **PostgreSQL 18 or newer.** Non-negotiable for this path.
- **A reflink-capable filesystem:** XFS with reflinks enabled, ZFS, or APFS.
  **ext4 has no reflink support**, and ext4 is the default on many of the cheap
  VPS images our audience runs. Branching degrades to a full copy there.
- **The source database must have no active connections during the clone.** This
  is the hard part of the implementation, not a footnote. A branch command that
  kicks the user's live connections is unacceptable, so this needs a quiesce and
  restore sequence, a clone from a paused replica, or a documented refusal.
- **Tablespaces spanning multiple mount points break cloning.**

## In scope

- Filesystem capability detection at `hobby init` and at branch time
- The quiesce, clone, restore sequence, and its failure modes
- Branch lifecycle: create, list, delete, and what deleting a parent does to
  children
- Storage divergence accounting, since copy-on-write clones grow as they diverge
  and a user needs to know what is actually consuming disk
- The degraded path on ext4, whether that is a slow real copy or a clear refusal

## Out of scope

- Point-in-time recovery, which is `backups/`, though the two will share plumbing
- Branching across hosts. One box.

## Fallback

If the reflink path disappoints in practice, PostgresAI's DBLab Engine has done
thin clones on ZFS and LVM in production for years. Read it before inventing
anything.

## Open questions

- What does branching a sleeping database do? Ideally clone the data directory
  without waking it at all, which may be faster and safer than the SQL path and
  is worth benchmarking against it.
- Is per-database cloning the right unit, or should a branch be a whole instance?
  This depends on the one-Postgres-per-project decision in `engine/`.
