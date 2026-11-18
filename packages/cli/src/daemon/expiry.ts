// Branch expiry: a branch may carry a time after which the daemon deletes it
// (Project.expiresAt). Neon's branch expiration, for the same reason: a
// branch made for one experiment is the kind of thing nobody remembers to
// remove, and on one box every forgotten branch is disk.
//
// The rules, each deliberate:
//
//   - Opt-in. Nothing expires unless `hobby branch --expires` or `hobby
//     expire` set it, and setting it is refused for any project that was not
//     created as a branch (parentExpiryRefusal below), so a project made with
//     `hobby new` can never be deleted by a timer.
//   - Never wakes anything. The sweep reads the store and the activity
//     tracker, and deleting a sleeping project stops nothing that is running.
//   - Skips, and logs, rather than forces. An expired branch is left alone,
//     to be tried again on the next sweep, while:
//       pinned    its operator said it must stay up, which outranks a timer
//                 set earlier; `hobby unpin` or `hobby expire --never`
//                 resolves the contradiction one way or the other
//       awake     any resource is running, starting or stopping, or has a
//                 proxied connection open. An unpinned branch goes to sleep
//                 on its own once idle, and is deleted on the sweep after
//       released  its data directory belongs to the user's compose stack
//       held      a snapshot or restore of it is in progress
//     A skip is logged once per branch and reason, not once per sweep.
//   - One log line per deletion, naming the branch and when it expired.
//
// Deletion is deleteProject (routes.ts), the code `hobby rm` runs, under a
// holdProjectAsleep so that a wake landing between the at-rest check and the
// teardown waits for the teardown instead of racing it.

import { HobbyError, type Project, type Resource } from '@hobby.sh/core'
import { createStopSignal } from '@hobby.sh/core'
import { holdProjectAsleep, type DaemonContext } from './context.js'

export type ExpirySkipReason = 'pinned' | 'awake' | 'released' | 'held'

export interface SweepResult {
  deleted: string[]
  skipped: Array<{ name: string; reason: ExpirySkipReason }>
  failed: Array<{ name: string; error: string }>
}

export interface SweepOptions {
  // How a project is deleted. Production passes deleteProject from
  // routes.ts; kept as a parameter so this file does not import the route
  // module, and so a test can observe the call.
  remove: (ctx: DaemonContext, name: string) => Promise<void>
  // Which (project id, reason) skips have already been logged, so a pinned
  // expired branch is mentioned once, not every minute. Owned by the
  // sweeper loop; a one-off sweep may omit it and log every skip.
  logged?: Map<string, ExpirySkipReason>
  log?: (line: string) => void
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

// The longest expiry accepted, so a typo of years is a usage error rather
// than a date nobody meant. Ten years is far past any experiment.
export const MAX_EXPIRY_SECONDS = 10 * 365 * 86400

// The one shape an expiry takes on the wire: a positive whole number of
// seconds from now (resolved against the daemon's clock, not the caller's,
// since ADR 0018's remote CLI may run on a machine whose clock differs), or
// null for "never". `undefined` is a field that was not sent.
export function parseExpiresInSeconds(raw: unknown, route: string): number | null | undefined {
  if (raw === undefined) return undefined
  if (raw === null) return null
  if (typeof raw === 'number' && Number.isInteger(raw) && raw > 0 && raw <= MAX_EXPIRY_SECONDS) return raw
  throw new HobbyError(
    'usage',
    `expiresInSeconds must be a whole number of seconds between 1 and ${MAX_EXPIRY_SECONDS}, or null for never`,
    `${route} expects { "expiresInSeconds": number | null }`
  )
}

// Expiry is for branches only. Null when the project may carry one.
export function parentExpiryRefusal(project: Project): HobbyError | null {
  if (project.parentId !== null) {
    return null
  }
  return new HobbyError(
    'usage',
    `project ${project.name} was not created as a branch, so it cannot expire`,
    'only projects made with `hobby branch` can be given an expiry; `hobby rm` removes any project by hand'
  )
}

// What `hobby expire` does: set or clear one branch's expiry.
export function setBranchExpiry(ctx: DaemonContext, name: string, expiresInSeconds: number | null, nowMs: number): Project {
  const project = ctx.store.getProjectByName(name)
  if (project === null) {
    throw new HobbyError('project_not_found', `no project named ${name}`, 'run `hobby ls` to see what exists')
  }
  const refusal = parentExpiryRefusal(project)
  if (refusal !== null) {
    throw refusal
  }
  ctx.store.setProjectExpiresAt(project.id, expiresInSeconds === null ? null : new Date(nowMs + expiresInSeconds * 1000))
  return ctx.store.getProject(project.id) ?? project
}

// At rest means nothing to stop: every resource asleep (or never deployed),
// no proxied connection open, and no queue counted, since a queue is
// `running` from creation and holds no process (the hibernator's own
// exemption, hibernator.ts).
function isAwake(ctx: DaemonContext, resources: Resource[]): boolean {
  return resources.some((resource) => {
    if (ctx.activity.count(resource.id) > 0) {
      return true
    }
    if (resource.kind === 'queue') {
      return false
    }
    return resource.state !== 'sleeping' && resource.state !== 'undeployed'
  })
}

function skipReason(ctx: DaemonContext, project: Project): ExpirySkipReason | null {
  if (project.releasedAt !== null) return 'released'
  if (project.sleepAfterSeconds === null) return 'pinned'
  if (isAwake(ctx, ctx.store.listResources(project.id))) return 'awake'
  return null
}

const SKIP_DETAIL: Record<ExpirySkipReason, string> = {
  pinned: 'it is pinned; `hobby unpin` it to let it expire, or `hobby expire <branch> --never` to keep it',
  awake: 'it is awake; it will be deleted once it has gone to sleep',
  released: 'it was released and is no longer managed by hobby',
  held: 'a snapshot or restore of it is in progress',
}

// One pass. Every expired branch is either deleted, skipped with a reason,
// or reported as failed; one failure never stops the rest of the pass.
export async function sweepExpiredBranches(ctx: DaemonContext, nowMs: number, opts: SweepOptions): Promise<SweepResult> {
  const log = opts.log ?? ((line: string): void => console.error(line))
  const result: SweepResult = { deleted: [], skipped: [], failed: [] }
  const expired = ctx.store
    .listProjects()
    .filter((project) => project.parentId !== null && project.expiresAt !== null && project.expiresAt.getTime() <= nowMs)

  const skip = (project: Project, reason: ExpirySkipReason): void => {
    result.skipped.push({ name: project.name, reason })
    if (opts.logged?.get(project.id) !== reason) {
      opts.logged?.set(project.id, reason)
      log(`expiry: ${project.name} expired at ${project.expiresAt?.toISOString()} and was not deleted: ${SKIP_DETAIL[reason]}`)
    }
  }

  for (const project of expired) {
    const reason = skipReason(ctx, project)
    if (reason !== null) {
      skip(project, reason)
      continue
    }

    let release: () => void
    try {
      release = holdProjectAsleep(ctx, project.id, project.name, 'the removal')
    } catch {
      skip(project, 'held')
      continue
    }
    try {
      // Re-checked under the hold: a wake that started before the hold was
      // taken is not fenced by it, and shows here as a resource that is no
      // longer asleep.
      const fresh = ctx.store.getProject(project.id)
      if (fresh === null) {
        continue
      }
      const again = skipReason(ctx, fresh)
      if (again !== null) {
        skip(fresh, again)
        continue
      }
      try {
        await opts.remove(ctx, fresh.name)
        opts.logged?.delete(fresh.id)
        result.deleted.push(fresh.name)
        log(`expiry: deleted branch ${fresh.name} (expired at ${fresh.expiresAt?.toISOString()})`)
      } catch (err: unknown) {
        result.failed.push({ name: fresh.name, error: errorMessage(err) })
        log(`expiry: failed to delete expired branch ${fresh.name}: ${errorMessage(err)}`)
      }
    } finally {
      release()
    }
  }
  return result
}

export interface StartExpirySweeperOptions extends SweepOptions {
  intervalMs: number
  now?: () => number
  sleepFor?: (ms: number) => Promise<void>
}

function defaultSleepFor(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    // The same reasoning as the hibernator's: never the reason the process
    // stays alive.
    timer.unref?.()
  })
}

// The loop, shaped exactly like startHibernator's: a stop() that interrupts
// the wait and drains a pass in flight, so shutdown never races a deletion.
export function startExpirySweeper(ctx: DaemonContext, opts: StartExpirySweeperOptions): { stop(): Promise<void> } {
  const now = opts.now ?? Date.now
  const sleepFor = opts.sleepFor ?? defaultSleepFor
  const logged = opts.logged ?? new Map<string, ExpirySkipReason>()
  const stopSignal = createStopSignal()
  let stopped = false
  let current: Promise<void> | null = null

  const loop = (async (): Promise<void> => {
    while (!stopped) {
      const sleptFully = await stopSignal.wait(sleepFor(opts.intervalMs))
      if (!sleptFully || stopped) {
        break
      }
      current = sweepExpiredBranches(ctx, now(), { ...opts, logged })
        .then(() => undefined)
        .catch((err: unknown) => {
          console.error(`expiry: sweep failed: ${errorMessage(err)}`)
        })
      await current
      current = null
    }
  })()
  loop.catch((err: unknown) => {
    console.error(`expiry: loop exited unexpectedly: ${errorMessage(err)}`)
  })

  return {
    stop(): Promise<void> {
      stopped = true
      stopSignal.stop()
      return current ?? Promise.resolve()
    },
  }
}
