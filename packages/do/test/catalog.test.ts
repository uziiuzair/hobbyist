import assert from 'node:assert/strict'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { HobbyError } from '@hobby.sh/core'
import { describeNamespace, listNamespaces, parseUniqueKey } from '../src/catalog.js'
import { makeNamespace, makeTempRoot, objectId, writeAlarms } from './fixtures.js'

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

const RESOURCE_ID = '8f14e45f-ceea-467a-9e73-8bdb0d1e1c2b'

test('a unique key splits at the last hyphen, because the modifier is a UUID', () => {
  // The exact directory name observed from a real Miniflare persistence tree.
  assert.deepEqual(parseUniqueKey(`${RESOURCE_ID}-Room`), {
    resourceId: RESOURCE_ID,
    className: 'Room',
  })
})

test('a unique key with no modifier still parses', () => {
  assert.deepEqual(parseUniqueKey('a-Room'), { resourceId: 'a', className: 'Room' })
})

test('a directory name that is not <modifier>-<Class> is refused', () => {
  for (const bad of ['Room', '-Room', 'Room-', '']) {
    assert.throws(() => parseUniqueKey(bad), HobbyError, `"${bad}" should not parse`)
  }
})

test('metadata.sqlite is not an object and neither are the sidecars', () => {
  const root = tempRoot()
  makeNamespace(root, `${RESOURCE_ID}-Room`, [
    { id: objectId('a'), alarmAtMs: 1786375171389, name: 'alpha', sidecars: true },
    { id: objectId('b'), sidecars: true },
  ])

  const summary = describeNamespace(root, `${RESOURCE_ID}-Room`)
  assert.equal(summary.objectCount, 2)
  assert.deepEqual(
    summary.objects.map((object) => object.id).sort(),
    [objectId('a'), objectId('b')].sort()
  )
})

test('a file that is not an object id is ignored rather than listed', () => {
  const root = tempRoot()
  const dir = makeNamespace(root, `${RESOURCE_ID}-Room`, [{ id: objectId('a') }])
  // Something a human or another tool dropped in the directory. It is not a
  // Durable Object and must not be reported as one.
  writeFileSync(join(dir, 'notes.sqlite'), '')
  writeFileSync(join(dir, 'README.md'), '')

  assert.equal(describeNamespace(root, `${RESOURCE_ID}-Room`).objectCount, 1)
})

test('a name is shown only for an object with a pending alarm', () => {
  const root = tempRoot()
  makeNamespace(root, `${RESOURCE_ID}-Room`, [
    { id: objectId('a'), alarmAtMs: 1786375171389, name: 'room-alpha' },
    { id: objectId('b') },
  ])

  const summary = describeNamespace(root, `${RESOURCE_ID}-Room`)
  const named = summary.objects.find((object) => object.id === objectId('a'))
  const unnamed = summary.objects.find((object) => object.id === objectId('b'))
  assert.equal(named?.name, 'room-alpha')
  // Not "" and not the id: idFromName is an HMAC and does not reverse, so the
  // honest answer is that we do not know.
  assert.strictEqual(unnamed?.name, null)
  assert.strictEqual(unnamed?.alarmAtMs, null)
})

test('the namespace reports its earliest alarm and its total size', () => {
  const root = tempRoot()
  const early = 1786375171389
  makeNamespace(root, `${RESOURCE_ID}-Room`, [
    { id: objectId('a'), alarmAtMs: 1786378771396 },
    { id: objectId('b'), alarmAtMs: early },
  ])

  const summary = describeNamespace(root, `${RESOURCE_ID}-Room`)
  assert.equal(summary.nextAlarmAtMs, early)
  assert.equal(summary.className, 'Room')
  assert.equal(summary.resourceId, RESOURCE_ID)
  assert.equal(
    summary.totalSizeBytes,
    summary.objects.reduce((total, object) => total + object.sizeBytes, 0)
  )
  assert.ok(summary.totalSizeBytes > 0)
})

// The alarm row is authoritative for wake, not the file listing. workerd
// reconstructs an object to run its handler, so a row whose file is gone is
// still a real wake.
test('an alarm whose object file is missing still sets the namespace deadline', () => {
  const root = tempRoot()
  const dir = makeNamespace(root, `${RESOURCE_ID}-Room`, [{ id: objectId('a') }])
  // Write an alarm for an object that has no file.
  writeAlarms(dir, [{ id: objectId('c'), alarmAtMs: 1786375171389, name: 'ghost' }])

  const summary = describeNamespace(root, `${RESOURCE_ID}-Room`)
  assert.equal(summary.objectCount, 1)
  assert.equal(summary.nextAlarmAtMs, 1786375171389)
})

test('a do root that does not exist lists nothing rather than failing', () => {
  const root = tempRoot()
  assert.deepEqual(listNamespaces(join(root, 'no-do-dir')), [])
})

test('listNamespaces returns every namespace, sorted', () => {
  const root = tempRoot()
  makeNamespace(root, `${RESOURCE_ID}-Room`, [{ id: objectId('a') }])
  makeNamespace(root, `${RESOURCE_ID}-Presence`, [{ id: objectId('b') }])

  assert.deepEqual(
    listNamespaces(root).map((namespace) => namespace.className),
    ['Presence', 'Room']
  )
})

// Found by running the finished package against a real Miniflare tree written
// without a uniqueKeyModifier, whose directories are named `-Room`. One of
// them aborted the entire listing.
test('a directory that is not a hobby namespace is skipped, not fatal to the listing', () => {
  const root = tempRoot()
  makeNamespace(root, `${RESOURCE_ID}-Room`, [{ id: objectId('a') }])
  makeNamespace(root, '-Presence', [{ id: objectId('b') }])
  mkdirSync(join(root, 'scratch'), { recursive: true })

  assert.deepEqual(
    listNamespaces(root).map((namespace) => namespace.className),
    ['Room']
  )
})

test('naming a bad namespace directly still throws, since the caller asked for it', () => {
  const root = tempRoot()
  makeNamespace(root, '-Presence', [{ id: objectId('b') }])
  assert.throws(() => describeNamespace(root, '-Presence'), HobbyError)
})

test('describing a namespace with no directory is a not-found, not an empty summary', () => {
  const root = tempRoot()
  assert.throws(
    () => describeNamespace(root, `${RESOURCE_ID}-Room`),
    (err: unknown) => err instanceof HobbyError && err.code === 'resource_not_found'
  )
})
