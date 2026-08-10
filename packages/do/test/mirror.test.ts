// The mirror, driven by a fake clock and a counter. No Docker, no workerd, no
// real time: startAlarmMirror's `now` and `sleepFor` seams exist so the loop
// can be exercised exactly the way hibernator.test.ts exercises its own.

import assert from 'node:assert/strict'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { startAlarmMirror, tickOnce, type MirroredNamespace } from '../src/mirror.js'
import { makeBrokenAlarmDb, makeNamespace, makeTempRoot, objectId } from './fixtures.js'

const roots: string[] = []
function tempRoot(): string {
  const root = makeTempRoot()
  roots.push(root)
  return root
}
after(() => {
  for (const root of roots) {
    rmSync(root, { recursive: true, force: true })
  }
})

const NOW = 1786375171389

function recorder() {
  const woken: string[] = []
  return {
    woken,
    wake: async (resourceId: string): Promise<void> => {
      woken.push(resourceId)
    },
  }
}

test('a namespace whose alarm has come due is woken exactly once', async () => {
  const root = tempRoot()
  const dir = makeNamespace(root, 'r-Room', [{ id: objectId('a'), alarmAtMs: NOW }])
  const { woken, wake } = recorder()

  await tickOnce([{ resourceId: 'res-1', namespaceDir: dir }], () => NOW, wake)

  assert.deepEqual(woken, ['res-1'])
})

test('a namespace whose alarm is in the future is left asleep', async () => {
  const root = tempRoot()
  const dir = makeNamespace(root, 'r-Room', [{ id: objectId('a'), alarmAtMs: NOW + 1 }])
  const { woken, wake } = recorder()

  await tickOnce([{ resourceId: 'res-1', namespaceDir: dir }], () => NOW, wake)

  assert.deepEqual(woken, [])
})

test('a namespace with no alarms is never woken', async () => {
  const root = tempRoot()
  const dir = makeNamespace(root, 'r-Room', [{ id: objectId('a') }])
  const { woken, wake } = recorder()

  await tickOnce([{ resourceId: 'res-1', namespaceDir: dir }], () => NOW, wake)

  assert.deepEqual(woken, [])
})

// An unreadable alarm table is the loud failure assertAlarmSchema exists to
// produce. It must not take the rest of the tick down with it, or one broken
// namespace would stop every other namespace on the box from waking.
test('a namespace with an unreadable schedule does not stop the others from waking', async () => {
  const root = tempRoot()
  const broken = join(root, 'r-Broken')
  makeBrokenAlarmDb(broken, 'CREATE TABLE wrong (id TEXT PRIMARY KEY)')
  const healthy = makeNamespace(root, 'r-Room', [{ id: objectId('a'), alarmAtMs: NOW }])
  const { woken, wake } = recorder()

  await tickOnce(
    [
      { resourceId: 'broken', namespaceDir: broken },
      { resourceId: 'healthy', namespaceDir: healthy },
    ],
    () => NOW,
    wake
  )

  assert.deepEqual(woken, ['healthy'])
})

test('a failing wake does not stop the rest of the tick, and is not swallowed silently', async () => {
  const root = tempRoot()
  const first = makeNamespace(root, 'r-A', [{ id: objectId('a'), alarmAtMs: NOW }])
  const second = makeNamespace(root, 'r-B', [{ id: objectId('b'), alarmAtMs: NOW }])
  const attempted: string[] = []

  await tickOnce(
    [
      { resourceId: 'fails', namespaceDir: first },
      { resourceId: 'works', namespaceDir: second },
    ],
    () => NOW,
    async (resourceId) => {
      attempted.push(resourceId)
      if (resourceId === 'fails') {
        throw new Error('runtime refused to start')
      }
    }
  )

  // Both were attempted: the failure did not abort the loop.
  assert.deepEqual(attempted, ['fails', 'works'])
})

test('the namespace list is re-read every tick, so a new namespace is picked up', async () => {
  const root = tempRoot()
  const dir = makeNamespace(root, 'r-Room', [{ id: objectId('a'), alarmAtMs: NOW }])
  const { woken, wake } = recorder()

  let namespaces: MirroredNamespace[] = []
  const pending: Array<() => void> = []

  const mirror = startAlarmMirror({
    namespaces: () => namespaces,
    wake,
    intervalMs: 1000,
    now: () => NOW,
    // A controllable clock: each tick waits here until the test releases it,
    // so the loop advances a known number of times and no real time passes.
    sleepFor: () =>
      new Promise<void>((resolve) => {
        pending.push(resolve)
      }),
  })

  async function releaseOneTick(): Promise<void> {
    // Let the loop reach its wait, then release it and let the tick run.
    await new Promise((resolve) => setImmediate(resolve))
    pending.shift()?.()
    await new Promise((resolve) => setImmediate(resolve))
    await new Promise((resolve) => setImmediate(resolve))
  }

  await releaseOneTick()
  assert.deepEqual(woken, [], 'nothing registered yet')

  namespaces = [{ resourceId: 'res-1', namespaceDir: dir }]
  await releaseOneTick()
  assert.deepEqual(woken, ['res-1'], 'picked up without restarting the mirror')

  await mirror.stop()
})

test('stop() resolves and no further ticks run', async () => {
  const { woken, wake } = recorder()
  const pending: Array<() => void> = []

  const mirror = startAlarmMirror({
    namespaces: () => [],
    wake,
    intervalMs: 1000,
    now: () => NOW,
    sleepFor: () =>
      new Promise<void>((resolve) => {
        pending.push(resolve)
      }),
  })

  await new Promise((resolve) => setImmediate(resolve))
  // stop() must interrupt the wait rather than let it run out, which is what
  // the Promise.race in waitOrStop is for. If it did not, this would hang.
  await mirror.stop()
  await mirror.stop() // idempotent
  assert.deepEqual(woken, [])
})
