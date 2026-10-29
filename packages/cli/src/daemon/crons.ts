// Cron triggers for workers (issue #75): `[triggers] crons` in the manifest,
// which the deploy used to report as "scheduled workers are not built yet".
// The daemon is the only thing awake on this box when a worker is asleep,
// so the daemon keeps the clock: a ten-second tick computes, for every
// deployed worker's every cron, the first time after its last firing (or
// after the daemon started) that the schedule matches, and when that time
// has passed it wakes the worker through the same wake every other caller
// uses and posts to the runner's control channel, which calls the user's
// scheduled() handler (CONTROL_SOURCE, packages/worker/src/runtime-image.ts).
//
// Two deliberate limits. Missed firings are not replayed: a daemon that was
// down from 02:00 to 09:00 fires a daily 03:00 job tomorrow, not now, which
// is what Cloudflare does for a worker whose cron came and went, and what
// anyone restarting a box expects of cron. And one firing per cron per
// tick: a `* * * * *` that was late by three minutes runs once, not three
// times, because a scheduled() handler written for "every minute" is not
// written for "three times in a row right now".
//
// This module knows the store only through `scheduledWorkers`; the
// scheduler itself takes functions, like startQueueTick and the alarm
// mirror, so a test can drive it with a fake clock and no daemon.

import { createStopSignal, nextCronTime, parseCron, type ResourceState } from '@hobby.sh/core'
import type { DaemonContext } from './context.js'

export interface ScheduledWorker {
  resourceId: string
  projectName: string
  name: string
  controlPort: number
  crons: string[]
}

export interface CronFiring {
  worker: ScheduledWorker
  cron: string
  // The schedule time that was due, not the moment the tick noticed it,
  // so a handler that reads `event.scheduledTime` sees the minute it was
  // written for.
  scheduledTimeMs: number
}

export interface CronOutcome {
  outcome: 'ok' | 'exception' | 'unreachable' | 'wake_failed'
  detail?: string
}

// What `hobby cron ls` shows and what the scheduler consults: when each
// (worker, cron) last fired, and how it went. In memory on purpose: the
// one thing it drives, "do not replay", is exactly what a fresh map on
// daemon start gives.
export interface CronState {
  startedAtMs: number
  lastFiredAtMs: Map<string, number>
  lastOutcome: Map<string, CronOutcome>
}

export function cronKey(resourceId: string, cron: string): string {
  return `${resourceId}\u0000${cron}`
}

const states = new WeakMap<DaemonContext, CronState>()

export function cronState(ctx: DaemonContext, now: () => number = Date.now): CronState {
  let state = states.get(ctx)
  if (state === undefined) {
    state = { startedAtMs: now(), lastFiredAtMs: new Map(), lastOutcome: new Map() }
    states.set(ctx, state)
  }
  return state
}

// Every deployed worker that declares at least one cron. Undeployed rows
// have no manifest and nothing to run; failed ones are skipped too, since
// waking them is what the backoff in wake-backoff.ts exists to pace, and a
// cron tick firing into it every ten seconds would defeat that.
export function scheduledWorkers(ctx: DaemonContext): ScheduledWorker[] {
  const out: ScheduledWorker[] = []
  for (const resource of ctx.store.listResources()) {
    if (resource.kind !== 'worker' || resource.config.manifest === null || resource.state === 'undeployed' || resource.state === 'failed') {
      continue
    }
    const crons = resource.config.manifest.crons ?? []
    if (crons.length === 0) {
      continue
    }
    const project = ctx.store.getProject(resource.projectId)
    out.push({
      resourceId: resource.id,
      projectName: project?.name ?? resource.projectId,
      name: resource.name,
      controlPort: resource.config.controlPort,
      crons,
    })
  }
  return out
}

export interface CronTickOptions {
  workers: () => ScheduledWorker[]
  wake: (resourceId: string) => Promise<void>
  stateOf: (resourceId: string) => ResourceState
  fire: (firing: CronFiring) => Promise<CronOutcome>
  state: CronState
  now?: () => number
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

// One pass over every schedule. Exported for tests; startCronScheduler
// below is the loop around it.
export async function tickCrons(opts: CronTickOptions): Promise<CronFiring[]> {
  const now = opts.now ?? Date.now
  const nowMs = now()
  const fired: CronFiring[] = []

  for (const worker of opts.workers()) {
    for (const cron of worker.crons) {
      const key = cronKey(worker.resourceId, cron)
      const since = opts.state.lastFiredAtMs.get(key) ?? opts.state.startedAtMs
      let due: number
      try {
        due = nextCronTime(parseCron(cron), since)
      } catch (err) {
        // Validated at deploy, so this is a row written by an older build or
        // an expression that never fires. Logged once per key, not per tick.
        if (!opts.state.lastOutcome.has(key)) {
          opts.state.lastOutcome.set(key, { outcome: 'exception', detail: errorMessage(err) })
          console.error(`cron: ${worker.projectName}/${worker.name} ${JSON.stringify(cron)}: ${errorMessage(err)}`)
        }
        continue
      }
      if (due > nowMs) {
        continue
      }
      // Recorded before the wake, not after it succeeds: a wake that takes
      // longer than a tick must not be asked for again by the next one.
      opts.state.lastFiredAtMs.set(key, nowMs)
      const firing: CronFiring = { worker, cron, scheduledTimeMs: due }
      fired.push(firing)

      const state = opts.stateOf(worker.resourceId)
      if (state === 'sleeping') {
        try {
          await opts.wake(worker.resourceId)
        } catch (err) {
          opts.state.lastOutcome.set(key, { outcome: 'wake_failed', detail: errorMessage(err) })
          console.error(`cron: ${worker.projectName}/${worker.name} ${JSON.stringify(cron)}: wake failed: ${errorMessage(err)}`)
          continue
        }
      } else if (state !== 'running') {
        // `starting` (someone else is waking it) or a state with nothing
        // to post to. The firing is kept as done: the next match is the
        // next one, the same rule as a missed one while the daemon was down.
        opts.state.lastOutcome.set(key, { outcome: 'unreachable', detail: `worker was ${state}` })
        continue
      }

      try {
        opts.state.lastOutcome.set(key, await opts.fire(firing))
      } catch (err) {
        opts.state.lastOutcome.set(key, { outcome: 'exception', detail: errorMessage(err) })
        console.error(`cron: ${worker.projectName}/${worker.name} ${JSON.stringify(cron)}: ${errorMessage(err)}`)
      }
    }
  }
  return fired
}

// Cloudflare gives a scheduled() handler up to fifteen minutes, and the
// control request holds for as long as the handler runs, so the timeout
// matches that rather than the queue path's half-lease.
export const SCHEDULED_TIMEOUT_MS = 15 * 60_000

// POST /scheduled on the runner's control channel. Exported so the route
// and the scheduler share it; tests swap it through CronTickOptions.fire.
export async function postScheduled(firing: CronFiring, timeoutMs: number = SCHEDULED_TIMEOUT_MS): Promise<CronOutcome> {
  let res: Response
  try {
    res = await fetch(`http://127.0.0.1:${firing.worker.controlPort}/scheduled`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cron: firing.cron, scheduledTime: firing.scheduledTimeMs }),
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (err) {
    return { outcome: 'unreachable', detail: errorMessage(err) }
  }
  if (!res.ok) {
    return { outcome: 'exception', detail: `control channel answered ${res.status}` }
  }
  let body: unknown
  try {
    body = await res.json()
  } catch {
    return { outcome: 'ok' }
  }
  const outcome = typeof body === 'object' && body !== null ? (body as { outcome?: unknown }).outcome : undefined
  return outcome === 'exception' ? { outcome: 'exception', detail: 'scheduled() threw' } : { outcome: 'ok' }
}

export interface CronSchedulerOptions extends Omit<CronTickOptions, 'now'> {
  intervalMs: number
  now?: () => number
  sleepFor?: (ms: number) => Promise<void>
}

function defaultSleepFor(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    timer.unref?.()
  })
}

export function startCronScheduler(opts: CronSchedulerOptions): { stop(): Promise<void> } {
  const sleepFor = opts.sleepFor ?? defaultSleepFor
  let stopped = false
  const stopSignal = createStopSignal()
  let current: Promise<unknown> | null = null

  const loop = (async (): Promise<void> => {
    while (!stopped) {
      const sleptFully = await stopSignal.wait(sleepFor(opts.intervalMs))
      if (!sleptFully || stopped) {
        break
      }
      current = tickCrons(opts).catch((err: unknown) => {
        console.error(`cron: tick failed: ${errorMessage(err)}`)
      })
      await current
      current = null
    }
  })()
  loop.catch((err: unknown) => {
    console.error(`cron: loop exited unexpectedly: ${errorMessage(err)}`)
  })

  return {
    stop(): Promise<void> {
      if (stopped) {
        return (current ?? Promise.resolve()).then(() => undefined)
      }
      stopped = true
      stopSignal.stop()
      return (current ?? Promise.resolve()).then(() => undefined)
    },
  }
}

export interface CronListing {
  worker: string
  resourceId: string
  cron: string
  nextAt: string
  lastAt: string | null
  lastOutcome: CronOutcome | null
}

// For `hobby cron ls`: every schedule in a project, with when it next
// fires and how the last firing went.
export function listCrons(ctx: DaemonContext, projectName: string, now: () => number = Date.now): CronListing[] {
  const state = cronState(ctx, now)
  const out: CronListing[] = []
  for (const worker of scheduledWorkers(ctx)) {
    if (worker.projectName !== projectName) {
      continue
    }
    for (const cron of worker.crons) {
      const key = cronKey(worker.resourceId, cron)
      const last = state.lastFiredAtMs.get(key)
      let nextAt: string
      try {
        nextAt = new Date(nextCronTime(parseCron(cron), last ?? state.startedAtMs)).toISOString()
      } catch {
        nextAt = 'never'
      }
      out.push({
        worker: `${worker.projectName}/${worker.name}`,
        resourceId: worker.resourceId,
        cron,
        nextAt,
        lastAt: last === undefined ? null : new Date(last).toISOString(),
        lastOutcome: state.lastOutcome.get(key) ?? null,
      })
    }
  }
  return out
}
