// Whole-project snapshots: quiesce, clone, manifest. ADR 0016.
//
// The unit is the project rather than the resource because a project holds a
// postgres, the workers with Durable Object state, and the queue holding
// undelivered messages about all of it. Backing one up without the others
// produces a copy that is internally inconsistent in a way nobody notices until
// they restore it.

import { randomUUID } from 'node:crypto'
import { lstat, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  cloneTree,
  guardFor,
  HobbyError,
  validateName,
  type ActivityGuardResult,
  type CloneMechanism,
  type Paths,
  type Project,
  type Resource,
  type ResourceConfig,
  type ResourceId,
  type ResourceKind,
  type ResourceState,
} from '@hobby.sh/core'
import { APP_PORT_RANGE } from '@hobby.sh/app'
import { createPostgresFromClone } from '@hobby.sh/pg'
import { WORKER_PORT_RANGE } from '@hobby.sh/worker'
import { holdProjectAsleep, type DaemonContext } from './context.js'

// Sortable, and lowercase because restore builds project names out of this and
// validateName (packages/core/src/names.ts:10) allows only /^[a-z][a-z0-9-]/.
// An uppercase T or Z from toISOString would produce a snapshot that takes
// cleanly and cannot be restored, discovered on the worst day.
export function snapshotId(nowMs: number, suffix: string): string {
  const iso = new Date(nowMs).toISOString()
  const stamp = iso.replace(/[-:]/g, '').replace(/\.\d{3}/, '').toLowerCase()
  return `${stamp}-${suffix}`
}

// The verify project is named from the suffix alone, never
// `<project>-verify-<id>`: project names cap at 63 characters, and a long
// project name plus a full id crosses it, so verification would start failing
// on exactly the installs that have been running longest.
export function verifyProjectName(id: string): string {
  const suffix = id.slice(id.indexOf('-') + 1)
  return `verify-${suffix}`
}

export function snapshotsRoot(paths: Paths): string {
  return join(paths.home, 'snapshots')
}

export function projectSnapshotsDir(paths: Paths, project: string): string {
  return join(snapshotsRoot(paths), project)
}

export function snapshotDir(paths: Paths, project: string, id: string): string {
  return join(projectSnapshotsDir(paths, project), id)
}

const DEFAULT_QUIESCE_ATTEMPTS = 5
const DEFAULT_QUIESCE_WAIT_MS = 2000

export interface QuiesceOptions {
  attempts?: number
  waitMs?: number
  sleepFor?: (ms: number) => Promise<void>
  guard?: (resource: Resource) => Promise<ActivityGuardResult>
  // Called right after each successful stop, in stop order, the same moment
  // the local `stopped` array below is pushed to. quiesce's own return value
  // is only reached if every stop in the project succeeds; a caller that
  // must resume whatever DID stop even when a later one throws (takeSnapshot)
  // has no other way to learn that partial progress, since the throw
  // discards quiesce's local array along with the rest of its stack frame.
  onStopped?: (id: ResourceId) => void
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function defaultSleepFor(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// Deliberately stricter than the hibernator, which treats both non-idle
// guard results (active and unreachable) as "not idle, leave it alone and
// try again next tick" (hibernator.ts's tick, the guardResult handling at
// lines 154-165). A skipped sleep there costs a few idle megabytes. A
// skipped resource inside a snapshot produces a backup that is missing a
// database and does not say so, so an unreachable guard fails the whole
// snapshot here instead of being quietly deferred.
async function waitForIdle(
  resource: Resource,
  guard: (resource: Resource) => Promise<ActivityGuardResult>,
  attempts: number,
  waitMs: number,
  sleepFor: (ms: number) => Promise<void>
): Promise<void> {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const result = await guard(resource)
    if (result === 'idle') {
      return
    }
    if (result === 'unreachable') {
      throw new HobbyError(
        'conflict',
        `could not confirm ${resource.name} is idle`,
        'a snapshot taken while a resource cannot answer its activity guard would be recorded as good without being known to be'
      )
    }
    if (attempt < attempts) {
      await sleepFor(waitMs)
    }
  }
  throw new HobbyError(
    'conflict',
    `${resource.name} is still active after ${attempts} attempts`,
    'retry when it is idle, or stop it yourself first'
  )
}

// Returns the ids it stopped, in stop order, so resume (below) can bring
// them back in the reverse of that order. Every running resource's guard is
// consulted before anything is stopped: stopping resource one and then
// failing resource two would leave the project half down with no snapshot
// to show for it, which is worse than refusing outright before touching
// anything.
export async function quiesce(ctx: DaemonContext, project: Project, opts: QuiesceOptions = {}): Promise<ResourceId[]> {
  const attempts = opts.attempts ?? DEFAULT_QUIESCE_ATTEMPTS
  const waitMs = opts.waitMs ?? DEFAULT_QUIESCE_WAIT_MS
  const sleepFor = opts.sleepFor ?? defaultSleepFor
  const guard = opts.guard ?? ((resource: Resource): Promise<ActivityGuardResult> => guardFor(ctx.kinds, ctx, resource))

  const running = ctx.store.listResources(project.id).filter((resource) => resource.state === 'running')

  for (const resource of running) {
    await waitForIdle(resource, guard, attempts, waitMs, sleepFor)
  }

  const stopped: ResourceId[] = []
  for (const resource of running) {
    await ctx.kinds.get(resource.kind).stop(ctx, resource)
    stopped.push(resource.id)
    opts.onStopped?.(resource.id)
  }
  return stopped
}

// Failures are returned rather than thrown: by the time resume runs, the
// clone quiesce made room for is already on disk and good, and reporting
// "the snapshot failed" because one resource did not restart would send a
// reader looking in the wrong place. Started in reverse of quiesce's stop
// order, the usual shutdown-then-startup symmetry.
export async function resume(ctx: DaemonContext, ids: ResourceId[]): Promise<string[]> {
  const failures: string[] = []
  for (const id of [...ids].reverse()) {
    const resource = ctx.store.getResource(id)
    if (resource === null) {
      continue
    }
    try {
      await ctx.kinds.get(resource.kind).start(ctx, resource)
    } catch (err: unknown) {
      failures.push(`restart ${resource.name}: ${errorMessage(err)}`)
    }
  }
  return failures
}

export interface SnapshotResourceEntry {
  id: string
  kind: ResourceKind
  name: string
  stateAtSnapshot: ResourceState
  config: ResourceConfig
  durableObjectClasses: string[]
}

export interface SnapshotVerification {
  status: 'unverified' | 'verified' | 'failed'
  at: string | null
  detail: string | null
}

export interface SnapshotManifest {
  version: 1
  snapshotId: string
  createdAt: string
  clone: CloneMechanism
  project: { name: string; sleepAfterSeconds: number | null }
  resources: SnapshotResourceEntry[]
  verification: SnapshotVerification
}

export interface TakeSnapshotOptions {
  now?: () => number
  suffix?: () => string
  quiesce?: QuiesceOptions
}

// Only a worker has Durable Object classes, and only once it has deployed. The
// names exist in the manifest for exactly one consumer: restore, which needs
// them to compute the OLD storage keys it is renaming away from.
function durableObjectClassesOf(config: ResourceConfig): string[] {
  if (!('manifest' in config)) {
    return []
  }
  const manifest = config.manifest
  if (manifest === null) {
    return []
  }
  return manifest.durableObjects.map((entry) => entry.className)
}

function projectOrThrow(ctx: DaemonContext, name: string): Project {
  const project = ctx.store.getProjectByName(name)
  if (project === null) {
    throw new HobbyError('project_not_found', `no project named ${name}`, 'run `hobby ls` to see what exists')
  }
  return project
}

export async function takeSnapshot(
  ctx: DaemonContext,
  projectName: string,
  opts: TakeSnapshotOptions = {}
): Promise<SnapshotManifest> {
  const nowMs = (opts.now ?? Date.now)()
  const suffix = (opts.suffix ?? (() => randomUUID().slice(0, 6)))()
  const project = projectOrThrow(ctx, projectName)

  const id = snapshotId(nowMs, suffix)
  const finalDir = snapshotDir(ctx.paths, project.name, id)
  // Built under .partial and renamed only once the manifest is on disk, so a
  // crash mid-clone leaves nothing that list will ever offer on the worst day.
  const partialDir = `${finalDir}.partial`

  // Declared before the try, and filled in by quiesce's onStopped as it
  // goes, because quiesce itself can throw partway through a multi-resource
  // project: one kind handler's stop can succeed while the next one throws
  // (postgresKindHandler.stop forwards to stopPostgres,
  // packages/pg/src/postgres.ts's stopPostgres, which marks the resource
  // failed and rethrows on a real Docker error). quiesce's own return value
  // is unreachable in that case, so onStopped is the only way this array
  // ends up holding the resources that genuinely did stop. quiesce now runs
  // inside the try below so that partial progress is resumed in finally
  // exactly like a clean quiesce's would be.
  const stopped: ResourceId[] = []
  // Taken before quiesce and released only after resume, so nothing can wake
  // a resource between the stop and the clone (holdProjectAsleep's comment,
  // packages/cli/src/daemon/context.ts, has the pool-reconnect case that
  // makes this ordinary rather than rare). Outside the try: a refusal here
  // has stopped nothing and cloned nothing, so there is nothing to undo.
  const release = holdProjectAsleep(ctx, project.id, project.name)
  try {
    await quiesce(ctx, project, { ...opts.quiesce, onStopped: (resourceId) => stopped.push(resourceId) })

    await mkdir(partialDir, { recursive: true })
    const result = await cloneTree(join(ctx.paths.projectsDir, project.name), join(partialDir, 'data'))
    const clone = result.mechanism

    const manifest: SnapshotManifest = {
      version: 1,
      snapshotId: id,
      createdAt: new Date(nowMs).toISOString(),
      clone,
      project: { name: project.name, sleepAfterSeconds: project.sleepAfterSeconds },
      resources: ctx.store.listResources(project.id).map((resource) => ({
        id: resource.id,
        kind: resource.kind,
        name: resource.name,
        stateAtSnapshot: resource.state,
        config: resource.config,
        durableObjectClasses: durableObjectClassesOf(resource.config),
      })),
      verification: { status: 'unverified', at: null, detail: null },
    }
    await writeFile(join(partialDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
    await rename(partialDir, finalDir)

    return manifest
  } catch (err: unknown) {
    await rm(partialDir, { recursive: true, force: true })
    throw err
  } finally {
    // Safe to await unguarded only because resume (above) already catches
    // every start() failure itself and returns failure strings rather than
    // throwing. If that contract ever changed, a throw here would replace
    // whatever error the try/catch above was already carrying.
    const failures = await resume(ctx, stopped)
    for (const failure of failures) {
      console.error(`snapshot: ${failure}`)
    }
    release()
  }
}

export interface FoundSnapshot {
  manifest: SnapshotManifest
  dir: string
  project: string
}

async function readManifest(dir: string): Promise<SnapshotManifest | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8'))
    if (!isSnapshotManifest(parsed)) {
      return null
    }
    return parsed
  } catch {
    return null
  }
}

// Narrowing rather than casting, per the repo's global constraint. A manifest
// written by a future version with a higher `version` is refused here rather
// than half-read, because a restore driven by a partly understood manifest is
// the one failure this whole feature exists to prevent.
function isSnapshotManifest(value: unknown): value is SnapshotManifest {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  const record: Record<string, unknown> = { ...value }
  return (
    record.version === 1 &&
    typeof record.snapshotId === 'string' &&
    typeof record.createdAt === 'string' &&
    Array.isArray(record.resources)
  )
}

async function readdirOrEmpty(dir: string): Promise<string[]> {
  try {
    return await readdir(dir)
  } catch {
    return []
  }
}

// Directories ending .partial are a takeSnapshot in progress or one that
// crashed mid-clone (the try/catch in takeSnapshot above). Either way they
// are not a snapshot yet, and offering one here is exactly what the
// rename-into-place in takeSnapshot exists to prevent.
export async function listSnapshots(ctx: DaemonContext, projectName: string): Promise<SnapshotManifest[]> {
  const dir = projectSnapshotsDir(ctx.paths, projectName)
  const entries = (await readdirOrEmpty(dir)).filter((entry) => !entry.endsWith('.partial'))
  const manifests: SnapshotManifest[] = []
  for (const entry of entries.sort().reverse()) {
    const manifest = await readManifest(join(dir, entry))
    if (manifest !== null) {
      manifests.push(manifest)
    }
  }
  return manifests
}

// Ids are unique across the install, not per project (snapshotId above mints
// them from a timestamp and a random suffix), so resolving one means scanning
// every project's snapshot directory rather than requiring the caller to
// already know which project it lives under.
//
// The id arrives from a URL (the snapshot routes in
// packages/cli/src/daemon/routes.ts) and is joined into a path below, and
// deleteSnapshot rm -rf's whatever this resolves. Anything not shaped like
// snapshotId's own output is therefore not found, rather than a `..` that
// walks out of snapshots/.
const SNAPSHOT_ID = /^[0-9]{8}t[0-9]{6}z-[a-z0-9]+$/

export async function findSnapshot(ctx: DaemonContext, id: string): Promise<FoundSnapshot | null> {
  if (!SNAPSHOT_ID.test(id)) {
    return null
  }
  for (const project of await readdirOrEmpty(snapshotsRoot(ctx.paths))) {
    const dir = snapshotDir(ctx.paths, project, id)
    const manifest = await readManifest(dir)
    if (manifest !== null) {
      return { manifest, dir, project }
    }
  }
  return null
}

export async function deleteSnapshot(ctx: DaemonContext, id: string): Promise<void> {
  const found = await findSnapshot(ctx, id)
  if (found === null) {
    throw new HobbyError('resource_not_found', `no snapshot ${id}`, 'run `hobby snapshot ls <project>`')
  }
  await rm(found.dir, { recursive: true, force: true })
}

export async function writeVerification(found: FoundSnapshot, verification: SnapshotVerification): Promise<void> {
  const updated: SnapshotManifest = { ...found.manifest, verification }
  await writeFile(join(found.dir, 'manifest.json'), `${JSON.stringify(updated, null, 2)}\n`, 'utf8')
}

export interface RestoreOptions {
  as?: string
  inPlace?: boolean
  // In-place only, and for the same test seam takeSnapshot's own `quiesce`
  // option exists for: a restore over a running project stops it first.
  quiesce?: QuiesceOptions
}

export interface RestoreResult {
  project: Project
  resources: Resource[]
  // In-place only; always empty for a restore into a new project, which
  // starts nothing. One entry per resource that was running before the
  // restore and did not come back on the restored data.
  restartFailures: string[]
  // In-place only. Where the data the restore replaced still sits, or null
  // once it has been removed. Non-null means the restore did not fully
  // succeed (something failed to restart on the restored data), or the old
  // data could not be deleted; either way it is the operator's to inspect,
  // never ours to delete.
  preRestoreDir: string | null
}

// Every field below either names the old project, embeds the old resource id,
// or is unique per machine. Each one is a SILENT failure if missed: the restore
// succeeds and the copy quietly shares something with the original.
//
// Postgres does not come through here: createPostgresFromClone
// (packages/pg/src/postgres.ts) builds its config and, unlike a row rewrite,
// creates its container, which a postgres needs and an app or worker does
// not (their start paths call ensureCreated themselves). A queue does not
// either: it has no container and no port (its hostPort is the unused 0 that
// createQueueResource in routes.ts writes), so it keeps its config verbatim
// rather than being handed a port nothing will ever bind.
//
// Ports come from each kind's own range (APP_PORT_RANGE, WORKER_PORT_RANGE),
// never a range of this file's own: an earlier version allocated every kind
// from 15000 to 19999, which put a restored postgres below the range every
// other postgres lives in, and an app or worker inside it.
function rewriteConfig(
  ctx: DaemonContext,
  config: ResourceConfig,
  projectName: string,
  resourceName: string,
  newId: string
): ResourceConfig {
  if ('queueToken' in config) {
    const hostPort = ctx.store.allocatePort(WORKER_PORT_RANGE.from, WORKER_PORT_RANGE.to)
    return {
      ...config,
      containerName: `hobby-${projectName}-${resourceName}`,
      hostPort,
      controlPort: ctx.store.allocatePort(WORKER_PORT_RANGE.from, WORKER_PORT_RANGE.to, [hostPort]),
      queueToken: randomUUID(),
      hostname: `${resourceName}.${projectName}.${ctx.config.domain}`,
      durableObjectUniqueKeyModifier: newId,
    }
  }

  if ('hostname' in config) {
    return {
      ...config,
      containerName: `hobby-${projectName}-${resourceName}`,
      hostPort: ctx.store.allocatePort(APP_PORT_RANGE.from, APP_PORT_RANGE.to),
      hostname: `${resourceName}.${projectName}.${ctx.config.domain}`,
    }
  }

  return config
}

// worker.ts:174 builds a Durable Object's storage key from the RESOURCE ID
// (uniqueKeyFor, worker.ts:88), and the key is the directory name under
// .../<worker>/do/. A restored worker has a new id, so without this rename
// every object comes up empty rather than erroring: the state is on disk under
// a key nothing will ever ask for again. The sharpest silent failure in the
// whole feature.
async function renameDurableObjectDirs(
  ctx: DaemonContext,
  projectName: string,
  entry: SnapshotResourceEntry,
  newId: string
): Promise<void> {
  const doDir = ctx.paths.resourcePath(projectName, entry.name, 'do')
  for (const className of entry.durableObjectClasses) {
    const from = join(doDir, `${entry.id}-${className}`)
    const to = join(doDir, `${newId}-${className}`)
    try {
      await rename(from, to)
    } catch {
      // A worker that has deployed but whose object has never been addressed
      // has no directory yet. That is not an error, and inventing an empty one
      // would be worse than leaving it absent.
    }
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch {
    return false
  }
}

// The destructive variant: the project's data directory is replaced by the
// snapshot's, under the same project and the same resource ids.
//
// Resource ids, not just names, must match the snapshot exactly, and a
// project whose resource set has changed since is refused. Same ids is what
// makes this restore need none of the rewriting a restore into a new project
// does (rewriteConfig and renameDurableObjectDirs above): ports, container
// names, hostnames, queue tokens and every Durable Object storage key
// (uniqueKeyFor, packages/worker/src/worker.ts, embeds the resource id) are
// already the ones on disk. A resource added since the snapshot has no data
// in it and would be silently emptied; one deleted since has no row to
// restore it into. Guessing at either is how a restore quietly loses
// something, so the answer for a changed project is `--as`, beside it.
//
// Restores data, not configuration. Each row keeps its current config, which
// means its current image: a worker's or app's image is a timestamped tag
// (workerTag, packages/worker/src/worker.ts) that may since have been
// pruned, and the snapshot never captured the image itself. Code comes back
// by deploying it, data comes back from here.
//
// Order, and why:
//   1. Clone the snapshot into a staging directory beside the live one. The
//      project is still running and untouched; this is the slow step on a
//      filesystem without reflinks, and nothing is down while it runs.
//   2. Hold the project asleep and quiesce it, with the same guard and the
//      same fail-loudly rule a snapshot uses (quiesce above).
//   3. Rename the live directory aside, rename staging into its place. Both
//      renames are within projects/, so on one filesystem, so atomic, and the
//      pre-restore data is never copied or deleted on the way. If the second
//      rename fails, the first is undone.
//   4. Resume what was running, on the restored data.
//   5. Only when every resumed resource came back is the set-aside data
//      deleted. Until then it stays at <project>.pre-restore-<id> in
//      projects/, a name validateName (packages/core/src/names.ts) can never
//      produce for a project, and its path is returned to the caller.
//
// A daemon that dies between steps 3 and 5 leaves both directories on disk,
// which is the point: nothing in this sequence is the only copy of anything
// until the restore has been seen to work.
async function restoreInPlace(ctx: DaemonContext, found: FoundSnapshot, opts: RestoreOptions): Promise<RestoreResult> {
  const id = found.manifest.snapshotId
  const name = found.manifest.project.name
  const project = ctx.store.getProjectByName(name)
  if (project === null) {
    throw new HobbyError(
      'project_not_found',
      `project ${name} no longer exists, so there is nothing to restore over`,
      `restore it as a new project instead: hobby snapshot restore ${name} ${id} --as ${name}`
    )
  }
  // A released project's data directory belongs to the user's own compose
  // stack (ejectRoute with release, packages/cli/src/daemon/routes.ts), and
  // may be open in a postgres hobby did not start and cannot stop.
  if (project.releasedAt != null) {
    throw new HobbyError(
      'conflict',
      `project ${name} was released and is no longer managed by hobby`,
      `run \`hobby adopt ${name}\` first, after stopping the stack it was released to`
    )
  }

  const current = ctx.store.listResources(project.id)
  const snapshotIds = new Set(found.manifest.resources.map((entry) => entry.id))
  const currentIds = new Set(current.map((resource) => resource.id))
  const added = current.filter((resource) => !snapshotIds.has(resource.id)).map((resource) => resource.name)
  const removed = found.manifest.resources.filter((entry) => !currentIds.has(entry.id)).map((entry) => entry.name)
  if (added.length > 0 || removed.length > 0) {
    const changes = [
      ...(added.length > 0 ? [`added since: ${added.join(', ')}`] : []),
      ...(removed.length > 0 ? [`removed since: ${removed.join(', ')}`] : []),
    ]
    throw new HobbyError(
      'conflict',
      `project ${name} no longer has the resources snapshot ${id} was taken of (${changes.join('; ')})`,
      `restore it beside the original instead: hobby snapshot restore ${name} ${id} --as <new-name>`
    )
  }

  const liveDir = join(ctx.paths.projectsDir, name)
  const stagingDir = `${liveDir}.restoring-${id}`
  const asideDir = `${liveDir}.pre-restore-${id}`

  // Never deleted on our own initiative: a directory under this name is the
  // pre-restore data of an earlier in-place restore that did not finish, and
  // it may be the only copy of it.
  if (await pathExists(asideDir)) {
    throw new HobbyError(
      'conflict',
      `${asideDir} already exists`,
      'it holds the data an earlier in-place restore replaced and did not finish with. Move it somewhere safe, or delete it once you know nothing in it is needed'
    )
  }

  // A staging directory, by contrast, was never swapped in, so it is a
  // leftover from a restore that died during step 1 and holds nothing that
  // is not also in the snapshot. cloneTree refuses a destination that exists
  // (assertDestinationAbsent, packages/core/src/copy.ts), so it goes.
  await rm(stagingDir, { recursive: true, force: true })
  try {
    await cloneTree(join(found.dir, 'data'), stagingDir)
  } catch (err: unknown) {
    await rm(stagingDir, { recursive: true, force: true })
    throw err
  }

  const liveExisted = await pathExists(liveDir)
  // Same reason as takeSnapshot's `stopped`: filled by onStopped as quiesce
  // goes, so a quiesce that throws partway still resumes what it stopped.
  const stopped: ResourceId[] = []
  let restartFailures: string[] = []
  let release: (() => void) | null = null
  try {
    release = holdProjectAsleep(ctx, project.id, project.name)
    await quiesce(ctx, project, { ...opts.quiesce, onStopped: (resourceId) => stopped.push(resourceId) })

    if (liveExisted) {
      await rename(liveDir, asideDir)
    }
    try {
      await rename(stagingDir, liveDir)
    } catch (err: unknown) {
      if (liveExisted) {
        await rename(asideDir, liveDir)
      }
      throw err
    }
  } catch (err: unknown) {
    await rm(stagingDir, { recursive: true, force: true })
    throw err
  } finally {
    // resume never throws (its own comment above), which is what makes an
    // unguarded await safe in a finally that may be carrying an error.
    restartFailures = await resume(ctx, stopped)
    for (const failure of restartFailures) {
      console.error(`restore: ${failure}`)
    }
    release?.()
  }

  let preRestoreDir: string | null = liveExisted ? asideDir : null
  if (preRestoreDir !== null && restartFailures.length === 0) {
    try {
      await rm(preRestoreDir, { recursive: true, force: true })
      preRestoreDir = null
    } catch (err: unknown) {
      // On Linux a PGDATA is owned by the container's postgres uid, not by
      // whoever runs the daemon (createDefaultRemoveDataDir's comment,
      // packages/pg/src/postgres.ts), so this can fail with EACCES. The
      // restore itself has succeeded by now; the leftover is reported, not
      // turned into a failure.
      console.error(`restore: could not remove ${preRestoreDir}: ${errorMessage(err)}`)
    }
  }

  const resources = ctx.store.listResources(project.id)
  return { project, resources, restartFailures, preRestoreDir }
}

export async function restoreSnapshot(
  ctx: DaemonContext,
  id: string,
  opts: RestoreOptions
): Promise<RestoreResult> {
  const found = await findSnapshot(ctx, id)
  if (found === null) {
    throw new HobbyError('resource_not_found', `no snapshot ${id}`, 'run `hobby snapshot ls <project>`')
  }
  if (opts.inPlace === true) {
    return restoreInPlace(ctx, found, opts)
  }

  const target = opts.as ?? `${found.manifest.project.name}-restored`
  validateName(target)
  if (ctx.store.getProjectByName(target) !== null) {
    throw new HobbyError('name_taken', `a project named ${target} already exists`, 'pass a different --as name')
  }

  await cloneTree(join(found.dir, 'data'), join(ctx.paths.projectsDir, target))

  const project = ctx.store.createProject({
    name: target,
    sleepAfterSeconds: found.manifest.project.sleepAfterSeconds,
  })

  const resources: Resource[] = []
  for (const entry of found.manifest.resources) {
    // A postgres is the one kind whose start needs a container to exist
    // already (startPostgres calls runtime.start and nothing else), so it
    // gets a real container, created and left stopped, bound to the cloned
    // data directory above. Recording only a row was the first version of
    // this, and every wake of the restored database then failed with "No
    // such container". createPostgresFromClone's comment has the rest.
    if (entry.kind === 'postgres' && 'dataDir' in entry.config) {
      resources.push(
        await createPostgresFromClone(ctx, { project, name: entry.name, source: entry.config })
      )
      continue
    }

    // Created with the old config first so the row (and its id) exists before
    // the rewrite needs it: durableObjectUniqueKeyModifier is derived from the
    // new id, and the DO directory rename needs it too.
    const created = ctx.store.createResource({
      projectId: project.id,
      kind: entry.kind,
      name: entry.name,
      config: entry.config,
    })
    const rewritten = rewriteConfig(ctx, entry.config, target, entry.name, created.id)
    ctx.store.updateResourceConfig(created.id, rewritten)
    await renameDurableObjectDirs(ctx, target, entry, created.id)

    // Never `running`: nothing has been started, and a row claiming otherwise
    // is exactly the lie reconcile.ts exists to catch.
    // A queue is `running` from creation and forever, and an app or worker
    // that had never been deployed has no image to wake with: both keep the
    // state they were snapshotted in. Anything else rests asleep and is
    // created on its first wake (ensureCreated in the app and worker start
    // paths).
    const keepsState = entry.kind === 'queue' || entry.stateAtSnapshot === 'undeployed'
    ctx.store.setResourceState(created.id, keepsState ? entry.stateAtSnapshot : 'sleeping')

    const reloaded = ctx.store.getResource(created.id)
    if (reloaded !== null) {
      resources.push(reloaded)
    }
  }

  return { project, resources, restartFailures: [], preRestoreDir: null }
}
