# 0016. Project snapshots, and no point-in-time recovery

Status: ACCEPTED
Date:   2026-08-16

Starts the `backups/` capability, which has read "PROPOSED. Nothing built."
since 2026-08-06. Depends on ADR 0003 (a plain Postgres data directory) and
shares its central primitive with ADR 0005 (branching via reflink clone).
Disturbs nothing already built.

## Context

Five resource kinds now hold state that a user would not accept losing:
`postgres` (a PGDATA under `paths.resourcePath(project, resource, 'pgdata')`,
`packages/pg/src/postgres.ts:119`), `worker` (Durable Object SQLite files under
`.../do/`, `packages/worker/src/worker.ts:273`), and `queue` (an undelivered
backlog in `messages.sqlite`, `packages/queue/src/kind.ts:24`). None of it is
backed up by anything.

The root `CLAUDE.md` says two things that make this the next capability rather
than a later one. First, backups and restore are named as **not phased**,
alongside eject, because they are the obligations that make the rest honest.
Second, the licence disclaims warranty, and the reason given is that we do not
ship anything "whose failure mode is someone else getting owned or losing data
quietly." A platform that runs five stateful kinds with no backup story is
exactly that failure mode, written by omission.

`hobby eject` is not a substitute. It is manual, it is a whole-project exit, and
it produces a `docker-compose.yml` pointed at the live data directory rather
than a copy. It answers "can I leave", not "can I go back".

The question this ADR settles is not whether to build backups. It is what shape
they take on a machine whose defining property is that most things are stopped.

## The decision

**A backup is a snapshot of a whole project, taken with every resource in it
quiesced, and it does not do point-in-time recovery.**

Four parts, each of which could have gone the other way:

**1. The unit is the project, not the resource.** A project directory is
name-addressed throughout (`resourceDir(project, resource)` at
`packages/core/src/config.ts:48`, and every caller passes `project.name` and
`resource.name`), so it is self-describing and survives being copied and
renamed. Per-resource backups would need a consistency story between a Postgres
and the queue holding messages about its rows. Per-project needs none, because
the whole set stops together.

**2. Quiesce, do not snapshot hot.** Before copying, every running resource in
the project is stopped through its own kind handler, using the same two calls
the hibernator makes at `packages/cli/src/daemon/hibernator.ts:202`: `guardFor`
for the pre-sleep activity check, then `ResourceKindHandler.stop`. Afterwards
whatever was running is started again. This is the wedge paying out rather than
being paid for: on a box where sleeping is the normal state, most snapshots stop
nothing at all, and a stopped PGDATA is a consistent PGDATA by definition, with
no quiesce protocol of our own to get wrong.

One deliberate difference from the hibernator, which treats a guard result of
`unreachable` as "leave it alone" and moves on: a snapshot **fails loudly**
instead. Recording a backup taken while a resource could not confirm it was idle
is how a corrupt copy gets filed as a good one.

**3. Reflink first, full copy as the fallback.** Where the filesystem supports
cloning (APFS, XFS with reflinks, ZFS, btrfs) a snapshot costs the delta and
takes milliseconds, so keeping several is nearly free. On ext4 it is a full byte
copy and costs the size of the data every time. The detection already exists and
is empirical rather than a filesystem-name guess: `detectReflinkSupport` at
`packages/cli/src/daemon/preflight.ts:97` clones a file and checks whether the
clone actually happened.

**4. No point-in-time recovery.** `docs/backups/CLAUDE.md` listed PITR in scope
from the day the folder was created. This ADR removes it.

PITR requires continuous WAL archiving, which requires a continuously running
Postgres. That is a direct trade against the one property the project exists to
provide. Worse, it would mostly buy nothing: a hibernating database produces WAL
only while awake, so for most instances "recover to 03:47" resolves to "the
state it was in when it went to sleep", which is what a snapshot already gives.
Snapshot granularity is the honest granularity for a platform whose databases
are usually stopped.

The working agreement is to prefer deleting a feature to deferring it, because a
deferred feature still occupies attention. This is that, applied to the largest
item in the folder.

## Consequences accepted

- **Recovery granularity is the snapshot interval**, defaulting to daily. A
  mistake made at noon costs the morning's writes. This is stated in the CLI
  output rather than left for a user to discover on the worst day.
- **A local snapshot does not survive the disk dying.** It protects against
  operator error, a bad migration and a corrupted data directory, which are the
  common cases, and not against hardware loss, which is the frightening one.
  Offsite is a later, separate capability (an archive export), and the manifest
  format is designed so that it is a serializer over the same inventory rather
  than a second system. Until it exists, the documentation must not call this
  "backups" without qualification.
- **ext4 users pay linearly.** Retention defaults that are nearly free on APFS
  are expensive there, so the snapshotter refuses to run when free space would
  drop below a floor, and says why.
- **Snapshots cost seconds of downtime for awake resources.** Acceptable on a
  one-box hobby platform. It would not be on a production cluster, and this
  project is explicitly not that.
- **A restore is not a rollback of one table.** The unit is the project. Finer
  recovery is what `pg_dump` against a restored copy is for, which works because
  ADR 0003 guarantees a plain data directory.

## What would have to change for this to be revisited

**PITR earns its way back in** if a real, repeated incident is recorded where
snapshot granularity actually lost work that mattered, on the author's own
install, and the WAL archiving needed to prevent it can be shown not to keep an
otherwise idle database awake. Not before. A hypothetical about losing an
afternoon is not evidence.

**Offsite becomes urgent** the moment this runs on a box whose disk is the only
copy of something the author would miss. That is a question about how the tool
is used, not about the design, and it is expected to arrive before PITR does.

**Hot snapshots become worth building** if quiesce downtime is ever measured as
disruptive in practice, which on a platform built around stopping things is not
expected.
