import assert from 'node:assert/strict'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { HobbyError, type ResourceState } from '@hobby.sh/core'
import { readPendingAlarms } from '../src/alarms.js'
import { deleteObject, pruneNamespace } from '../src/storage.js'
import { makeNamespace, makeTempRoot, objectId } from './fixtures.js'

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

const STOPPED = { state: 'sleeping' as ResourceState }

test('deleting an object removes its database and both sidecars', () => {
  const root = tempRoot()
  const id = objectId('a')
  const dir = makeNamespace(root, 'r-Room', [{ id, sidecars: true }, { id: objectId('b') }])

  deleteObject(dir, id, STOPPED)

  for (const extension of ['.sqlite', '.sqlite-wal', '.sqlite-shm']) {
    assert.equal(existsSync(join(dir, `${id}${extension}`)), false, `${extension} should be gone`)
  }
  // The other object is untouched.
  assert.equal(existsSync(join(dir, `${objectId('b')}.sqlite`)), true)
})

// The row matters as much as the files. Left behind, it would wake the whole
// runtime at its deadline for an object the user deleted, and workerd would
// helpfully reconstruct an empty one to run the handler.
test('deleting an object clears its alarm row, so it cannot wake the runtime later', () => {
  const root = tempRoot()
  const doomed = objectId('a')
  const kept = objectId('b')
  const dir = makeNamespace(root, 'r-Room', [
    { id: doomed, alarmAtMs: 1786375171389, name: 'doomed' },
    { id: kept, alarmAtMs: 1786378771396, name: 'kept' },
  ])

  deleteObject(dir, doomed, STOPPED)

  const remaining = readPendingAlarms(dir)
  assert.deepEqual(
    remaining.map((alarm) => alarm.actorName),
    ['kept']
  )
})

test('deleting an object with no alarm table is fine', () => {
  const root = tempRoot()
  const id = objectId('a')
  const dir = makeNamespace(root, 'r-Room', [{ id }])
  deleteObject(dir, id, STOPPED)
  assert.equal(existsSync(join(dir, `${id}.sqlite`)), false)
})

test('deleting an object that is already gone is a successful no-op', () => {
  const root = tempRoot()
  const dir = makeNamespace(root, 'r-Room', [{ id: objectId('a') }])
  deleteObject(dir, objectId('z'), STOPPED)
})

// The id arrives from the CLI and from Studio. Without validation this
// function is an arbitrary unlink.
test('an object id that is not 64 hex characters is refused before any filesystem call', () => {
  const root = tempRoot()
  const dir = makeNamespace(root, 'r-Room', [{ id: objectId('a') }])
  const canary = join(root, 'canary')
  writeFileSync(canary, 'still here')

  for (const bad of ['../../canary', '..', 'a/b', '', 'A'.repeat(64), 'ab', `${objectId('a')}x`]) {
    assert.throws(
      () => deleteObject(dir, bad, STOPPED),
      (err: unknown) => err instanceof HobbyError && err.code === 'invalid_name',
      `"${bad}" should be refused`
    )
  }
  assert.equal(existsSync(canary), true)
})

test('deleting under a running runtime is refused', () => {
  const root = tempRoot()
  const id = objectId('a')
  const dir = makeNamespace(root, 'r-Room', [{ id }])

  for (const state of ['running', 'starting'] as ResourceState[]) {
    assert.throws(
      () => deleteObject(dir, id, { state }),
      (err: unknown) => err instanceof HobbyError && err.code === 'conflict',
      `state ${state} should refuse`
    )
  }
  assert.equal(existsSync(join(dir, `${id}.sqlite`)), true)
})

test('pruning removes the whole namespace directory', () => {
  const root = tempRoot()
  makeNamespace(root, 'r-Room', [{ id: objectId('a'), alarmAtMs: 1786375171389, sidecars: true }])
  makeNamespace(root, 'r-Presence', [{ id: objectId('b') }])

  pruneNamespace(root, 'r-Room', STOPPED)

  assert.equal(existsSync(join(root, 'r-Room')), false)
  assert.equal(existsSync(join(root, 'r-Presence')), true)
})

test('pruning under a running runtime is refused', () => {
  const root = tempRoot()
  makeNamespace(root, 'r-Room', [{ id: objectId('a') }])
  assert.throws(
    () => pruneNamespace(root, 'r-Room', { state: 'running' }),
    (err: unknown) => err instanceof HobbyError && err.code === 'conflict'
  )
  assert.equal(existsSync(join(root, 'r-Room')), true)
})

test('a namespace name that could climb out of the root is refused', () => {
  const root = tempRoot()
  const outside = join(root, 'outside')
  mkdirSync(outside, { recursive: true })
  writeFileSync(join(outside, 'keep'), 'x')

  for (const bad of ['..', '../outside', 'a/b', '']) {
    assert.throws(
      () => pruneNamespace(join(root, 'do'), bad, STOPPED),
      (err: unknown) => err instanceof HobbyError && err.code === 'invalid_name',
      `"${bad}" should be refused`
    )
  }
  assert.equal(existsSync(join(outside, 'keep')), true)
})

test('pruning a namespace that does not exist is a successful no-op', () => {
  const root = tempRoot()
  pruneNamespace(root, 'r-Nothing', STOPPED)
})
