// The global image build lock (issue #83). Pure promises, no runtime, no
// Docker: what is pinned is the ordering, that a failed build does not wedge
// the ones behind it, and that a build which had to wait is told so.

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildQueuedNote, pendingBuilds, withBuildLock } from '../src/index.js'

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

test('builds run one at a time, in the order they were requested', async () => {
  const order: string[] = []
  const slow = async (label: string, ms: number): Promise<string> => {
    order.push(`start:${label}`)
    await sleep(ms)
    order.push(`end:${label}`)
    return label
  }

  const results = await Promise.all([
    withBuildLock(() => slow('a', 20)),
    withBuildLock(() => slow('b', 1)),
    withBuildLock(() => slow('c', 1)),
  ])

  assert.deepEqual(results, ['a', 'b', 'c'])
  assert.deepEqual(order, ['start:a', 'end:a', 'start:b', 'end:b', 'start:c', 'end:c'])
  assert.equal(pendingBuilds(), 0)
})

test('a build that fails releases the lock for the next one', async () => {
  const failed = withBuildLock(async () => {
    await sleep(1)
    throw new Error('docker build failed')
  })
  const next = withBuildLock(async () => 'ok')

  await assert.rejects(failed, /docker build failed/)
  assert.equal(await next, 'ok')
  assert.equal(pendingBuilds(), 0)
})

test('a build that has to wait is told how many are ahead of it; the first is not', async () => {
  const waits: number[] = []
  const onWait = (n: number): void => {
    waits.push(n)
  }

  const first = withBuildLock(() => sleep(10), { onWait })
  const second = withBuildLock(() => sleep(1), { onWait })
  const third = withBuildLock(() => sleep(1), { onWait })
  assert.equal(pendingBuilds(), 3)
  await Promise.all([first, second, third])

  assert.deepEqual(waits, [1, 2])
  assert.equal(buildQueuedNote(1), 'hobby: build queued behind another build; one image builds at a time on this box\n')
  assert.equal(buildQueuedNote(2), 'hobby: build queued behind 2 other builds; one image builds at a time on this box\n')
})
