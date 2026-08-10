// The read that the whole capability rests on: can we learn a stopped
// namespace's alarm schedule, and does a broken schedule fail loudly?

import assert from 'node:assert/strict'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { HobbyError } from '@hobby.sh/core'
import { nextAlarmAtMs, readObjectAlarm, readPendingAlarms } from '../src/alarms.js'
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

test('a namespace that has never run has no schedule, and that is not an error', () => {
  const root = tempRoot()
  const dir = makeNamespace(root, 'r-Room', [{ id: objectId('a') }])
  assert.deepEqual(readPendingAlarms(dir), [])
  assert.equal(nextAlarmAtMs(dir), null)
})

test('a namespace directory that does not exist at all reads as no schedule', () => {
  const root = tempRoot()
  assert.deepEqual(readPendingAlarms(join(root, 'never-created')), [])
})

test('a nanosecond scheduled_time converts to the exact millisecond it was set from', () => {
  const root = tempRoot()
  // A real millisecond value near the probe's, chosen so that the nanosecond
  // form (1.786e18) is far past Number.MAX_SAFE_INTEGER and would throw
  // ERR_OUT_OF_RANGE if it ever reached JavaScript unscaled.
  const setAt = 1786375171389
  const dir = makeNamespace(root, 'r-Room', [{ id: objectId('b'), alarmAtMs: setAt, name: 'room-alpha' }])

  const alarms = readPendingAlarms(dir)
  assert.equal(alarms.length, 1)
  const alarm = alarms[0]
  assert.ok(alarm !== undefined)
  assert.equal(alarm.scheduledAtMs, setAt)
  assert.equal(Number.isSafeInteger(alarm.scheduledAtMs), true)
  assert.equal(alarm.actorName, 'room-alpha')
  assert.equal(alarm.actorId, objectId('b'))
})

test('an object addressed without a name reads as null, not an empty string', () => {
  const root = tempRoot()
  const dir = makeNamespace(root, 'r-Room', [{ id: objectId('c'), alarmAtMs: 1786375171389, name: null }])

  const alarm = readPendingAlarms(dir)[0]
  assert.ok(alarm !== undefined)
  assert.strictEqual(alarm.actorName, null)
})

test('alarms come back earliest first, and nextAlarmAtMs is the earliest', () => {
  const root = tempRoot()
  const early = 1786375171389
  const late = 1786378771396
  const dir = makeNamespace(root, 'r-Room', [
    { id: objectId('d'), alarmAtMs: late, name: 'later' },
    { id: objectId('e'), alarmAtMs: early, name: 'sooner' },
  ])

  const alarms = readPendingAlarms(dir)
  assert.deepEqual(
    alarms.map((alarm) => alarm.actorName),
    ['sooner', 'later']
  )
  assert.equal(nextAlarmAtMs(dir), early)
})

// The two tests below are the ones ADR 0012 accepts the upstream experimental
// dependency on the strength of. A mirror that answers "no alarms pending"
// when it has actually lost the ability to read them is indistinguishable
// from a working mirror until an alarm is missed, so both of these must
// throw rather than return [].

test('a metadata.sqlite with no _cf_ALARM table throws rather than reporting no alarms', () => {
  const root = tempRoot()
  const dir = join(root, 'r-Room')
  makeBrokenAlarmDb(dir, 'CREATE TABLE something_else (id TEXT PRIMARY KEY)')

  assert.throws(
    () => readPendingAlarms(dir),
    (err: unknown) => err instanceof HobbyError && /no _cf_ALARM table/.test(err.message)
  )
})

test('an _cf_ALARM table missing actor_name throws, naming the missing column', () => {
  const root = tempRoot()
  const dir = join(root, 'r-Room')
  // The shape of the table before workerd added actor_name, which
  // alarm-scheduler.c++:62-73 migrates. A hobby that silently accepted it
  // would lose every object name from the catalog without saying so.
  makeBrokenAlarmDb(
    dir,
    'CREATE TABLE _cf_ALARM (actor_id TEXT PRIMARY KEY, scheduled_time INTEGER) WITHOUT ROWID'
  )

  assert.throws(
    () => readPendingAlarms(dir),
    (err: unknown) => err instanceof HobbyError && /actor_name/.test(err.message)
  )
})

// A pending alarm is written down twice, by two different subsystems. The
// mirror reads _cf_ALARM; this pins that the other copy says the same thing,
// so a divergence shows up here rather than as a missed wake.
//
// The first version of the research note claimed _cf_METADATA did not exist,
// on the strength of spot-checking one object file out of three. It was the
// one object deliberately given no alarm, and the table is created lazily on
// first write. Both halves of that are asserted below.
test('the object’s own alarm copy agrees with the namespace schedule', () => {
  const root = tempRoot()
  const withAlarm = objectId('a')
  const setAt = 1786375171389
  const dir = makeNamespace(root, 'r-Room', [{ id: withAlarm, alarmAtMs: setAt, name: 'room-alpha' }])

  assert.equal(readObjectAlarm(dir, withAlarm), setAt)
  assert.equal(nextAlarmAtMs(dir), setAt)
})

test('an object that has never set an alarm has no metadata table, and that reads as no alarm', () => {
  const root = tempRoot()
  const never = objectId('b')
  const dir = makeNamespace(root, 'r-Room', [{ id: never }])

  // Not a format break: ensureInitialized is documented as "not called until
  // the first write", so an absent table here is normal.
  assert.strictEqual(readObjectAlarm(dir, never), null)
})

test('an object file that does not exist reads as no alarm', () => {
  const root = tempRoot()
  const dir = makeNamespace(root, 'r-Room', [{ id: objectId('a') }])
  assert.strictEqual(readObjectAlarm(dir, objectId('z')), null)
})

test('reading does not modify the namespace it read', () => {
  const root = tempRoot()
  const dir = makeNamespace(root, 'r-Room', [{ id: objectId('f'), alarmAtMs: 1786375171389 }])

  const first = readPendingAlarms(dir)
  const second = readPendingAlarms(dir)
  assert.deepEqual(first, second)
})
