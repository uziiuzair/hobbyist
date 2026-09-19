// Branching a project: a new project whose postgres resources start from a
// clone of the source's data directories. Phase 1.5, issue #19.
//
// The mechanism is the one docs/branching/research/2026-08-07-cloning-a-
// stopped-data-directory.md proposed, not ADR 0005's `CREATE DATABASE ...
// STRATEGY = FILE_COPY`: a cleanly stopped PGDATA is internally consistent,
// so it can be cloned at the filesystem level (cloneTree, packages/core/src/
// copy.ts, the same primitive snapshots use) and started as a new instance.
// That needs no SQL and no particular Postgres version, and on a platform
// whose resting state is asleep, most sources are already stopped.
//
// An awake source is quiesced first, through the exact quiesce and resume
// snapshots use (packages/cli/src/daemon/snapshots.ts), and the pause is
// measured and reported. What is deliberately NOT done is clone a running
// data directory and rely on PostgreSQL 18 to make that safe: the root
// CLAUDE.md says that path must be benchmarked before it is relied on, and
// it has not been. A reflink copy of a running PGDATA is not atomic across
// files, so the result would be a torn directory that may well start, and
// would be wrong in a way nobody sees until much later.
//
// Scope, per the issue: create and destroy only. Destroying a branch is the
// existing `hobby rm <branch>`, because a branch is an ordinary project the
// moment this returns. There is no parent link recorded anywhere, so there is
// nothing for merging, diffing or "what happens to children" to hang off, and
// removing the source never touches a branch (each owns its own copy).

import { existsSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import {
  cloneTree,
  HobbyError,
  validateName,
  type CloneMechanism,
  type CloneResult,
  type PostgresResource,
  type Project,
  type Resource,
  type ResourceId,
} from '@hobby.sh/core'
import { createPostgresFromClone } from '@hobby.sh/pg'
import type { DaemonContext } from './context.js'
import { quiesce, resume, type QuiesceOptions } from './snapshots.js'

export interface BranchOptions {
  // The pinned-project guard's explicit override. See assertPauseAllowed.
  allowPause?: boolean
  // Forwarded to quiesce, so a test can supply a guard instead of the real
  // pg_stat_activity check and skip the real two-second retry wait.
  quiesce?: QuiesceOptions
  // Test seams. Production uses cloneTree and Date.now.
  clone?: (src: string, dst: string) => Promise<CloneResult>
  now?: () => number
}

export interface BranchResult {
  project: Project
  resources: Resource[]
  // 'copy' if any resource degraded to a byte copy (ext4), since one slow
  // resource is enough to make the whole branch a full copy's cost on disk.
  clone: CloneMechanism
  // The names of the source's resources that were stopped for the clone and
  // started again afterwards. Empty for a source that was already asleep.
  paused: string[]
  // Wall time from the start of quiescing to the end of resuming, so an
  // upper bound: it includes quiesce's idle check, during which the source
  // was still serving. Null when nothing was paused.
  pausedMs: number | null
  // Source resources that did not come back after the clone. The branch is
  // still good (the clone was complete before resume began), so these are
  // reported rather than thrown, the same split takeSnapshot makes. The
  // store already records each of them as `failed`, because startPostgres
  // does that itself on any failed start.
  resumeFailures: string[]
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function isPostgres(resource: Resource): resource is PostgresResource {
  return resource.kind === 'postgres'
}

// A pinned project (sleepAfterSeconds === null, the same test the
// hibernator's tick uses before anything else, packages/cli/src/daemon/
// hibernator.ts) is one its operator has said must stay awake, and the
// daemon honours that even across its own restart (resourcesToStopOnShutdown,
// packages/cli/src/daemon/server.ts, leaves pinned projects running).
// Branching one with anything running would stop it for the length of the
// clone, which on ext4 is the length of a full byte copy. That is exactly the
// interruption pinning exists to prevent, so it takes an explicit yes rather
// than happening as a side effect of an unrelated command.
//
// Only a pinned project with something RUNNING is refused. A pinned project
// that is fully asleep (stopped by hand with `hobby sleep`) pauses nothing,
// and an unpinned one has already agreed to be stopped whenever it goes
// idle, so neither needs the flag.
function assertPauseAllowed(source: Project, running: PostgresResource[], allowPause: boolean): void {
  if (source.sleepAfterSeconds !== null || running.length === 0 || allowPause) {
    return
  }
  throw new HobbyError(
    'conflict',
    `project ${source.name} is pinned awake, and branching it would stop ${running.map((r) => r.name).join(', ')} for the length of the clone`,
    'pass --allow-pause (API: "allowPause": true) to accept the pause, or `hobby sleep` it first'
  )
}

// Every check that can refuse the request, run before anything is written
// or stopped. Returns the source and its postgres resources.
function preflight(ctx: DaemonContext, sourceName: string, targetName: string, allowPause: boolean): {
  source: Project
  resources: PostgresResource[]
} {
  validateName(targetName)

  const source = ctx.store.getProjectByName(sourceName)
  if (source === null) {
    throw new HobbyError('project_not_found', `no project named ${sourceName}`, 'run `hobby ls` to see what exists')
  }

  // A released project's data directory belongs to whatever the user started
  // from the compose file eject gave them, and may be open in a Postgres this
  // daemon does not know about. Cloning it would be cloning a live directory
  // with nothing able to quiesce it.
  if (source.releasedAt !== null) {
    throw new HobbyError(
      'conflict',
      `project ${sourceName} was released and is no longer managed by hobby`,
      `run \`hobby adopt ${sourceName}\` first, after stopping the stack you started from its compose file`
    )
  }

  if (ctx.store.getProjectByName(targetName) !== null) {
    throw new HobbyError('name_taken', `a project named ${targetName} already exists`, 'pick a different name for the branch')
  }

  // Nothing in the store owns this path (the check above), so whatever is
  // there was left by something else: a project removed while its data
  // directory could not be, or a directory someone made by hand. Refusing
  // is the only safe answer. Cloning into it would fail anyway (cloneTree
  // refuses an existing destination), but the cleanup after that failure
  // would then remove a directory this call never created. Checking here,
  // before anything is written, is what makes "everything under this path
  // is ours" true for the cleanup in discardBranch.
  const targetDir = join(ctx.paths.projectsDir, targetName)
  if (existsSync(targetDir)) {
    throw new HobbyError(
      'conflict',
      `${targetDir} already exists, but no project named ${targetName} does`,
      'it is left over from something else; move it aside or pick a different name'
    )
  }

  const all = ctx.store.listResources(source.id)
  if (all.length === 0) {
    throw new HobbyError('usage', `project ${sourceName} has no resources, so there is nothing to branch`, 'use `hobby new <name> --empty` for an empty project')
  }

  // Postgres only, for now, and refused rather than skipped. Every other kind
  // carries state that is keyed to the resource's identity rather than its
  // directory: a worker's Durable Object storage is named after its resource
  // id (worker.ts's uniqueKeyFor), a queue's consumer binding and a worker's
  // queue token are ids and secrets that must not be shared with the source,
  // and an app or worker hostname is a routed Caddy name. restoreSnapshot's
  // rewriteConfig and renameDurableObjectDirs (snapshots.ts) show how large
  // that rewrite surface is, and each missed field there is a silent
  // failure. Quietly leaving those resources out would instead produce a
  // branch that looks complete and is not. A branch that refuses is the
  // honest first version; one that handles them is a later, separate change.
  const other = all.filter((resource) => resource.kind !== 'postgres')
  if (other.length > 0) {
    throw new HobbyError(
      'usage',
      `branching copies postgres resources only, and ${sourceName} also holds ${other.map((r) => `${r.name} (${r.kind})`).join(', ')}`,
      'branching projects with apps, workers or queues is not supported yet'
    )
  }
  const resources = all.filter(isPostgres)

  // Only the two resting states are safe to reason about. `starting` and
  // `stopping` are a container mid-transition, which is neither a clean stop
  // to clone nor a running instance quiesce knows how to stop (it only
  // stops `running`), and `failed` means the store does not know what the
  // container is doing. Refusing is cheap: each of these resolves on its own
  // in seconds, or with a `hobby wake`/`hobby sleep`.
  const unsettled = resources.filter((resource) => resource.state !== 'running' && resource.state !== 'sleeping')
  if (unsettled.length > 0) {
    throw new HobbyError(
      'conflict',
      `cannot branch ${sourceName} while ${unsettled.map((r) => `${r.name} is ${r.state}`).join(', ')}`,
      'retry once it is running or asleep'
    )
  }

  assertPauseAllowed(
    source,
    resources.filter((resource) => resource.state === 'running'),
    allowPause
  )

  return { source, resources }
}

interface RestMark {
  lastActiveAt: number | null
}

// Called twice around the clone: once to prove every source container is
// really stopped before a byte is copied, and once to prove nothing woke it
// while the copy ran. The store's `sleeping` is not trusted on its own for
// the first question, because the store can be wrong about a container
// (reconcile.ts exists for exactly that), and a clone of a data directory a
// live Postgres is writing is the one failure here that nothing downstream
// would catch.
//
// The second question matters because nothing stops a wake during a clone:
// the proxy wakes on connect, and a clone on ext4 can run for minutes. A
// wake that finished bumps lastActiveAt (startPostgres touches it on every
// successful start, and nothing else writes it for a postgres), and one
// still in flight shows as a running container or a non-sleeping state.
// Either way the copy may be torn, so the whole branch is discarded.
async function assertAtRest(ctx: DaemonContext, resources: PostgresResource[], marks?: Map<ResourceId, RestMark>): Promise<Map<ResourceId, RestMark>> {
  const next = new Map<ResourceId, RestMark>()
  for (const original of resources) {
    const current = ctx.store.getResource(original.id)
    const status = await ctx.runtime.inspect(original.config.containerName)
    const lastActiveAt = current?.lastActiveAt?.getTime() ?? null
    const before = marks?.get(original.id)
    const woke = before !== undefined && before.lastActiveAt !== lastActiveAt
    if (current === null || current.state !== 'sleeping' || status.running || woke) {
      throw new HobbyError(
        'conflict',
        marks === undefined
          ? `${original.name} is not stopped, so its data directory cannot be cloned safely`
          : `${original.name} was woken while it was being cloned, so the copy may be torn and was discarded`,
        'retry the branch; nothing was created'
      )
    }
    next.set(original.id, { lastActiveAt })
  }
  return next
}

// Undoes a branch that did not finish: the containers and network made for
// it, the rows, and the cloned files. Everything here was created by this
// call and nothing else, which preflight's directory check and the early
// createProject (which reserves the name) are what guarantee.
//
// The clone's files are owned by the daemon's own user (cloneTree copies as
// that user, and no container has ever started on them to chown them), so a
// plain rm is enough here, unlike destroyPostgres's container-based removal.
async function discardBranch(ctx: DaemonContext, project: Project): Promise<string[]> {
  const failures: string[] = []
  for (const resource of ctx.store.listResources(project.id)) {
    try {
      await ctx.runtime.remove(resource.config.containerName)
    } catch (err) {
      failures.push(`remove container ${resource.config.containerName}: ${errorMessage(err)}`)
    }
  }
  try {
    await ctx.runtime.removeNetwork(project.networkName)
  } catch (err) {
    failures.push(`remove network ${project.networkName}: ${errorMessage(err)}`)
  }
  ctx.store.deleteProject(project.id)
  const dir = join(ctx.paths.projectsDir, project.name)
  try {
    await rm(dir, { recursive: true, force: true })
  } catch (err) {
    failures.push(`remove ${dir}: ${errorMessage(err)}`)
  }
  return failures
}

export async function branchProject(
  ctx: DaemonContext,
  sourceName: string,
  targetName: string,
  opts: BranchOptions = {}
): Promise<BranchResult> {
  const now = opts.now ?? Date.now
  const clone = opts.clone ?? cloneTree
  const { source, resources } = preflight(ctx, sourceName, targetName, opts.allowPause === true)

  // Created first, before anything is cloned, so the name is reserved for the
  // whole of what may be a minutes-long copy on ext4. Created last, a
  // concurrent `hobby new <same name>` could land in the middle, and this
  // call's own failure cleanup would then remove that project's directory.
  //
  // The box-wide default, never the source's policy: a branch is for
  // experiments, and inheriting a pin would keep a throwaway copy awake
  // forever. This is the same value `hobby new` without --pin gets
  // (createProjectRoute, routes.ts).
  const project = ctx.store.createProject({ name: targetName, sleepAfterSeconds: ctx.config.sleepAfterSeconds })

  const running = resources.filter((resource) => resource.state === 'running')
  const stopped: ResourceId[] = []
  const mechanisms: CloneMechanism[] = []
  let pausedMs: number | null = null
  let resumeFailures: string[] = []

  try {
    const pauseStartedAt = running.length > 0 ? now() : null
    try {
      if (running.length > 0) {
        await quiesce(ctx, source, { ...opts.quiesce, onStopped: (id) => stopped.push(id) })
      }
      const marks = await assertAtRest(ctx, resources)
      for (const resource of resources) {
        const result = await clone(resource.config.dataDir, ctx.paths.resourcePath(targetName, resource.name, 'pgdata'))
        mechanisms.push(result.mechanism)
      }
      await assertAtRest(ctx, resources, marks)
    } finally {
      // Resumed before the branch's own rows and containers are made, so the
      // source's pause is the clone and nothing more. Safe to await here for
      // the same reason takeSnapshot's finally is: resume collects start
      // failures rather than throwing them.
      resumeFailures = await resume(ctx, stopped)
      // Logged as well as returned: when the clone itself failed, the error
      // propagating from the try above replaces the return value, and a
      // source that did not come back must not go unmentioned.
      for (const failure of resumeFailures) {
        console.error(`branch: ${failure}`)
      }
      if (pauseStartedAt !== null) {
        pausedMs = now() - pauseStartedAt
      }
    }

    const created: Resource[] = []
    for (const resource of resources) {
      created.push(await createPostgresFromClone(ctx, { project, name: resource.name, source: resource.config }))
    }

    return {
      project,
      resources: created,
      clone: mechanisms.includes('copy') ? 'copy' : 'reflink',
      paused: running.map((resource) => resource.name),
      pausedMs,
      resumeFailures,
    }
  } catch (err: unknown) {
    const leftovers = await discardBranch(ctx, project)
    if (leftovers.length > 0) {
      throw new HobbyError(
        'internal',
        `branching ${sourceName} failed (${errorMessage(err)}), and cleaning up the partial branch also failed: ${leftovers.join('; ')}`,
        `the ${targetName} project record is gone, but a container, network or directory may remain and need removing by hand`
      )
    }
    throw err
  }
}
