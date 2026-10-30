---
title: Snapshots and restore
description: Whole-project snapshots on the same box, and two ways to restore one. Read the limits before you call it a backup.
sidebar:
  order: 10
---

<p class="state state--starting">works, rough edges. local to the box</p>

A snapshot is a copy of a whole project's data, taken on the box the project
runs on: every Postgres data directory, a worker's Durable Object storage, a
queue's backlog. It is restored either into a new project or over the
original. There is no point-in-time recovery, by decision
([ADR 0016](/docs/decisions/0016-project-snapshots-and-no-pitr/)).

Every verb below goes through the daemon API, so the same thing is reachable
from Studio or MCP in principle; today neither has a screen or a tool for it.

## Take one

```sh
hobby snapshot blog
```

`takeSnapshot` (`packages/cli/src/daemon/snapshots.ts`) holds the project
asleep, stops whatever is running, clones the project directory with
`cloneTree` (`packages/core/src/copy.ts`: a reflink on XFS, ZFS or APFS, a byte
copy on ext4), writes a manifest, and starts again whatever it stopped. While
it runs, a connection through the proxy, an HTTP request, or `hobby wake` waits
rather than starting a resource mid-copy (`holdProjectAsleep`,
`packages/cli/src/daemon/context.ts`).

A **pinned** project with something running is refused unless you pass
`--allow-pause`, because pinning it said it must stay up. A **released**
project is refused: its data belongs to a compose stack the daemon cannot
quiesce.

The command prints the snapshot id and reminds you that the copy is on the
same disk as the original.

### Without a pause

```sh
hobby snapshot blog --online
```

For a project whose resources are all Postgres. Nothing is stopped: a running
database is copied with `pg_basebackup`, run inside its own container
(`basebackupPostgres`, `packages/cli/src/daemon/basebackup.ts`), and a sleeping
one is cloned as it rests. A project holding an app, worker or queue is
refused, because their state has no online copy mechanism, and `--online` and
`--allow-pause` refuse each other.

Two caveats that follow from how `pg_basebackup` works. A database restored
from an online snapshot runs recovery on its first start, replaying the WAL
that came with the backup, before it accepts connections. And two databases in
one project are copied one after the other, so unlike a quiesced snapshot they
are not one point in time.

## List them

```sh
hobby snapshot ls blog
hobby snapshot ls blog --json
```

Newest first. Snapshots outlive their project, so this still works after
`hobby rm blog`, and so does restoring one.

In the manifest, each resource carries `stateAtSnapshot` and `method`
(`clone` or `basebackup`). For a quiesced snapshot `stateAtSnapshot` is the
state **at the moment of the copy**, which is after the project was put to
sleep, so a database that was running when you typed the command reads
`sleeping` there. That is what the code records (`takeSnapshot` reads
`resource.state` after `quiesce`) and it is what a restore needs to know; it
is not a record of what was running beforehand. An online snapshot records the
live state, since nothing was stopped.

## Restore into a new project

```sh
hobby snapshot restore blog <id>
hobby snapshot restore blog <id> --as blog-try
```

The default. Makes `blog-restored`, or the name given with `--as`, from the
snapshot, and touches nothing else: the original may keep running throughout.
Ports, container names, hostnames and the data directory are reallocated for
the new project, and an app's or worker's database binding is pointed at the
restored sibling (`rewriteConfig`, `snapshots.ts`). The new project's
resources start asleep and wake on first use.

If the original project has since been deleted, the command says so rather
than calling it untouched.

## Restore in place

```sh
hobby snapshot restore blog <id> --in-place
```

Replaces `blog`'s own data with the snapshot's and keeps its resource ids, so
nothing pointed at it has to change. The snapshot is cloned into a staging
directory first, with the project still up; then the project is quiesced
exactly as for a snapshot, the live directory is set aside, staging is renamed
into place, and whatever was running is started again (`restoreInPlace`,
`snapshots.ts`).

The replaced data is deleted only once everything that was running has come
back on the restored data. If something does not, the command exits 1, the
old data stays at `projects/<project>.pre-restore-<id>`, and its path is
printed.

It asks you to type the project name unless `--yes` is given. It is refused
when the project's resources have changed since the snapshot (restore with
`--as` instead), and it needs `--allow-pause` for a pinned project that has
something running. It restores data, not configuration: the code an app or
worker runs is whatever was last deployed.

## Delete one

```sh
hobby snapshot rm blog <id> [--yes]
```

## What this is not

**Not offsite.** A snapshot lives under `~/.hobby`, on the same disk as the
data. Losing the disk loses both. For a copy somewhere else, `pg_dump` is not
a workaround, it is one of the invariants the project holds itself to
([Portability](/docs/concepts/portability/)):

```sh
pg_dump "$(hobby connect blog --json | jq -r .connectionString)" > blog-$(date +%F).sql
```

**Not scheduled.** Nothing takes a snapshot for you. The daily schedule, the
retention policy, the free-space floor and the weekly restore verification in
`docs/backups/specs/2026-08-16-project-snapshots-design.md` are designed and
not built; every snapshot's manifest reads `unverified`.

**Not point in time.** Cut deliberately rather than deferred, because PITR
means WAL archiving, a retention policy and a restore path that needs its own
testing discipline.
[ADR 0016](/docs/decisions/0016-project-snapshots-and-no-pitr/).

**Two known gaps**, from `docs/backups/CLAUDE.md`: a queue's enqueue endpoint
writes `messages.sqlite` without waking anything, so a message that arrives
during the clone can land in a copy that is mid-write; and on Linux a PGDATA
is owned by the container's postgres uid, so whether the daemon's user can
read it for the clone has been run on macOS (where Docker masks the uid) and
in a root container, not as an ordinary Linux user.

For a whole project as files you can run anywhere,
[`hobby eject`](/docs/guides/eject/) is the other half of the story.
