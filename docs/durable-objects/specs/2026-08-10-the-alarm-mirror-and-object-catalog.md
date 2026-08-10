# The alarm mirror and the object catalog

Status: RATIFIED. `@hobby.sh/do` is built against this. The wiring into the
daemon is marked `DRAFT pending @hobby.sh/compute` where it depends on work that
has not merged.
Date:   2026-08-10

Implements the third part of `docs/decisions/0012`. Evidence for every claim
about workerd's on-disk behavior is in
`docs/durable-objects/research/2026-08-10-alarms-are-readable-from-outside.md`,
which includes the probe that produced it.

## What this builds

A package that lets a Durable Object namespace **sleep** without losing its
alarms, and that gives the CLI and Studio something to show for a namespace whose
runtime is stopped.

It never starts a container, never runs SQL against a live runtime, and never
fires an alarm.

## The disk contract

Everything rests on one layout, verified empirically on `miniflare@4.20260730.0`:

```
<resourceRoot>/do/                             the DiskDirectory service root
  <uniqueKey>/                                 one per namespace, <modifier>-<ClassName>
    metadata.sqlite                            _cf_ALARM, the namespace's schedule
    metadata.sqlite-wal, -shm
    <id>.sqlite                                one per object, <id> is 64 hex chars
    <id>.sqlite-wal, -shm
```

```sql
CREATE TABLE _cf_ALARM (
  actor_id TEXT PRIMARY KEY,
  scheduled_time INTEGER,   -- int64 NANOSECONDS since the Unix epoch
  actor_name TEXT           -- the idFromName() name, or NULL
) WITHOUT ROWID;
```

**The unit is nanoseconds.** Every other clock in this codebase is milliseconds
(`hibernator.ts` takes `now: () => number`), so the conversion happens once, at
the read, and nanoseconds never escape `alarms.ts`.

**`uniqueKey` is `<durableObjectUniqueKeyModifier>-<ClassName>`** and the
modifier is the owning resource's UUID. Parsing splits at the **last** hyphen: a
UUID contains hyphens, a JavaScript class name cannot.

## Modules

Five files, each with one job, none of them importing another's internals.

### `alarms.ts` reads a stopped namespace's schedule

```ts
export interface PendingAlarm {
  actorId: string          // 64 hex chars, the object's file basename
  actorName: string | null // null when the object was addressed by id, not name
  scheduledAtMs: number    // converted from nanoseconds at the read
}

export function readPendingAlarms(namespaceDir: string): PendingAlarm[]
export function nextAlarmAtMs(namespaceDir: string): number | null
```

`readPendingAlarms` opens `<namespaceDir>/metadata.sqlite` **read only** and runs
one query. It is the only place in the package that knows the table name.

Three behaviors that are requirements, not implementation details:

1. **A missing `metadata.sqlite` returns `[]`.** A namespace that has never run
   has no schedule, and that is not an error.
2. **A present file whose `_cf_ALARM` table is missing or has the wrong columns
   throws.** This is the difference between "nothing is scheduled" and "we can no
   longer read the schedule", and conflating them produces a mirror that silently
   never wakes anything. ADR 0012 accepts a dependency on an upstream
   experimental layout specifically on the condition that a break is loud.
3. **Read only, always.** Opening a WAL database read-write can create sidecar
   files and checkpoint the log. The mirror observes; it must not perturb.

### `sleep.ts` is the pure predicate the hibernator consults

```ts
export interface ShouldSleepNamespaceInput {
  state: ResourceState
  idleSeconds: number | null
  sleepAfterSeconds: number | null
  nextAlarmAtMs: number | null
  nowMs: number
  wakeGraceSeconds: number
}

export function shouldSleepNamespace(input: ShouldSleepNamespaceInput): boolean
```

Deliberately the same shape as `shouldSleep` in
`packages/cli/src/daemon/hibernator.ts:32`: every value handed in, no clock, no
I/O, so the truth table is testable in a plain loop. It adds exactly one rule to
that function's five:

> **Refuse to sleep when the next alarm is due within `wakeGraceSeconds`.**

Sleeping at 02:59:58 in order to wake at 03:00:00 costs a container stop and a
cold start to save two seconds of idle memory. The grace window is a parameter
rather than a constant because the right value is unmeasured; see the open
question in `docs/durable-objects/CLAUDE.md`.

An alarm whose deadline has already passed does **not** block sleep. A namespace
that is stopped with an overdue alarm should be woken by `scheduleWakes`, not
kept awake by the predicate, and the two rules must not fight over it.

### `catalog.ts` describes a namespace without running it

```ts
export interface ObjectSummary {
  id: string               // 64 hex chars
  name: string | null      // only known when the object has a pending alarm
  sizeBytes: number        // the .sqlite file, excluding -wal and -shm
  modifiedAtMs: number
  alarmAtMs: number | null
}

export interface NamespaceSummary {
  uniqueKey: string
  className: string
  resourceId: string
  objectCount: number
  totalSizeBytes: number
  nextAlarmAtMs: number | null
  objects: ObjectSummary[]
}

export function listNamespaces(doRoot: string): NamespaceSummary[]
export function describeNamespace(doRoot: string, uniqueKey: string): NamespaceSummary
```

`metadata.sqlite` is not an object and is excluded. `-wal` and `-shm` are not
objects either, and are excluded from the count while their bytes are excluded
from `sizeBytes`, because a WAL that is about to be checkpointed is not storage
the user owns in any meaningful sense.

**`name` is populated only for objects with a pending alarm**, because
`_cf_ALARM.actor_name` is the only place the name is persisted and `idFromName`
is an HMAC that does not reverse. This is stated in the type (`string | null`)
and in the CLI output rather than papered over.

**`listNamespaces` skips a directory it cannot parse; `describeNamespace`
throws on one.** A listing backs Studio and `hobby do ls`, and one stray
directory must not blank the page, which is the same containment `tickOnce`
applies per namespace. Asking for a specific namespace by name is different:
the caller named something, and deserves to be told it is wrong. This split was
added after running the finished package against a real Miniflare tree written
with no unique key modifier, whose directories are named `-Room`: the first one
aborted the whole listing.

### `storage.ts` owns the file lifecycle

```ts
export interface MutationGuard { state: ResourceState }

export function deleteObject(namespaceDir: string, actorId: string, guard: MutationGuard): void
export function pruneNamespace(doRoot: string, uniqueKey: string, guard: MutationGuard): void
```

`deleteObject` unlinks `<id>.sqlite`, `<id>.sqlite-wal` and `<id>.sqlite-shm` as
one unit and clears the object's `_cf_ALARM` row, so a deleted object cannot wake
the runtime from beyond the grave. It validates that `actorId` is 64 hex
characters before touching the filesystem: the id reaches this function from the
CLI and from Studio, and a path separator in it would make this an arbitrary
delete.

**Both refuse to run while the runtime is running.** Same reasoning as
`packages/pg/src/activity-guard.ts` refusing to sleep mid-transaction: never
mutate storage under a live process. The caller passes the resource state; the
functions do not go looking for it.

### `mirror.ts` is the impure half, and the only file with a timer

```ts
export interface AlarmMirrorOptions {
  namespaces: () => Array<{ resourceId: string; namespaceDir: string }>
  wake: (resourceId: string) => Promise<void>
  intervalMs: number
  now?: () => number
  sleepFor?: (ms: number) => Promise<void>
}

export function startAlarmMirror(opts: AlarmMirrorOptions): { stop(): Promise<void> }
```

Structure copied deliberately from `startHibernator`
(`packages/cli/src/daemon/hibernator.ts:182`), including the injectable `now` and
`sleepFor` seams, the `waitOrStop` race so a shutdown does not wait out an
interval, the tracked in-flight tick so `stop()` drains rather than abandoning,
and per-tick error containment so one bad namespace cannot kill the loop.

**It polls rather than setting one timer per alarm.** A timer per alarm would be
more precise and would be wrong: alarms are set and cleared by a running
runtime that this package does not observe, so every set would need an
invalidation path back into here. Polling re-reads the truth each tick and has no
cache to invalidate. It is the same argument `docs/proxy/research/2026-08-10-neon-proxy-prior-art.md`
records for re-resolving rather than trusting a cached upstream address.

`wake` is a callback for the reason `docs/proxy/CLAUDE.md` gives for its own:
**the clock asks, the engine acts.** This package has no `ComputeRuntime`, no
Docker, and no way to start anything, which is what makes the whole loop testable
against a counter in a temp directory.

## What this does not do

- **Fire alarms.** workerd reloads and reschedules every `_cf_ALARM` row in its
  constructor (`alarm-scheduler.c++:86-99`). Being awake at the deadline is the
  whole contribution.
- **Talk to a running runtime.** Every read is a stopped-runtime read. Reading
  `metadata.sqlite` while Miniflare holds it is safe (read only, WAL) but
  meaningless, since the live scheduler's in-memory state is authoritative then.
- **Own the runtime, the manifest, the generated config or HTTP wake.** Those are
  `@hobby.sh/compute`.
- **Resolve a name to an object id.** Derivable from `actor-id-impl.c++`, not
  implemented, documented as absent.

## Wiring

Done, against `phase-2-compute`. Amended 2026-08-10, after that branch landed
`ResourceKind`, `ResourceKindHandler` and `resourcePath(project, resource, part)`:

- **`guard.ts`** provides `durableObjectAlarmGuard`, which
  `packages/worker/src/kind.ts` returns from `ResourceKindHandler.guard`. Core
  calls it exactly once immediately before an irreversible stop. It answers
  `'active'` on a due or imminent alarm, `'idle'` otherwise, and
  `'unreachable'` when the schedule cannot be read, because core's own contract
  says a guard that could not answer must never be read as permission to stop.
- **`packages/cli/src/daemon/alarms.ts`** joins the mirror to the store, and
  `server.ts` starts `startAlarmMirror` beside the hibernator and drains it in
  the same shutdown step.

**The guard's question is not the predicate's question**, and this is the one
place the two diverge. `shouldSleepNamespace` reasons about a namespace the
daemon is considering stopping and lets an *overdue* alarm through, because the
mirror handles those. The guard runs against a **running** container, where an
overdue row means workerd is firing that alarm right now (the row is deleted
when it fires, so its presence means the handler has not finished). Stopping
there kills an alarm mid-flight, which is what
`packages/pg/src/activity-guard.ts` prevents for a transaction. Hence
`isAlarmWithin` for the guard and `isAlarmImminent` for the predicate.

Still not built:

- registering `durable_object` as its own `ResourceKind` and reconciling
  namespaces from the manifest on deploy, per ADR 0012 parts 1 and 2. Today a
  namespace is storage belonging to a `worker` resource, and the catalog reads
  it from disk; the store holds no row per namespace, so per-namespace branch
  and backup are described but not reachable.
- `hobby do ls`, `hobby do inspect`, `hobby do rm`, and the Studio view. The
  functions behind all four exist and are tested; nothing calls them.

## Tests

`node --test` against `packages/do/dist/test/*.test.js`, matching the root
`test` script. No Docker, no workerd, no Miniflare, no real clock.

Fixtures are **real SQLite files** built in a temp directory by creating the
`_cf_ALARM` schema exactly as `alarm-scheduler.c++:55` declares it, not mocks of
a database. A mock would have let the nanosecond/millisecond confusion through,
which is the single most likely bug in this package.

**A fixture must write the nanosecond value as a decimal literal**, six zeros
appended to the millisecond count. Binding milliseconds and writing
`scheduled_time = ? * 1000000` does not work: `node:sqlite` binds the parameter
as a double, and `1786375171389000000` has 19 significant digits where a double
holds about 16, so it is stored as `1786375171388999936` and every assertion
comes back exactly one millisecond low. That was a real failure during the
build. workerd never takes this route, computing
`(t - kj::UNIX_EPOCH) / kj::NANOSECONDS` in `int64`, so a fixture that
reproduced the rounding would be testing a database workerd never writes.

Cases that must exist:

| Case | Asserts |
|---|---|
| Namespace with no `metadata.sqlite` | `[]`, not a throw |
| `metadata.sqlite` with no `_cf_ALARM` | throws, does not return `[]` |
| `_cf_ALARM` missing the `actor_name` column | throws |
| Row with `actor_name` NULL | `name: null`, not `"null"` or `""` |
| Nanosecond value | converts to the exact millisecond the worker set |
| Two alarms | `nextAlarmAtMs` is the earlier one |
| Overdue alarm | does not block sleep, does trigger a wake |
| Alarm inside the grace window | blocks sleep |
| Alarm outside the grace window | does not block sleep |
| `metadata.sqlite` in the object listing | excluded |
| `-wal` and `-shm` in the object listing | excluded |
| `actorId` containing `/` or `..` | rejected before any filesystem call |
| `deleteObject` | removes all three files and the `_cf_ALARM` row |
| Delete or prune while running | refused |
| `uniqueKey` `<uuid>-Room` | parses to that resource id and `Room` |
| Mirror tick | calls `wake` once per due namespace, never for a future alarm |
| Mirror `stop()` | drains an in-flight tick |
