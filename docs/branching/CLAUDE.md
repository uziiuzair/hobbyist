# `docs/branching/` copy-on-write branches

**Status:** FIRST VERSION BUILT, 2026-09-19 (issue #19). `hobby branch` works for
projects holding only postgres resources, by cloning stopped data directories.
Run against real Docker on ext4 on 2026-10-16 (see the amendment at the end);
clone times on a reflink filesystem are still unmeasured. The PostgreSQL 18
`CREATE DATABASE` path below is NOT built.

Instant database branches, the way Neon does them, without a storage engine.

## What is built

`hobby branch <source> <name>`, over `POST /v1/projects/:name/branch` with
`{ "name": string, "allowPause"?: boolean }`, so Studio (through its `/v1` gate)
and MCP (`hobby_branch`) reach the same code. It lives in
`packages/cli/src/daemon/branch.ts` (`branchProject`) and
`packages/pg/src/postgres.ts` (`createPostgresFromClone`).

- **The unit is the project**, and the mechanism is the one the research note
  proposed: clone each postgres resource's whole data directory with
  `cloneTree` (`packages/core/src/copy.ts`, shared with snapshots), then make a
  new resource around it. No SQL, no `CREATE DATABASE`, no version floor.
- **A sleeping source** is cloned directly. Before and after the copy every
  source container is inspected, and the branch is discarded if one is running
  or if `lastActiveAt` moved (a wake came and went while the copy ran).
- **An awake source** is quiesced and resumed with the same `quiesce` and
  `resume` snapshots use (`packages/cli/src/daemon/snapshots.ts`), and the pause
  is reported (`pausedMs`, an upper bound that includes the idle check). The
  unbenchmarked PostgreSQL 18 awake-clone path is deliberately not used.
- **A pinned project that is awake is refused** unless the caller passes
  `--allow-pause` (`allowPause: true`), because branching it would stop what its
  operator said must stay up. Pinned and asleep, or unpinned, needs no flag.
- **The branch is independent**: its own container name, host port, data
  directory and network, all derived from its own name. It keeps the source's
  superuser, password and database name, because those live inside the cloned
  cluster and the image only applies its environment at initdb; see the comment
  on `createPostgresFromClone`. The proxy routes on the project name and rewrites
  the database to the stored one, so connecting to `<branch>` through the proxy
  works unchanged.
- **The branch starts asleep and is never pinned**, whatever the source was. It
  gets the box-wide default sleep policy, as `hobby new` without `--pin` does.
- **Refused**: sources holding apps, workers or queues (their state is keyed to
  resource identity, see the comment in `branch.ts`), released projects,
  resources mid-transition or `failed`, name collisions, and a leftover directory
  at the target path.
- **Failure leaves nothing behind**: the target name is reserved as a project
  row before the copy starts, and any failure removes the containers, network,
  rows and cloned files, after resuming the source.
- **ext4** degrades to a byte copy, and the CLI prints the same note `hobby init`
  uses (`branchCopyNote` and `reflinkWarning`, `packages/cli/src/cli/output.ts`).
- **Destroy is `hobby rm <branch>`.** A branch is an ordinary project the moment
  it exists. No parent link is recorded, so there is no list of children, no
  merge, no diff, and removing the source never touches a branch.

Not done, and stated plainly:

- **Never run against real Docker.** The flow is covered by fake-engine tests
  (`packages/cli/test/branch.test.ts`).
- **Linux ownership.** A PGDATA on Linux is owned by the container's postgres
  uid with mode 0700, and the daemon runs as an ordinary user, so `cloneTree`
  reading it as that user is expected to fail with EACCES there. Snapshots share
  the same exposure. The likely fix is running the copy inside a throwaway
  container, as `createDefaultRemoveDataDir` already does for removal, which
  needs a `cp` in the image that can reflink. macOS hides this, as it hid the
  uid problem `createPostgres` documents.
- **No timings.** Clone time on a reflink filesystem and on ext4, with hardware
  and dataset size, is still owed per the benchmark convention.
- **Storage divergence accounting** is not surfaced anywhere.

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

- **PostgreSQL 18 or newer**, for this path. Note that a second path may not need
  it at all: see below.
- **A reflink-capable filesystem:** XFS with reflinks enabled, ZFS, or APFS.
  **ext4 has no reflink support**, and ext4 is the default on many of the cheap
  VPS images our audience runs. Branching degrades to a full copy there.
- **The source database must have no active connections during the clone.** This
  is the hard part of the implementation, not a footnote. A branch command that
  kicks the user's live connections is unacceptable, so this needs a quiesce and
  restore sequence, a clone from a paused replica, or a documented refusal.
- **Tablespaces spanning multiple mount points break cloning.**

## Sleep may make this much easier, and that is worth measuring first

The hardest constraint above is that the source needs no active connections.
Hibernation already produces cleanly stopped instances, and a cleanly shut down
`PGDATA` can be reflink-copied directly and started as a new instance: no SQL, no
quiesce sequence, no `CREATE DATABASE` at all, and no PostgreSQL 18 requirement,
since filesystem cloning is version independent.

If that holds, PostgreSQL 18 becomes the fast path for branching a database that
is **awake**, rather than the floor for branching at all. Branching an awake
instance still needs an answer: a brief stop, `pg_basebackup`, or the SQL path.

The first version of `hobby branch` is built on this path (see above), with an
awake source stopped briefly rather than cloned hot. The benchmarks the research
note asks for are still owed, so the timing claims remain unmeasured.

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

- ~~What does branching a sleeping database do?~~ Answered by the first
  version: it clones the data directory without waking it.
- ~~Is per-database cloning the right unit?~~ The built unit is the whole
  project, every postgres resource in it, each a whole instance.
- Branching projects that hold apps, workers or queues, and whether that is
  wanted at all.
- What a branch should record about its source, if anything, once there is a
  reason to list branches.

## Amendment, 2026-10-30: it has met Docker (issue #181)

"Never run against real Docker" above stopped being true on 2026-10-16. The QA
ops lane ran `hobby branch qaopsa qaopsabr` against a real dockerd inside an
Ubuntu 24.04 container (docker-in-docker, on an Apple M5 Pro host), on ext4:
the branch was created in 0.9 seconds end to end, the CLI printed the
full-copy warning that ext4 earns, and `hobby connect qaopsabr` reached the
branch. The pg lane did the same on macOS (APFS, OrbStack).

What that does and does not settle:

- **Run against Docker: yes.** Both the sleeping-source path and the warning.
- **Benchmarked: no.** 0.9 seconds for a freshly initialised database on ext4
  is a smoke test, not a clone timing. The benchmark convention (filesystem,
  disk, dataset size) is still owed, and the reflink path has no number at
  all. Until it has one, "instant" on XFS, ZFS or APFS is the filesystem's
  claim, not this project's.
- **Linux ownership: still open.** The Linux run was as root inside a
  container, where the daemon can read anything. The EACCES exposure described
  above, a daemon running as an ordinary user reading a PGDATA the postgres
  uid owns, has not been exercised either way.

## Amendment, 2026-11-17: parents, reset, expiry and schema diff

The first version said "No parent link is recorded, so there is no list of
children, no merge, no diff". Three of Neon's branch workflows now exist, on
the same clone-a-directory mechanism and nothing new underneath it (ADR 0001
still holds: no storage engine, no page server).

**A branch records its parent.** `Project.parentId` (`packages/core/src/
types.ts`), a nullable `parent_id` column added by `migrate` in
`packages/core/src/store.ts`, set by `branchProject`
(`packages/cli/src/daemon/branch.ts`). By id, not name, so a parent removed
and a new project later made under its name is never taken for it. Every
project that existed before has no parent, including branches made before
this date: reset refuses them and says why. Removing a parent still touches
no branch. This metadata lives outside the data directory, as ADR 0003's
consequences already allow, and eject loses it.

**`hobby reset <branch>`** (`POST /v1/projects/:name/reset`,
`packages/cli/src/daemon/reset.ts`) replaces each of the branch's postgres
data directories with a fresh clone of the parent's same-named resource.

- The parent is cloned through `cloneSourceAtRest`, the sequence
  `branchProject` has always used, now shared: quiesce if awake, prove at
  rest, clone, prove nothing woke, resume, report the pause. The clone goes
  to `<dataDir>.reset-staging` beside the branch's own, so the branch keeps
  serving while a slow ext4 copy runs.
- The branch is then held asleep (`holdProjectAsleep`), quiesced with the
  snapshot activity guard (a session in use is refused, not cut off),
  swapped by rename, rebound with `rebindPostgresToClone`
  (`packages/pg/src/postgres.ts`) and resumed. Kept: resource ids, container
  names, host ports, data directory paths. Taken from the parent: superuser,
  password, database name and image, for the reason
  `createPostgresFromClone` gives (they live inside the cloned cluster). The
  container is recreated stopped so a changed image applies.
- Destructive for the branch, so it follows `hobby rm`: type the name back
  or pass `--yes`; MCP `hobby_reset` needs `confirm: true`. `--allow-pause`
  is the separate pinned guard and applies to the parent and the branch.
- The old data stays at `<dataDir>.pre-reset` until every resumed resource
  came back, and is reported if it is kept. A leftover one refuses the next
  reset, the rule `restoreInPlace` keeps for `.pre-restore-`.
- Refused: no parent, parent gone, released branch or parent, postgres
  resources that differ by name, unsettled states, a parent holding apps,
  workers or queues. Other kinds inside the branch are left alone apart from
  being stopped and started with it; their bindings survive because ids do.

**Expiry** (`packages/cli/src/daemon/expiry.ts`). `hobby branch --expires
7d` or `hobby expire <branch> <duration>|--never` sets `Project.expiresAt`,
resolved on the daemon's clock (ADR 0018's remote CLI may disagree). Only a
project with a parent may carry one; the route refuses others, and the sweep
also ignores any project without a parent. `startExpirySweeper` runs every
60 seconds from `startDaemon` and is drained on shutdown after the
hibernator. Durations are parsed by `parseDuration`
(`packages/cli/src/cli/output.ts`), the inverse of the existing
`renderDuration`; the repo had no duration parser before, so this is new
rather than reused.

The decision on conflicts, chosen as skip-and-log over force:

- **Pinned and expired: skipped**, one log line, until it is unpinned or
  its expiry cleared. Pinning says "keep this up", which outranks a timer
  set earlier, and only the operator can say which they meant.
- **Awake and expired: skipped** while any resource is running, starting or
  stopping, or has a proxied connection open. An unpinned branch sleeps on
  its own once idle and is deleted on the next sweep, so nothing is cut off.
- **Released, or held by a snapshot or restore: skipped.**
- The sweep never wakes anything. Deletion is `deleteProject`
  (`routes.ts`), the same teardown `hobby rm` runs, under
  `holdProjectAsleep` so a wake arriving mid-delete waits rather than races,
  and the at-rest check is repeated under the hold. One line per deletion:
  `expiry: deleted branch <name> (expired at <iso>)`. Skips are logged once
  per branch and reason, not every sweep.

`hobby ls` shows `(branch of <parent>, expires in 6d)`; JSON carries
`parentId` and `expiresAt` on each project.

**`hobby diff <branch>`** or **`hobby diff <a> <b>`** (`POST
/v1/projects/:name/diff`, `packages/cli/src/daemon/schema-diff.ts`) runs
`pg_dump --schema-only` inside each database's own container over the local
socket (`ComputeRuntime.execStream`, as online snapshots run pg_basebackup),
normalises away the `Dumped from/by` comments and the per-run
`\restrict`/`\unrestrict` keys, and prints a unified diff
(`packages/cli/src/daemon/unified-diff.ts`, Myers, three lines of context)
per same-named postgres pair. `--json` adds hunks as data. Only the
database the resource was created with is dumped.

It wakes what it compares, through `getOrCreateWake`, and says so in the
help text, the MCP description and on stderr. It does not keep them awake:
the dump connects with `application_name=hobby` in its conninfo, which the
activity guard excludes (`HOBBY_APPLICATION_NAME`,
`packages/pg/src/activity-guard.ts`), and it neither opens a tracker handle
nor touches the idle clock. The accepted cost: a database already at its
idle threshold can be slept by the hibernator mid-dump, and the diff then
fails with a hint to retry.

**Not done, and stated plainly:**

- **None of this has run against real Docker.** Fake-runtime tests only
  (`packages/cli/test/branch-workflows.test.ts`). In particular the pg_dump
  conninfo, the `\restrict` normalisation against the image's real pg_dump,
  the rename swap of a PGDATA owned by the container uid on Linux, and the
  container recreation in `rebindPostgresToClone` are unverified.
- **Linux ownership** is the same open question as branching and snapshots:
  the clone into staging reads a PGDATA the daemon user may not own, and
  removing `<dataDir>.pre-reset` with a plain `rm` can fail with EACCES, in
  which case it is reported and kept, and the next reset refuses until it is
  moved.
- No list of children, no merge, and no data diff.
