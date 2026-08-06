// The sleep half of the pair the proxy completes (see docs/hibernation/CLAUDE.md).
// shouldSleep is the pure policy: no timers, no I/O, no Postgres, no Docker,
// so the whole decision table is exhaustively testable without any of them.
// Everything impure, the interval, reading the proxy's ActivityTracker, the
// one pg_stat_activity guard, calling stopPostgres, lives in startHibernator,
// the only place in this file that touches real time or a real resource.

import type { Resource, ResourceState } from '@hobby.sh/core'
import { checkActiveQuery, stopPostgres, type ActivityGuardResult } from '@hobby.sh/pg'
import type { DaemonContext } from './context.js'

export interface ShouldSleepInput {
  state: ResourceState
  connections: number
  idleSeconds: number | null
  sleepAfterSeconds: number | null
  hasActiveQuery: boolean
}

// Pure: every value it needs is handed in, nothing here reaches for the
// clock, the store, Postgres or Docker. That is what makes the full truth
// table testable in a plain loop with no timer and no fake anything.
//
// True only when every one of these holds:
//   - sleepAfterSeconds is not null (a null threshold means pinned, checked
//     first since it is the cheapest possible rejection)
//   - state is exactly 'running' (never a resource mid-transition or broken)
//   - connections is exactly zero
//   - idleSeconds is known (not null) and at or above the threshold
//   - hasActiveQuery is false (the pg_stat_activity guard found nothing, and
//     was reachable enough to say so; see checkActiveQuery's ActivityGuardResult)
export function shouldSleep(input: ShouldSleepInput): boolean {
  if (input.sleepAfterSeconds === null) {
    return false
  }
  if (input.state !== 'running') {
    return false
  }
  if (input.connections !== 0) {
    return false
  }
  if (input.idleSeconds === null) {
    return false
  }
  if (input.idleSeconds < input.sleepAfterSeconds) {
    return false
  }
  if (input.hasActiveQuery) {
    return false
  }
  return true
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export interface StartHibernatorOptions {
  intervalMs: number
  // Injectable seams, same pattern as readiness.ts's waitReady: the tick
  // loop is testable against a fake clock and a fake sleep with zero real
  // time passing. Production callers omit both and get Date.now and a real
  // setTimeout.
  now?: () => number
  sleepFor?: (ms: number) => Promise<void>
  // Test seam for the one real Postgres touch this file makes. Defaults to
  // @hobby.sh/pg's checkActiveQuery against the resource's own config.
  // Additive and optional, same reasoning as PgDeps.probeFactory: production
  // never sets this.
  checkActiveQuery?: (resource: Resource) => Promise<ActivityGuardResult>
}

function defaultSleepFor(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    // Never let this background loop's own wait be the reason the process
    // stays alive: the daemon's real shutdown path exits explicitly
    // (server.ts's signal handlers), and unref keeps a lingering default
    // timer from blocking a plain `close()` call (in tests, e.g.) that
    // never reaches that exit.
    timer.unref?.()
  })
}

// One pass over every resource this daemon knows about. Cheap, in-memory
// checks run first and short-circuit before the one expensive step (the
// pg_stat_activity round trip), which is the whole point of carrying the
// pin check and the connection/idle checks ahead of it rather than folding
// everything into shouldSleep's inputs unconditionally.
async function tick(
  ctx: DaemonContext,
  now: () => number,
  guard: (resource: Resource) => Promise<ActivityGuardResult>
): Promise<void> {
  for (const resource of ctx.store.listResources()) {
    // Never touch a resource mid-transition (creating/starting/stopping) or
    // broken (failed): both are worse to interfere with than to leave alone.
    if (resource.state !== 'running') {
      continue
    }

    const project = ctx.store.getProject(resource.projectId)
    const sleepAfterSeconds = project?.sleepAfterSeconds ?? null
    // Pinned. Checked first, before anything else, including the cheap
    // in-memory activity lookups below: there is nothing left to decide.
    if (sleepAfterSeconds === null) {
      continue
    }

    const connections = ctx.activity.count(resource.id)
    if (connections !== 0) {
      continue
    }

    const idleSeconds = ctx.activity.idleSeconds(resource.id, now())
    if (idleSeconds === null || idleSeconds < sleepAfterSeconds) {
      continue
    }

    // Every cheap check passed: this resource is a real sleep candidate.
    // Only now does the one pg_stat_activity round trip happen, exactly
    // once, immediately before a possible stop.
    let guardResult: ActivityGuardResult
    try {
      guardResult = await guard(resource)
    } catch (err) {
      // The guard call itself is documented to resolve 'unreachable' rather
      // than throw (see checkActiveQuery), but a custom test seam could
      // still throw; treat that identically to 'unreachable' rather than
      // letting one resource's guard failure abort the whole tick.
      console.error(`hibernator: activity guard failed for resource ${resource.id}: ${errorMessage(err)}`)
      guardResult = 'unreachable'
    }
    const hasActiveQuery = guardResult !== 'idle'

    const sleep = shouldSleep({
      state: resource.state,
      connections,
      idleSeconds,
      sleepAfterSeconds,
      hasActiveQuery,
    })
    if (!sleep) {
      continue
    }

    try {
      await stopPostgres(ctx, resource)
    } catch (err) {
      console.error(`hibernator: failed to sleep resource ${resource.id}: ${errorMessage(err)}`)
    }
  }
}

export function startHibernator(ctx: DaemonContext, opts: StartHibernatorOptions): { stop(): void } {
  const now = opts.now ?? Date.now
  const sleepFor = opts.sleepFor ?? defaultSleepFor
  const guard = opts.checkActiveQuery ?? ((resource: Resource): Promise<ActivityGuardResult> => checkActiveQuery(resource.config))

  let stopped = false
  let resolveStopSignal: () => void = () => {}
  const stopSignal = new Promise<void>((resolve) => {
    resolveStopSignal = resolve
  })

  // Races the interval wait against stop(): a stop() call must interrupt a
  // real, possibly long, wait immediately rather than waiting the current
  // interval out. Returns true if the interval elapsed normally, false if
  // stop() won the race.
  async function waitOrStop(ms: number): Promise<boolean> {
    let sleptFully = true
    await Promise.race([
      sleepFor(ms),
      stopSignal.then(() => {
        sleptFully = false
      }),
    ])
    return sleptFully
  }

  const loop = (async (): Promise<void> => {
    while (!stopped) {
      const sleptFully = await waitOrStop(opts.intervalMs)
      if (!sleptFully || stopped) {
        break
      }
      try {
        await tick(ctx, now, guard)
      } catch (err) {
        // A whole-tick failure (a HobbyError('ambiguous_target') would never
        // originate here, but a bug elsewhere could) must not kill the loop:
        // the next interval should still get a chance to try again.
        console.error(`hibernator: tick failed: ${errorMessage(err)}`)
      }
    }
  })()

  // Safety net: everything inside the loop already catches its own errors,
  // so this only guards against something escaping that catch, which would
  // otherwise be an unhandled rejection rather than just a logged failure.
  loop.catch((err: unknown) => {
    console.error(`hibernator: loop exited unexpectedly: ${errorMessage(err)}`)
  })

  return {
    stop(): void {
      if (stopped) {
        return
      }
      stopped = true
      resolveStopSignal()
    },
  }
}
