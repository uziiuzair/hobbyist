// The alarm mirror: the impure half, and the only file in this package that
// touches real time.
//
// It holds no state about alarms. Each tick re-reads the truth from disk,
// because alarms are set and cleared by a runtime this package does not
// observe, so any cache here would need an invalidation path back from a
// process we are not talking to. Re-reading is the same argument
// docs/proxy/research/2026-08-10-neon-proxy-prior-art.md records for
// re-resolving an upstream address rather than trusting a cached one.
//
// It never starts anything. It calls wake(resourceId) and stops, exactly as
// packages/proxy calls wake rather than reaching for Docker.
// docs/proxy/CLAUDE.md calls that "the proxy asks, the engine acts"; this is
// the same seam one clock further out.

import { nextAlarmAtMs } from './alarms.js'
import { isAlarmDue } from './sleep.js'

export interface MirroredNamespace {
  resourceId: string
  // Absolute path to <resourceRoot>/do/<uniqueKey>.
  namespaceDir: string
}

export interface AlarmMirrorOptions {
  // Called fresh each tick rather than captured once, so a namespace created
  // or destroyed while the daemon runs is picked up without restarting the
  // mirror.
  namespaces: () => MirroredNamespace[]
  // Asked for, never performed here. Resolving means the runtime is up;
  // rejecting is logged and retried on the next tick.
  wake: (resourceId: string) => Promise<void>
  intervalMs: number
  // Injectable seams, matching startHibernator's: the loop is testable
  // against a fake clock with zero real time passing. Production omits both.
  now?: () => number
  sleepFor?: (ms: number) => Promise<void>
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function defaultSleepFor(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    // Never let this background loop's own wait keep the process alive. Same
    // reasoning as hibernator.ts's defaultSleepFor.
    timer.unref?.()
  })
}

// One pass. A namespace whose earliest alarm has come due gets one wake call.
//
// Failures are contained per namespace: an unreadable alarm table (the loud
// failure assertAlarmSchema exists to produce) must not stop the other
// namespaces in the same tick from being woken.
export async function tickOnce(
  namespaces: MirroredNamespace[],
  now: () => number,
  wake: (resourceId: string) => Promise<void>
): Promise<void> {
  const nowMs = now()
  for (const namespace of namespaces) {
    let deadline: number | null
    try {
      deadline = nextAlarmAtMs(namespace.namespaceDir)
    } catch (err) {
      console.error(
        `alarm mirror: cannot read alarms for resource ${namespace.resourceId}: ${errorMessage(err)}`
      )
      continue
    }

    if (!isAlarmDue(deadline, nowMs)) {
      continue
    }

    try {
      await wake(namespace.resourceId)
    } catch (err) {
      // Left for the next tick. The alarm row is still on disk and still
      // overdue, so nothing is lost by failing here; the wake is retried for
      // as long as it stays overdue, which is until workerd runs and clears
      // the row itself.
      console.error(`alarm mirror: wake failed for resource ${namespace.resourceId}: ${errorMessage(err)}`)
    }
  }
}

export function startAlarmMirror(opts: AlarmMirrorOptions): { stop(): Promise<void> } {
  const now = opts.now ?? Date.now
  const sleepFor = opts.sleepFor ?? defaultSleepFor

  let stopped = false
  let resolveStopSignal: () => void = () => {}
  const stopSignal = new Promise<void>((resolve) => {
    resolveStopSignal = resolve
  })

  // Tracks the in-flight tick so stop() can drain rather than returning while
  // a wake is half done. Set synchronously before the await and cleared
  // synchronously after, so there is never a window where a tick is running
  // but this is null.
  let currentTick: Promise<void> | null = null

  // Races the interval against stop(), so shutdown does not wait out a full
  // interval. Returns true when the interval elapsed normally.
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
      // Caught inside the tracked promise, not around the await, so stop()'s
      // await of currentTick never rejects either.
      currentTick = tickOnce(opts.namespaces(), now, opts.wake).catch((err: unknown) => {
        console.error(`alarm mirror: tick failed: ${errorMessage(err)}`)
      })
      await currentTick
      currentTick = null
    }
  })()

  loop.catch((err: unknown) => {
    console.error(`alarm mirror: loop exited unexpectedly: ${errorMessage(err)}`)
  })

  return {
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
