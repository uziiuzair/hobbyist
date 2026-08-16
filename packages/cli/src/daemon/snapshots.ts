// Whole-project snapshots: quiesce, clone, manifest. ADR 0016.
//
// The unit is the project rather than the resource because a project holds a
// postgres, the workers with Durable Object state, and the queue holding
// undelivered messages about all of it. Backing one up without the others
// produces a copy that is internally inconsistent in a way nobody notices until
// they restore it.

import { join } from 'node:path'
import { guardFor, HobbyError, type ActivityGuardResult, type Paths, type Project, type Resource, type ResourceId } from '@hobby.sh/core'
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
