// The pre-sleep guard, driven by a fake store and a fake clock.
//
// The three answers matter differently. 'active' costs a delayed sleep,
// 'idle' permits an irreversible stop, and 'unreachable' is the one core
// warns about in its own comment: "A guard that could not answer must never
// be read as permission to stop."

import assert from 'node:assert/strict'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { after, test } from 'node:test'
import type { KindContext, Resource } from '@hobby.sh/core'
import { durableObjectAlarmGuard } from '../src/guard.js'
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
const RESOURCE_ID = '8f14e45f-ceea-467a-9e73-8bdb0d1e1c2b'

const resource = {
  id: RESOURCE_ID,
  projectId: 'proj-1',
  kind: 'worker',
  name: 'api',
} as unknown as Resource

// Only the two things the guard actually reads: the project's name, and where
// a resource's `do` directory is. Deliberately not a whole DaemonContext, for
// the same reason KindContext is not one.
function context(doRoot: string, opts: { projectMissing?: boolean } = {}): KindContext {
  return {
    store: {
      getProject: (id: string) => (opts.projectMissing === true ? null : { id, name: 'chat' }),
    },
    paths: {
      resourcePath: (_project: string, _resource: string, part: string) =>
        part === 'do' ? doRoot : join(doRoot, '..', part),
    },
  } as unknown as KindContext
}

// A worker that declares no Durable Object classes has no `do` directory at
// all, and must sleep exactly as it did before this guard was added.
test('a worker with no durable object storage sleeps exactly as it did before', async () => {
  const root = tempRoot()
  assert.equal(
    await durableObjectAlarmGuard(context(join(root, 'never-created')), resource, { now: () => NOW }),
    'idle'
  )
})

test('a namespace with no alarms is idle', async () => {
  const root = tempRoot()
  makeNamespace(root, `${RESOURCE_ID}-Room`, [{ id: objectId('a') }])

  assert.equal(await durableObjectAlarmGuard(context(root), resource, { now: () => NOW }), 'idle')
})

test('an alarm far ahead is idle', async () => {
  const root = tempRoot()
  makeNamespace(root, `${RESOURCE_ID}-Room`, [{ id: objectId('a'), alarmAtMs: NOW + 3_600_000 }])

  assert.equal(
    await durableObjectAlarmGuard(context(root), resource, { now: () => NOW, wakeGraceSeconds: 30 }),
    'idle'
  )
})

test('an alarm inside the grace window is active', async () => {
  const root = tempRoot()
  makeNamespace(root, `${RESOURCE_ID}-Room`, [{ id: objectId('a'), alarmAtMs: NOW + 10_000 }])

  assert.equal(
    await durableObjectAlarmGuard(context(root), resource, { now: () => NOW, wakeGraceSeconds: 30 }),
    'active'
  )
})

// The divergence from shouldSleepNamespace, and the reason the guard has its
// own predicate. On a RUNNING container an overdue row means workerd is firing
// that alarm right now, because the row is deleted when it fires. Stopping
// there kills a handler mid-flight.
test('an overdue alarm is active, because the handler is probably running', async () => {
  const root = tempRoot()
  makeNamespace(root, `${RESOURCE_ID}-Room`, [{ id: objectId('a'), alarmAtMs: NOW - 60_000 }])

  assert.equal(await durableObjectAlarmGuard(context(root), resource, { now: () => NOW }), 'active')
})

test('one namespace with an alarm makes the whole worker active', async () => {
  const root = tempRoot()
  makeNamespace(root, `${RESOURCE_ID}-Room`, [{ id: objectId('a') }])
  makeNamespace(root, `${RESOURCE_ID}-Presence`, [{ id: objectId('b'), alarmAtMs: NOW + 5_000 }])

  assert.equal(await durableObjectAlarmGuard(context(root), resource, { now: () => NOW }), 'active')
})

// The case core's comment is about. An unreadable schedule is not permission
// to stop: sleeping here would strand every alarm we can no longer see.
test('an unreadable schedule is unreachable, never idle', async () => {
  const root = tempRoot()
  makeBrokenAlarmDb(join(root, `${RESOURCE_ID}-Room`), 'CREATE TABLE wrong (id TEXT PRIMARY KEY)')

  const verdict = await durableObjectAlarmGuard(context(root), resource, { now: () => NOW })
  assert.equal(verdict, 'unreachable')
  assert.notEqual(verdict, 'idle')
})

test('a resource whose project has vanished is unreachable, never idle', async () => {
  const root = tempRoot()
  makeNamespace(root, `${RESOURCE_ID}-Room`, [{ id: objectId('a') }])

  const verdict = await durableObjectAlarmGuard(context(root, { projectMissing: true }), resource, {
    now: () => NOW,
  })
  assert.equal(verdict, 'unreachable')
})
