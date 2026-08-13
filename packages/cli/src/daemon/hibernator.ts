// The sleep half of the pair the proxy completes (see docs/hibernation/CLAUDE.md).
// shouldSleep is the pure policy: no timers, no I/O, no Postgres, no Docker,
// so the whole decision table is exhaustively testable without any of them.
// Everything impure, the interval, reading the proxy's ActivityTracker, the
// one pg_stat_activity guard, calling stopPostgres, lives in startHibernator,
// the only place in this file that touches real time or a real resource.

import { guardFor, type ActivityGuardResult, type Resource, type ResourceState } from '@hobby.sh/core'
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
  // asking the resource's own kind handler for its pre-sleep guard (core's
  // guardFor), which for `postgres` is a real pg_stat_activity query and for
  // a kind that declares no guard is a plain 'idle'. Named checkActiveQuery
  // for continuity with the callers that already set it; it is no longer
  // Postgres-specific. Additive and optional, same reasoning as
  // PgDeps.probeFactory: production never sets this.
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

    // A queue holds no process, so it is `running` from creation and never
    // changes: it matches the check above on every single pass, forever.
    // This is not an optimisation, it is the difference between the
    // hibernator working and the hibernator calling stop on every queue on
    // the box, every pass, for as long as the daemon runs.
    if (resource.kind === 'queue') {
      continue
    }

    const project = ctx.store.getProject(resource.projectId)

    // A released project is not hobby's to put to sleep. Its container is
    // stopped and its data directory belongs to the user's own compose stack
    // now; acting on it would mean stopping something hobby did not start.
    if (project?.releasedAt != null) {
      continue
    }

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

    // The guard above is a real network round trip, capped at a couple of
    // seconds: a client can connect through the proxy at any point during
    // it. ActivityTracker.open() happens the instant the proxy splices the
    // connection, so `connections` and `idleSeconds` captured before the
    // guard are only advisory by the time it resolves, not current. The
    // guard result itself cannot catch this either: a freshly connected
    // client that has not yet issued a query reads as pg_stat_activity
    // state 'idle', indistinguishable from nobody being there. So the
    // live count and the resource's current state are re-read here,
    // immediately before the one irreversible step, and the sleep is
    // aborted if either has moved: a connection landed, or the resource
    // left `running` (a manual stop, a wake racing this same tick) while
    // the guard was in flight.
    const freshConnections = ctx.activity.count(resource.id)
    const freshResource = ctx.store.getResource(resource.id)
    if (freshConnections !== 0 || freshResource === null || freshResource.state !== 'running') {
      continue
    }

    try {
      // Dispatched by kind. Before the registry, this named stopPostgres
      // directly, which meant hibernation could only ever sleep a database:
      // the wedge says everything sleeps, and this line is where that stops
      // being true if a kind is added without a handler.
      await ctx.kinds.get(freshResource.kind).stop(ctx, freshResource)
    } catch (err) {
      console.error(`hibernator: failed to sleep resource ${resource.id}: ${errorMessage(err)}`)
    }
  }
}

export function startHibernator(ctx: DaemonContext, opts: StartHibernatorOptions): { stop(): Promise<void> } {
  const now = opts.now ?? Date.now
  const sleepFor = opts.sleepFor ?? defaultSleepFor
  const guard =
    opts.checkActiveQuery ??
    ((resource: Resource): Promise<ActivityGuardResult> => guardFor(ctx.kinds, ctx, resource))

  let stopped = false
  let resolveStopSignal: () => void = () => {}
  const stopSignal = new Promise<void>((resolve) => {
    resolveStopSignal = resolve
  })

  // Tracks whatever tick() call is currently in flight, if any, so stop()
  // (below) can await it rather than returning while a tick is still
  // mid-way through deciding to stop a resource. Set synchronously right
  // before the loop starts awaiting a tick and cleared synchronously right
  // after, so there is never a window where a tick is genuinely running but
  // this is null.
  let currentTick: Promise<void> | null = null

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
      // A whole-tick failure (a HobbyError('ambiguous_target') would never
      // originate here, but a bug elsewhere could) must not kill the loop:
      // the next interval should still get a chance to try again. Caught
      // inside the tracked promise itself, not in a try/catch around the
      // await below, so stop()'s await of currentTick also never rejects.
      currentTick = tick(ctx, now, guard).catch((err: unknown) => {
        console.error(`hibernator: tick failed: ${errorMessage(err)}`)
      })
      await currentTick
      currentTick = null
    }
  })()

  // Safety net: everything inside the loop already catches its own errors,
  // so this only guards against something escaping that catch, which would
  // otherwise be an unhandled rejection rather than just a logged failure.
  loop.catch((err: unknown) => {
    console.error(`hibernator: loop exited unexpectedly: ${errorMessage(err)}`)
  })

  return {
    // Returns a promise so a caller (the daemon's shutdown sequence) can
    // await the currently in-flight tick, if any, draining before it
    // returns. Without this, a tick that already decided to sleep a
    // resource could run stopPostgres concurrently with the daemon's own
    // shutdown loop stopping that same resource. Idempotent: a second call
    // after the first has already resolved just returns an
    // already-resolved promise.
    stop(): Promise<void> {
      if (stopped) {
        return currentTick ?? Promise.resolve()
      }
      stopped = true
      resolveStopSignal()
      return currentTick ?? Promise.resolve()
    },
  }
}
