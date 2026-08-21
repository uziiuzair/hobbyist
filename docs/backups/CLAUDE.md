# `docs/backups/` snapshots and restore

**Status:** DESIGNED, not built. `docs/decisions/0016` settles the shape,
`specs/2026-08-16-project-snapshots-design.md` is actionable.

Backups that happen without being thought about, and a restore that works on the
worst day.

## Position

**Do not reimplement what Postgres already does correctly.** That principle has
not changed. What changed on 2026-08-16 is what follows from it.

This folder previously said the plan was to wrap pgBackRest or Barman, and to
choose between them. That was written for a design centred on continuous WAL
archiving. ADR 0016 cuts point-in-time recovery, and once PITR is gone there is
nothing left for those tools to do here: a hibernating resource is already
stopped, and ADR 0003 guarantees its data directory is a plain PGDATA. Backing
it up is a filesystem clone of a directory Postgres wrote and closed cleanly. We
touch no Postgres internals at all, which honours the original principle more
strictly than wrapping a backup tool would have.

**The unit is the project, not the database.** A project holds a Postgres, the
workers with Durable Object state, and the queue holding undelivered messages
about all of it. Backing up one of those without the others produces a copy that
is internally inconsistent in a way nobody notices until they restore it.

## In scope

- Whole-project snapshots, taken with every resource quiesced through its own
  kind handler
- Reflink cloning where the filesystem supports it, a full copy where it does
  not, with the difference measured rather than assumed
- Sensible defaults that apply without configuration, because a backup a user has
  to set up is a backup that does not exist
- Restore into a new project by default, over the original only on request
- **Restore verification.** An unverified backup is a rumour. The weekly
  verification pass restores, starts, probes and destroys, so the restore path
  is exercised continuously rather than once, under stress
- Interaction with hibernation, which is a benefit here rather than a
  complication: a stopped resource is a consistent one
- Retention, and refusing to fill the disk

## Out of scope

- **Point-in-time recovery.** ADR 0016, which also states what would have to
  happen for it to earn its way back
- Replication and high availability. One box
- Cross-host backup orchestration
- Per-resource backups. The project is the unit
- Offsite and S3 targets, for now. The manifest is shaped so an archive exporter
  is a serializer over the same inventory rather than a second system, but until
  that exists this capability is local snapshots and must not be described as
  more than that

## Answered, and where

- **Does a backup wake a sleeping instance?** No. It works against the data
  directory at rest, and an awake resource is stopped first rather than
  snapshotted hot. ADR 0016, "Quiesce, do not snapshot hot"
- **Retention defaults.** Seven daily snapshots, plus a free-space floor the
  snapshotter refuses to cross. Nearly free on a reflink filesystem, linear on
  ext4, which is why the floor exists. Spec, "Schedule, retention, free space"
