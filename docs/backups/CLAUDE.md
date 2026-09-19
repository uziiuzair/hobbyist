# `docs/backups/` snapshots and restore

**Status:** PARTLY BUILT. Manual snapshot, list, restore and delete are wired
and reachable (below). Scheduling, retention, the free-space floor and weekly
verification are not built. `docs/decisions/0016` settles the shape,
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

## What is built

Everything below goes through the daemon API (the only control surface), so
Studio and MCP can reach it; neither has a screen or a tool for it yet.

| CLI | Route | Code |
|---|---|---|
| `hobby snapshot <project> [--allow-pause]` | `POST /v1/projects/:name/snapshots` | `takeSnapshot`, `packages/cli/src/daemon/snapshots.ts` |
| `hobby snapshot <project> --online` | the same, `{ "online": true }` | `takeOnlineSnapshot`, and `basebackupPostgres` in `packages/cli/src/daemon/basebackup.ts` |
| `hobby snapshot ls <project>` | `GET /v1/projects/:name/snapshots` | `listSnapshots` |
| `hobby snapshot restore <project> <id> [--as <name>]` | `POST /v1/snapshots/:id/restore` | `restoreSnapshot` |
| `hobby snapshot restore <project> <id> --in-place [--allow-pause] [--yes]` | the same, `{ "inPlace": true }` | `restoreInPlace` |
| `hobby snapshot rm <project> <id> [--yes]` | `DELETE /v1/snapshots/:id` | `deleteSnapshot` |

Restore, both shapes:

- **Into a new project** (the default, named `<project>-restored` unless
  `--as` says otherwise). Non-destructive: the original is untouched and may
  keep running. Ports (from each kind's own range), container names,
  hostnames, the data directory path and the queue token are reallocated, and
  Durable Object storage is renamed to the new resource ids (`rewriteConfig`
  and `renameDurableObjectDirs`). Each postgres gets a real container, created
  stopped on the cloned data (`createPostgresFromClone`,
  `packages/pg/src/postgres.ts`), because its start path only ever starts an
  existing one; an app or worker is created on its first wake.
- **In place** (`--in-place`). Replaces the project's data with the snapshot's
  and keeps its resource ids, so connection strings do not change. The snapshot
  is cloned into a staging directory first, with the project still up; then the
  project is quiesced exactly as for a snapshot, the live directory is renamed
  aside and staging renamed into place, and whatever was running is started
  again. The replaced data is deleted only once everything that was running has
  come back on the restored data; otherwise it stays at
  `projects/<project>.pre-restore-<id>` and its path is reported. Refused when
  the project's resources have changed since the snapshot (use `--as`).
  Restores data, not configuration: code is whatever was last deployed.

  This differs from the spec's first draft, which refused an in-place restore
  unless the project was already fully stopped. Quiescing it with the
  snapshot's own guard and resuming afterwards is strictly better than asking
  the operator to do the same by hand with neither.

**Online** (`--online`, added 2026-09-19, ADR 0016's dated note). A snapshot
that pauses nothing, for a project whose resources are all `postgres`; any
other kind is refused (`onlineSnapshotRefusal`), because app, worker and queue
state has no online copy mechanism. Nothing is quiesced:

- A **running** postgres is copied with `pg_basebackup` run inside its own
  container through `ComputeRuntime.execStream` (`packages/core/src/runtime.ts`,
  `docker exec` in `packages/core/src/docker.ts`), over the local socket as
  the resource's superuser, streaming a tar to stdout (`basebackupCommand`
  has the flags and why each one). It has to run there: the image's
  `pg_hba.conf` accepts replication connections only over the socket and
  loopback inside the container, and `all` never matches replication. The
  daemon unpacks the tar with the system `tar` into
  `data/<resource>/pgdata/18/docker`, the same place a clone of the project
  directory puts that PGDATA, so both restores work on it unchanged.
- A **sleeping** postgres is cloned exactly as a quiesced snapshot would.
- The manifest records per resource `method` (`clone` or `basebackup`) and
  `stateAtSnapshot`. A manifest from before `--online` reads as all `clone`.
- **A restored basebackup starts with recovery.** Its PGDATA carries the
  `backup_label` pg_basebackup wrote, and the first start replays the WAL in
  `pg_wal/` to the backup's end point before it accepts connections. That is
  expected and the label must never be deleted: without it Postgres would
  treat the copy as crashed at its last checkpoint and skip the WAL that
  makes it consistent.
- **The pinned refusal does not apply**, since nothing stops. The refusal for
  a quiesced snapshot of a pinned, awake, postgres-only project now suggests
  `--online`. `online` and `allowPause` together are a 400.
- **Still exclusive, not fenced.** It takes `holdProjectExclusive`
  (`context.ts`): the same map as `holdProjectAsleep`, so a second snapshot or
  any restore of the project is refused while it runs, but wakes pass
  straight through. Each resource's state is re-read at its turn (a sibling
  woken meanwhile is backed up online, not cloned hot) and again after its
  capture; any change fails the snapshot.
- **The hibernator is held off with an activity handle**
  (`ActivityTracker.open` on every resource for the whole capture), not a
  touch and not a fence: a touch only restarts the idle clock and a long
  backup would be slept under, a fence blocks wakes. An explicit `hobby
  sleep` is not held off; it kills the backup and the snapshot fails.
- **Failure leaves nothing.** The `.partial` directory is removed on any
  error. Success needs pg_basebackup to exit 0, tar to exit 0, the pipe to
  hold, and `backup_label` plus `global/pg_control` to be present (a tar cut
  on a block boundary is accepted silently by both GNU tar and bsdtar, so the
  last check is not decorative).
- **Limits.** Each postgres is consistent on its own; two databases in one
  project are captured one after another, so unlike a quiesced snapshot they
  are not one point in time. `--wal-method=fetch` collects the WAL at the
  end, so a long backup of a busy database can fail if checkpoints recycle
  the segment it started from; it fails loudly and keeps nothing. A cluster
  with a user-defined tablespace is refused by pg_basebackup in this shape;
  hobby creates none. Not yet run against real Docker.

Two refusals the routes add (`refusePausingPinned` and `refuseReleased`,
`packages/cli/src/daemon/routes.ts`):

- A **pinned** project (`sleepAfterSeconds` null) with anything running is
  refused unless the request says `allowPause` (`--allow-pause`), because the
  snapshot or in-place restore stops it for the copy. A pinned project that is
  all asleep, and any unpinned project, need nothing. An online snapshot
  needs nothing either.
- A **released** project is refused: its data belongs to a compose stack hobby
  cannot quiesce.

While a snapshot or in-place restore runs, the project is held asleep
(`holdProjectAsleep`, `packages/cli/src/daemon/context.ts`): a wake through
the proxy, the HTTP router, the query route or `hobby wake` waits rather than
starting a resource in the middle of the clone. Without it, an application's
connection pool reconnecting after quiesce would wake the database straight
back up and the snapshot would be a hot copy filed as a good one.

Manifests cross the wire redacted (`toWireSnapshotManifest`,
`packages/cli/src/daemon/wire.ts`); the file on disk keeps every credential,
because restore needs them.

**Not built, stated plainly:** the daily schedule, retention and pruning, the
free-space floor, weekly verification (every snapshot reads `unverified`), an
MCP tool, a Studio screen, and offsite copies.

**Known gaps:**

- A queue's enqueue endpoint and delivery tick write `messages.sqlite` without
  waking anything, so the wake fence does not cover them. A message enqueued
  during a snapshot's clone can land in a copy that is mid-write.
- On Linux a PGDATA is owned by the container's postgres uid, not the daemon's
  user (`createDefaultRemoveDataDir`'s comment, `packages/pg/src/postgres.ts`).
  Whether the clone can read it, and whether the in-place restore can delete
  the set-aside copy, has not been run on Linux. On macOS (Docker Desktop
  masks the uid) snapshot, both restores, the pinned refusal and the wake
  fence have been run against real Docker.

## Answered, and where

- **Does a backup wake a sleeping instance?** No. It works against the data
  directory at rest, and an awake resource is stopped first rather than
  snapshotted hot, or, with `--online`, copied by Postgres's own online
  backup rather than by a byte copy. ADR 0016, "Quiesce, do not snapshot
  hot", and its 2026-09-19 note
- **Retention defaults.** Seven daily snapshots, plus a free-space floor the
  snapshotter refuses to cross. Nearly free on a reflink filesystem, linear on
  ext4, which is why the floor exists. Spec, "Schedule, retention, free space"
