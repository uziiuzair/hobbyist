// The cron scheduler (packages/cli/src/daemon/crons.ts), driven with a fake
// clock and no daemon: issue #75.

import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ResourceState } from '@hobby.sh/core'
import { cronKey, tickCrons, type CronFiring, type CronOutcome, type CronState, type ScheduledWorker } from '../src/daemon/crons.js'

const T0 = Date.parse('2026-10-29T12:00:00Z')
const MIN = 60_000

function worker(crons: string[], id = 'w1'): ScheduledWorker {
  return { resourceId: id, projectName: 'blog', name: 'cron', controlPort: 35501, crons }
}

function harness(opts: { workers: ScheduledWorker[]; states?: Record<string, ResourceState>; wakeFails?: boolean; startedAt?: number }) {
  const states: Record<string, ResourceState> = opts.states ?? {}
  const fired: CronFiring[] = []
  const woken: string[] = []
  const state: CronState = { startedAtMs: opts.startedAt ?? T0, lastFiredAtMs: new Map(), lastOutcome: new Map() }
  const tick = (nowMs: number): Promise<CronFiring[]> =>
    tickCrons({
      workers: () => opts.workers,
      stateOf: (id) => states[id] ?? 'running',
      wake: async (id) => {
        woken.push(id)
        if (opts.wakeFails === true) throw new Error('wake_timeout: did not start')
        states[id] = 'running'
      },
      fire: async (firing): Promise<CronOutcome> => {
        fired.push(firing)
        return { outcome: 'ok' }
      },
      state,
      now: () => nowMs,
    })
  return { tick, fired, woken, state, states }
}

test('a schedule fires once its time has passed, with the scheduled minute, not before', async () => {
  const h = harness({ workers: [worker(['*/5 * * * *'])] })
  assert.deepEqual(await h.tick(T0 + 4 * MIN + 50_000), [])
  const fired = await h.tick(T0 + 5 * MIN + 7_000)
  assert.equal(fired.length, 1)
  assert.equal(fired[0]?.scheduledTimeMs, T0 + 5 * MIN)
  assert.equal(fired[0]?.cron, '*/5 * * * *')
  assert.deepEqual(h.state.lastOutcome.get(cronKey('w1', '*/5 * * * *')), { outcome: 'ok' })
})

test('the same firing is not repeated on the next tick, and the next match is relative to the last firing', async () => {
  const h = harness({ workers: [worker(['*/5 * * * *'])] })
  await h.tick(T0 + 5 * MIN + 3_000)
  assert.deepEqual(await h.tick(T0 + 5 * MIN + 13_000), [])
  assert.deepEqual(await h.tick(T0 + 9 * MIN + 59_000), [])
  assert.equal((await h.tick(T0 + 10 * MIN + 1_000)).length, 1)
  assert.equal(h.fired.length, 2)
})

test('several missed firings collapse into one, and nothing before the daemon started is replayed', async () => {
  const h = harness({ workers: [worker(['* * * * *'])], startedAt: T0 })
  // Three minutes late: one firing, for the first minute that was due.
  const fired = await h.tick(T0 + 3 * MIN + 30_000)
  assert.equal(fired.length, 1)
  assert.equal(fired[0]?.scheduledTimeMs, T0 + 1 * MIN)
  // The minute the daemon started in is not fired for.
  assert.equal(h.fired.length, 1)
})

test('a sleeping worker is woken exactly once before its handler is called', async () => {
  const h = harness({ workers: [worker(['0 * * * *'])], states: { w1: 'sleeping' } })
  await h.tick(T0 + 60 * MIN)
  assert.deepEqual(h.woken, ['w1'])
  assert.equal(h.fired.length, 1)
})

test('a wake that fails is recorded and not retried until the next match', async () => {
  const h = harness({ workers: [worker(['0 * * * *'])], states: { w1: 'sleeping' }, wakeFails: true })
  await h.tick(T0 + 60 * MIN)
  assert.equal(h.fired.length, 0)
  assert.equal(h.state.lastOutcome.get(cronKey('w1', '0 * * * *'))?.outcome, 'wake_failed')
  await h.tick(T0 + 60 * MIN + 10_000)
  assert.deepEqual(h.woken, ['w1'], 'no second wake inside the same hour')
})

test('a worker already starting is skipped for this firing rather than woken again', async () => {
  const h = harness({ workers: [worker(['0 * * * *'])], states: { w1: 'starting' } })
  await h.tick(T0 + 60 * MIN)
  assert.deepEqual(h.woken, [])
  assert.equal(h.fired.length, 0)
  assert.equal(h.state.lastOutcome.get(cronKey('w1', '0 * * * *'))?.outcome, 'unreachable')
})

test('every cron of every worker is considered independently', async () => {
  const h = harness({ workers: [worker(['*/2 * * * *', '*/3 * * * *']), worker(['*/6 * * * *'], 'w2')] })
  const fired = await h.tick(T0 + 6 * MIN)
  assert.deepEqual(
    fired.map((f) => `${f.worker.resourceId} ${f.cron}`),
    ['w1 */2 * * * *', 'w1 */3 * * * *', 'w2 */6 * * * *']
  )
})
