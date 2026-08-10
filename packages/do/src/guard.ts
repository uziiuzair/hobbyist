// The pre-sleep guard for a worker that owns Durable Objects.
//
// This is the function `packages/worker/src/kind.ts` marked a hole for: the
// `worker` handler has nothing in-flight to protect at the HTTP level, but it
// does have alarms, and a stopped container cannot fire one. Core calls this
// exactly once immediately before the irreversible stop
// (`guardFor` in packages/core/src/kinds.ts), which is the right place: any
// earlier and the answer is stale by the time it is acted on.
//
// It reads files and returns a verdict. It never stops, starts, or writes
// anything.

import {
  type ActivityGuardResult,
  type KindContext,
  type Resource,
} from '@hobby.sh/core'
import { nextAlarmAtMs } from './alarms.js'
import { namespaceDirs } from './catalog.js'
import { isAlarmWithin } from './sleep.js'

// Three hibernation ticks at the daemon's 10 second interval
// (HIBERNATION_TICK_MS in packages/cli/src/daemon/server.ts).
//
// The floor is one tick: with a grace shorter than the interval, an alarm due
// in five seconds gets slept through and woken again moments later by the
// mirror, paying a full cold start to save five seconds of idle memory. Three
// is a guess at where "about to be needed" starts, and is the number
// docs/durable-objects/CLAUDE.md carries as an open question rather than a
// settled one.
export const DEFAULT_WAKE_GRACE_SECONDS = 30

export interface AlarmGuardOptions {
  wakeGraceSeconds?: number
  // Test seam, same pattern as StartHibernatorOptions.now. Production omits it.
  now?: () => number
}

// 'active' when any of this worker's namespaces has an alarm due within the
// grace window, or already overdue. See isAlarmWithin for why overdue counts
// here and not in shouldSleepNamespace.
//
// 'unreachable' when the schedule could not be read. Core's own comment is
// explicit that this is not 'idle': "A guard that could not answer must never
// be read as permission to stop." A namespace whose _cf_ALARM table has gone
// missing is exactly that case, and treating it as idle would sleep a worker
// whose alarms we can no longer see.
export async function durableObjectAlarmGuard(
  ctx: KindContext,
  resource: Resource,
  opts: AlarmGuardOptions = {}
): Promise<ActivityGuardResult> {
  const now = opts.now ?? Date.now
  const graceSeconds = opts.wakeGraceSeconds ?? DEFAULT_WAKE_GRACE_SECONDS

  // The path helper takes names, not ids, and only the store knows the
  // project's name. A resource whose project has vanished is not a resource
  // this guard can answer about.
  const project = ctx.store.getProject(resource.projectId)
  if (project == null) {
    return 'unreachable'
  }

  let dirs: string[]
  try {
    dirs = namespaceDirs(ctx.paths.resourcePath(project.name, resource.name, 'do'))
  } catch {
    return 'unreachable'
  }

  const nowMs = now()
  for (const dir of dirs) {
    let deadline: number | null
    try {
      deadline = nextAlarmAtMs(dir)
    } catch {
      return 'unreachable'
    }
    if (isAlarmWithin(deadline, nowMs, graceSeconds)) {
      return 'active'
    }
  }

  // No namespaces, or every deadline comfortably ahead. A worker that declares
  // no Durable Object classes reaches here with an empty list and sleeps
  // exactly as it did before this guard existed.
  return 'idle'
}
