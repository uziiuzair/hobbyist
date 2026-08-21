# Project snapshots: quiesce, clone, and a restore that runs weekly

Status: PROPOSED. Nothing in this document is built. Approved in design on
2026-08-16; implementation has not started.
Date:   2026-08-16

Implements `docs/decisions/0016`. The scope cut it makes (no point-in-time
recovery) is argued there, not here.

## What this builds

A snapshot of a whole project, taken with everything in it stopped, restored by
default into a **new** project rather than over the old one.

Two properties matter:

1. **A snapshot is cheap where the filesystem allows it.** Reflink cloning makes
   a snapshot cost the delta, so keeping seven of them is not a decision anyone
   has to think about.
2. **The restore path runs every week, unattended.** Verification restores the
   newest snapshot into a throwaway project, starts it, checks readiness, and
   destroys it. The classic backup failure is not a bad copy, it is a restore
   procedure nobody has ever executed.

## The shape

```
  hobby snapshot blog                        daemon
        |                                       |
        | POST /v1/projects/blog/snapshots      |
        +-------------------------------------->|
                                                |  1. quiesce
                                                |     guardFor(kinds, ctx, r)
                                                |     kinds.get(r.kind).stop(ctx, r)
                                                |     for every running resource
                                                |
                                                |  2. cloneTree(
                                                |       projects/blog,
                                                |       snapshots/blog/<id>.partial/data)
                                                |
                                                |  3. write manifest.json
                                                |     rename <id>.partial -> <id>
                                                |
                                                |  4. restart whatever was running
                                                v
                                    <home>/snapshots/blog/<id>/
```

The daemon API stays the only control surface, so Studio and MCP get snapshots
without either of them learning what a snapshot is.

## Where the code goes

**No new package.** Two prior sessions recorded that adding a workspace package
breaks every other checkout until `npm install` runs (decision
`hobbyist.new-package-needs-npm-install`), and the root `CLAUDE.md` is explicit
that "a package that cannot be used without three siblings is a module, not a
package". Snapshots are that.

| File | Holds | New |
|---|---|---|
| `packages/core/src/copy.ts` | `cloneTree(src, dst)`: reflink per file where supported, plain copy otherwise | yes |
| `packages/cli/src/daemon/snapshots.ts` | Quiesce, clone, manifest, restore, retention, verification, the ticker | yes |
| `packages/cli/src/daemon/routes.ts` | Four routes, in the file's existing hand-written segment style (see `1747` onward) | edit |
| `packages/cli/src/cli/commands.ts` | `hobby snapshot <project>`, `hobby snapshot list <project>`, `hobby restore <snapshot-id>` | edit |
| `packages/core/src/config.ts` | Three optional `HobbyConfig` fields | edit |

`cloneTree` lives in `core` and not in the daemon for one reason: ADR 0005's
branching needs exactly the same primitive one level down (a stopped PGDATA
rather than a whole project). Two copiers would mean two ext4 fallbacks, one of
which is eventually wrong. It is pure `fs`, so it respects the rule in
`packages/core/src/types.ts:3` that core never imports Docker, Postgres or HTTP.

## Quiesce

Reuses hibernation rather than reimplementing it. For each resource in the
project whose state is `running`, in the order the store returns them:

1. `guardFor(ctx.kinds, ctx, resource)` (core), which for `postgres` is a real
   `pg_stat_activity` query (`packages/pg/src/activity-guard.ts`) and for a kind
   declaring no guard is a plain `idle`.
2. `ctx.kinds.get(resource.kind).stop(ctx, resource)`, the same call
   `hibernator.ts:202` makes.

Three results, and only one of them proceeds:

| Guard result | Snapshot behaviour |
|---|---|
| `idle` | Stop it, record that it was running, continue |
| `active` | Wait and retry, up to a bounded number of attempts, then **fail the snapshot** |
| `unreachable` | **Fail the snapshot immediately** |

This is deliberately stricter than the hibernator, which treats both non-idle
results as "skip this one, try again next tick". A skipped sleep costs a few
idle megabytes of RAM. A skipped resource inside a snapshot produces a backup
that is missing a database and does not say so.

After the clone, every resource recorded as running is started again, in reverse
order, and failures there are reported without invalidating the snapshot: the
copy on disk is already good, and conflating "the snapshot failed" with "one
container did not come back" would send a reader looking in the wrong place.

## On-disk layout

```
<home>/snapshots/<project>/<snapshot-id>/
  manifest.json
  data/<resource-name>/...        a clone of projects/<project>/<resource-name>
```

`<snapshot-id>` is a sortable timestamp plus a short random suffix, all
lowercase: `20260816t143000z-a1b2c3`. Lowercase is not cosmetic. Restore builds
project names out of this id, and `validateName`
(`packages/core/src/names.ts:10`) enforces `/^[a-z][a-z0-9-]{1,62}$/`, so an
uppercase `T` or `Z` in the timestamp would make a snapshot that cannot be
restored, discovered at restore time rather than at snapshot time.

Snapshot ids are unique across the whole install, not per project, so
`/v1/snapshots/:id` resolves by scanning `<home>/snapshots/*/` rather than
needing a project in the path.

The directory is built as `<snapshot-id>.partial` and renamed into place only
after `manifest.json` is written and flushed, so a crash mid-clone leaves
nothing that `hobby snapshot list` will ever offer.

Snapshots live under the same `<home>` as `projects/`, which is not incidental:
a reflink clone cannot cross filesystems. If `<home>/snapshots` is ever
relocated to another mount, cloning silently degrades to a full copy, so
`cloneTree` reports which mechanism it used and the snapshotter records it in
the manifest.

## The manifest

The directory tree carries the data. The manifest carries what `<home>/state.db`
knows and the tree does not.

```jsonc
{
  "version": 1,
  "snapshotId": "20260816T143000Z-a1b2c3",
  "createdAt": "2026-08-16T14:30:00.000Z",
  "clone": "reflink",              // or "copy", per cloneTree's report
  "project": {
    "name": "blog",
    "sleepAfterSeconds": 900
  },
  "resources": [
    {
      "id": "res_01H...",          // the OLD id. See "Restore" below
      "kind": "worker",
      "name": "api",
      "stateAtSnapshot": "running",
      "config": { /* the full ResourceConfig blob, verbatim */ },
      "durableObjectClasses": ["Counter"]
    }
  ],
  "verification": { "status": "unverified", "at": null, "detail": null }
}
```

`networkName` is deliberately not carried. A restored project gets a fresh
Docker network, and a stale name in a manifest would be a fact that is true in
the file and false on the machine.

The old resource id and `durableObjectClasses` exist for exactly one purpose,
described next.

## Restore

Default is `hobby restore <snapshot-id> --as <new-project-name>`, which is
non-destructive: the original project is untouched and may still be running.

Clone `data/` into a fresh project directory, create a new project row and fresh
resource rows via the existing `Store` methods, then rewrite everything in the
config that names the old project, the old id, or a resource the machine can
only give to one owner. Every item below is a silent failure if missed: the
restore succeeds, and the copy quietly shares something with the original.

**1. Ports.** `hostPort` is on `ResourceConfigBase` (`types.ts:55`) so every kind
has one, and `WorkerConfig.controlPort` (`types.ts:152`) is a second host-side
port. The original may still hold both. Each is reallocated through
`store.allocatePort` and written into the new config.

**2. Container names.** `containerName` is also on `ResourceConfigBase`. Docker
names are unique per daemon, so a restored resource that kept the original's
name cannot start while the original exists.

**3. `PostgresConfig.dataDir`.** An absolute path, written at creation from
`paths.resourcePath(project, name, 'pgdata')` (`packages/pg/src/postgres.ts:119`
and `:124`) and read directly as a bind mount at `:105`. Left alone, a restored
Postgres mounts and writes to **the original project's data directory**, which is
the worst outcome in this whole document: a restore that corrupts the thing it
was restoring from.

**4. Hostnames.** `AppConfig.hostname` (`types.ts:100`) and
`WorkerConfig.hostname` (`types.ts:175`) are built as
`<resource>.<project>.<domain>`. They must be re-derived from the new project
name, or the restored copy and the original claim the same Caddy route and one
of them wins arbitrarily.

**5. `WorkerConfig.queueToken`.** The bearer token a container's producer shim
sends to the daemon's enqueue listener. Regenerated with `randomUUID()`, not
copied: two resources holding one credential means the restored copy can enqueue
as the original. Note the field's own comment warns against *accidental*
regeneration, which is a different case: this one is deliberate, and the
restored worker's containers are all built fresh anyway.

**6. Durable Object storage directories.** This is the one that fails silently
and the reason the manifest carries old ids at all.
`packages/worker/src/worker.ts:88` derives a namespace's `unsafeUniqueKey` as
`uniqueKeyFor(resourceId, className)`, applied at `:174`, and the storage path
is `.../<worker>/do/<uniqueKey>/<objectId>.sqlite`. That path embeds the
**resource id**, which is the single exception to an otherwise name-addressed
layout. A restored worker has a new id, so every one of its objects would come
up empty rather than erroring: the state is on disk, under a key nothing will
ever ask for again. Restore renames each `${oldId}-${class}` directory to
`${newId}-${class}`, mechanically, from the manifest.

Miniflare's own `metadata.sqlite` sits beside the object files in each namespace
directory and is not an object. The rename operates on directory names, so it is
unaffected, but any future scanner over this tree must skip it.

`WorkerConfig.durableObjectUniqueKeyModifier` (`types.ts:188`) is a separate
field, also derived from the resource id, that the runner manifest at
`worker.ts:174` does **not** currently pass: the key there comes from
`uniqueKeyFor(resource.id, className)` directly. Restore re-derives the modifier
from the new id anyway, so the two cannot disagree. If a later change routes the
key through the modifier instead, the rename above stays correct and this
paragraph is the note that says why.

Preserved verbatim: `PostgresConfig.password` (the cloned data directory expects
it), queue backlogs, and worker queue bindings, whose `producers[].queue` field
references a queue **name** (`types.ts:129`) and therefore survives the
reproject unchanged.

`hobby restore <id> --in-place` is the destructive variant. It removes the
current project's directories and restores the original resource ids, so no DO
rename is needed. It requires confirmation and it refuses to run against a
project that is not fully stopped.

## Schedule, retention, free space

Three optional fields on `HobbyConfig` (`packages/core/src/config.ts:72`).
Optional for the same reason `queuePort` is optional at `:101`: every hand-built
config fixture across the repo would otherwise have to be touched to add a field
it does not care about, and `DEFAULT_CONFIG` supplies the real values.

| Field | Default | Why |
|---|---|---|
| `snapshotEverySeconds` | `86400` | On by default. A backup a user has to enable is a backup that does not exist |
| `snapshotKeep` | `7` | A week of dailies |
| `snapshotMinFreeBytes` | `2 GiB` | The floor below which a snapshot refuses to start |
| `snapshotVerifyEverySeconds` | `604800` | How often the restore path is actually exercised. `null` disables it |

`startSnapshotter(ctx, opts)` follows the shape of `startHibernator`
(`hibernator.ts:209`): an interval, the in-flight tick tracked so `stop()` can
await it, and `stop()` racing the interval wait rather than waiting it out.

**Retention is filesystem-aware in effect, not in configuration.** Seven daily
snapshots on APFS cost roughly one copy plus seven deltas. On ext4 they cost
seven full copies of every PGDATA in the project. Rather than a second knob, the
snapshotter checks free space (`runPreflight` already reports
`filesystem.freeBytes` and `filesystem.reflinkSupported`, surfaced at
`packages/studio/src/api.ts:118`) and refuses to start a snapshot that would
cross `snapshotMinFreeBytes`, logging the numbers and the reason. Pruning past
`snapshotKeep` happens **after** a new snapshot lands, never before, so a failed
snapshot never costs the user the older one it was going to replace.

## Verification

Weekly, and it is the reason restore-to-a-new-project is the default rather than
an option.

1. Restore the newest snapshot as `verify-<suffix>`, where `<suffix>` is the
   snapshot id's random tail. Not `<project>-verify-<snapshot-id>`: project
   names cap at 63 characters (`names.ts:7`), and a long project name plus a
   full snapshot id crosses it, which would make verification fail on exactly
   the installs that have been running longest.
2. Start every resource in it.
3. Assert each kind's own readiness probe passes. Not a TCP connect: the probe
   that `packages/cli/src/daemon/reconcile.ts` documents at length and that
   Phase 2 had to relearn, which sends a real request and requires a real
   answer.
4. Destroy the verify project.
5. Write the result back into the snapshot's manifest.

`verification.status` is tri-state, `unverified` / `verified` / `failed`, and not
a boolean. "We have not checked yet" is a different fact from "we checked and it
was fine", and collapsing them is the same mistake `ActivityGuardResult` avoids
in `packages/core/src/kinds.ts` by keeping `unreachable` distinct from `idle`. A
check that did not run must never read as a check that passed. `hobby snapshot
list` prints the state per row.

## Daemon API

| Method | Path | Does |
|---|---|---|
| `POST` | `/v1/projects/:name/snapshots` | Take one now. Returns the manifest |
| `GET` | `/v1/projects/:name/snapshots` | List, newest first, with verification state |
| `POST` | `/v1/snapshots/:id/restore` | Body `{ as?: string, inPlace?: boolean }` |
| `DELETE` | `/v1/snapshots/:id` | Remove one |

## Testing

Matching the repo's existing split, and weighted by the lesson recorded in
`claude_docs/PROGRESS.md`: all three Phase 2 bugs came from running the thing,
none from testing it.

- `packages/core/test/copy.test.ts`: `cloneTree` against a real temp directory,
  both branches, asserting the fallback produces byte-identical output and that
  the reported mechanism matches what actually happened.
- `packages/cli/test/snapshots.test.ts`, against the fake runtime already used
  by `queues.test.ts` and `kind-dispatch.test.ts`. At minimum: guard returns
  `active` (waits, then fails, and takes no snapshot); guard returns
  `unreachable` (fails immediately); a resource already asleep is still asleep
  afterwards; a resource that was running is running again afterwards; restore
  reallocates a port that the original still holds; restore renames the DO
  namespace directory; a crash between clone and manifest leaves no listable
  snapshot.
- `packages/cli/test/routes.test.ts`: the four routes.
- **One run against real Docker, by hand, filed with hardware in
  `docs/backups/research/`.** Snapshot a project holding a Postgres with rows, a
  worker with a Durable Object holding a counter, and a queue with an
  undelivered backlog. Restore it as a new project. Assert all three survived.
  The counter is the one a weaker test passes and a real run catches, for the
  reason given under Restore.

## What this deliberately does not build

- **Point-in-time recovery.** ADR 0016.
- **Offsite or S3 targets.** The manifest is designed so an archive exporter is
  a serializer over the same inventory, but it is not in this release, and until
  it exists the documentation says "local snapshots", not "backups".
- **Per-resource snapshots.** The unit is the project.
- **Hot snapshots.** Quiesce is the whole consistency story.
- **Snapshot of the daemon's own `state.db`.** The manifest carries the rows
  that matter for the projects it covers. A whole-daemon disaster is what eject
  and a plain data directory already answer.
