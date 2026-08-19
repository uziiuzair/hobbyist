// Whole-project snapshots: quiesce, clone, manifest. ADR 0016.
//
// The unit is the project rather than the resource because a project holds a
// postgres, the workers with Durable Object state, and the queue holding
// undelivered messages about all of it. Backing one up without the others
// produces a copy that is internally inconsistent in a way nobody notices until
// they restore it.

import { randomUUID } from 'node:crypto'
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
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
import type { DaemonContext } from './context.js'

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
export async function findSnapshot(ctx: DaemonContext, id: string): Promise<FoundSnapshot | null> {
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
    throw new HobbyError('resource_not_found', `no snapshot ${id}`, 'run `hobby snapshot list <project>`')
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
}

export interface RestoreResult {
  project: Project
  resources: Resource[]
}

// Ports the daemon hands out, so a restored copy must never inherit them: the
// original may still be holding both. The range mirrors what createResource
// paths already use; see store.allocatePort.
const PORT_FROM = 15000
const PORT_TO = 19999

// Every field below either names the old project, embeds the old resource id,
// or is unique per machine. Each one is a SILENT failure if missed: the restore
// succeeds and the copy quietly shares something with the original. The
// sharpest is dataDir, where the copy would write into the original's PGDATA.
function rewriteConfig(
  ctx: DaemonContext,
  config: ResourceConfig,
  projectName: string,
  resourceName: string,
  newId: string
): ResourceConfig {
  const base = {
    ...config,
    containerName: `hobby-${projectName}-${resourceName}`,
    hostPort: ctx.store.allocatePort(PORT_FROM, PORT_TO),
  }

  if ('dataDir' in base) {
    return { ...base, dataDir: ctx.paths.resourcePath(projectName, resourceName, 'pgdata') }
  }

  if ('queueToken' in base) {
    return {
      ...base,
      controlPort: ctx.store.allocatePort(PORT_FROM, PORT_TO, [base.hostPort]),
      queueToken: randomUUID(),
      hostname: `${resourceName}.${projectName}.${ctx.config.domain}`,
      durableObjectUniqueKeyModifier: newId,
    }
  }

  if ('hostname' in base) {
    return { ...base, hostname: `${resourceName}.${projectName}.${ctx.config.domain}` }
  }

  return base
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

// Replaced in full by Task 7, which restores over an existing project rather
// than into a new one. Landed as a throwing stub here so restoreSnapshot's
// `inPlace` branch has somewhere to go without pretending in-place restore
// works before it does.
async function restoreInPlace(ctx: DaemonContext, found: FoundSnapshot): Promise<RestoreResult> {
  throw new HobbyError('usage', 'in-place restore is not implemented yet', 'restore into a new project with --as')
}

export async function restoreSnapshot(
  ctx: DaemonContext,
  id: string,
  opts: RestoreOptions
): Promise<RestoreResult> {
  const found = await findSnapshot(ctx, id)
  if (found === null) {
    throw new HobbyError('resource_not_found', `no snapshot ${id}`, 'run `hobby snapshot list <project>`')
  }
  if (opts.inPlace === true) {
    return restoreInPlace(ctx, found)
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
    ctx.store.setResourceState(created.id, entry.kind === 'queue' ? entry.stateAtSnapshot : 'sleeping')

    const reloaded = ctx.store.getResource(created.id)
    if (reloaded !== null) {
      resources.push(reloaded)
    }
  }

  return { project, resources }
}
