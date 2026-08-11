// Reading a Durable Object namespace's alarm schedule while its runtime is
// stopped. This is the whole reason @hobby.sh/do exists: a stopped process has
// no timer, so if nothing outside the runtime knows the deadlines, a namespace
// either never sleeps or misses its alarms, and both of those lose the wedge.
//
// The schedule is workerd's, not ours. src/workerd/server/server.c++:404-408
// creates one AlarmScheduler per namespace "backed by on-disk storage in the
// namespace directory", and alarm-scheduler.c++:55 declares the table this
// file reads. Because workerd reloads and reschedules every row in that
// scheduler's constructor (alarm-scheduler.c++:86-99), being awake at the
// deadline is sufficient; we never fire an alarm ourselves.
//
// Evidence for every claim here, including the probe that produced it, is in
// docs/durable-objects/research/2026-08-10-alarms-are-readable-from-outside.md.

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { HobbyError, openDatabaseReadOnly } from '@hobby.sh/core'

// Named by workerd, not by us. server.c++:408 passes kj::Path({"metadata.sqlite"}).
export const ALARM_DB_FILENAME = 'metadata.sqlite'

const ALARM_TABLE = '_cf_ALARM'
const REQUIRED_COLUMNS = ['actor_id', 'scheduled_time', 'actor_name'] as const

// The division is not a nicety, it is the only way this query can be run from
// JavaScript at all. scheduled_time is int64 NANOSECONDS since the Unix epoch
// (alarm-scheduler.c++:91), which for any real date is around 1.79e18, and
// Number.MAX_SAFE_INTEGER is 9.007e15. node:sqlite does not silently round it:
// it throws ERR_OUT_OF_RANGE, "Value is too large to be represented as a
// JavaScript number". Dividing in SQLite keeps the value an integer on the C
// side and hands JavaScript a millisecond count that is comfortably safe.
//
// Integer division truncates, so a deadline can land at most 1ms early. For a
// wake that is the harmless direction, and alarms are set from Date.now() in
// milliseconds anyway, so in practice the nanosecond field is always an exact
// multiple of 1e6.
const SELECT_ALARMS = `
  SELECT actor_id, scheduled_time / 1000000 AS scheduled_at_ms, actor_name
  FROM ${ALARM_TABLE}
`

// The per-object copy, written by ActorSqlite rather than by AlarmScheduler.
// Key 1 is the alarm time; key 2 is a local-development bookmark for D1 and is
// none of our business. Same nanosecond problem, same fix.
const OBJECT_METADATA_TABLE = '_cf_METADATA'
const OBJECT_SUFFIX = '.sqlite'
const SELECT_OBJECT_ALARM = `
  SELECT value / 1000000 AS scheduled_at_ms FROM ${OBJECT_METADATA_TABLE} WHERE key = 1
`

export interface PendingAlarm {
  // 64 lowercase hex characters. Also the basename of the object's own
  // <id>.sqlite file in the same directory.
  actorId: string
  // The name passed to idFromName(), when there was one. workerd persists it
  // so that ctx.id.name works inside an alarm handler (actor-id-impl.h, on
  // idFromStringNamed), and this table is the only place it is written down.
  // An object addressed by raw id, or one that has never set an alarm, has no
  // recoverable name: idFromName is an HMAC and does not reverse.
  actorName: string | null
  scheduledAtMs: number
}

interface AlarmRow {
  actor_id: string
  scheduled_at_ms: number
  actor_name: string | null
}

interface ColumnRow {
  name: string
}

// The difference between "nothing is scheduled" and "we can no longer read the
// schedule" is the difference between a working mirror and one that silently
// never wakes anything, and those two look identical from the outside until
// the day an alarm is missed. ADR 0012 accepts a dependency on an interface
// workerd marks "** EXPERIMENTAL; SUBJECT TO BACKWARDS-INCOMPATIBLE CHANGE **"
// (workerd.capnp:723) specifically on the condition that a break is loud, and
// this function is that condition.
//
// PRAGMA table_info on a table that does not exist returns zero rows rather
// than raising, so a missing table and a renamed one arrive here the same way.
function assertAlarmSchema(
  db: { prepare(sql: string): { all(...params: unknown[]): unknown[] } },
  dbPath: string
): void {
  const columns = db.prepare(`PRAGMA table_info(${ALARM_TABLE})`).all() as ColumnRow[]
  if (columns.length === 0) {
    throw new HobbyError(
      'internal',
      `${dbPath} exists but has no ${ALARM_TABLE} table, so pending alarms cannot be read`,
      'The workerd on-disk alarm format has probably changed. Check the miniflare version against docs/durable-objects/research/2026-08-10-alarms-are-readable-from-outside.md before assuming no alarms are set.'
    )
  }

  const present = new Set(columns.map((column) => column.name))
  const missing = REQUIRED_COLUMNS.filter((column) => !present.has(column))
  if (missing.length > 0) {
    throw new HobbyError(
      'internal',
      `${dbPath} has a ${ALARM_TABLE} table missing ${missing.join(', ')}`,
      'The workerd on-disk alarm format has probably changed. See docs/durable-objects/research/2026-08-10-alarms-are-readable-from-outside.md.'
    )
  }
}

// Every pending alarm in one namespace, earliest first.
//
// Read only, always. Opening a WAL database read-write can create sidecar
// files and checkpoint the log, which would mean the act of observing a
// sleeping namespace modified it. Verified against a Miniflare-written
// database with live -wal and -shm sidecars: a read-only open reads current
// rows without touching them.
//
// A namespace directory with no metadata.sqlite has never run and has no
// schedule. That is an empty result, not a failure.
export function readPendingAlarms(namespaceDir: string): PendingAlarm[] {
  const dbPath = join(namespaceDir, ALARM_DB_FILENAME)
  if (!existsSync(dbPath)) {
    return []
  }

  const db = openDatabaseReadOnly(dbPath)
  try {
    assertAlarmSchema(db, dbPath)
    const rows = db.prepare(SELECT_ALARMS).all() as AlarmRow[]
    return rows
      .map((row) => ({
        actorId: row.actor_id,
        // SQLite NULL arrives as null on both runtimes for a column value
        // (the undefined-versus-null divergence core/sqlite.ts normalises is
        // about a missing *row*, not a null field), but ?? pins it either way
        // rather than letting an empty string or undefined through as a name.
        actorName: row.actor_name ?? null,
        scheduledAtMs: row.scheduled_at_ms,
      }))
      .sort((a, b) => a.scheduledAtMs - b.scheduledAtMs)
  } finally {
    db.close()
  }
}

// The earliest deadline in a namespace, or null when nothing is scheduled.
// This is what the sleep predicate and the mirror both actually want; neither
// cares which object owns it.
export function nextAlarmAtMs(namespaceDir: string): number | null {
  const alarms = readPendingAlarms(namespaceDir)
  return alarms[0]?.scheduledAtMs ?? null
}

// The object's own copy of its alarm.
//
// A pending alarm is written down twice: here, by ActorSqlite
// (sqlite-metadata.h, "Durable Object alarm times (hardcoded as key = 1)"),
// and in the namespace's _cf_ALARM, by AlarmScheduler. They agree, and
// alarms.test.ts pins that they do.
//
// The mirror reads _cf_ALARM rather than this, for three reasons: it is the
// copy AlarmScheduler's constructor reloads and therefore the one that decides
// whether a restarted runtime fires anything (alarm-scheduler.c++:86-99); it is
// one file per namespace instead of one per object, which matters at ten
// thousand objects; and it is the only place an object's human name exists.
//
// This function is here for the catalog, for a single-object lookup, and as
// the cross-check. If the two ever disagree, the earlier deadline is the safe
// one: waking early costs a cold start, waking late misses an alarm.
export function readObjectAlarm(namespaceDir: string, actorId: string): number | null {
  const dbPath = join(namespaceDir, `${actorId}${OBJECT_SUFFIX}`)
  if (!existsSync(dbPath)) {
    return null
  }

  const db = openDatabaseReadOnly(dbPath)
  try {
    // Absent table, absent row and NULL value all mean no alarm, exactly as
    // getAlarmUncached treats them (sqlite-metadata.c++:36-45). Unlike
    // _cf_ALARM this table is genuinely optional: ensureInitialized creates it
    // lazily, "not called until the first write", so an object that has never
    // set an alarm has no table and that is normal rather than a format break.
    const columns = db.prepare(`PRAGMA table_info(${OBJECT_METADATA_TABLE})`).all()
    if (columns.length === 0) {
      return null
    }
    const row = db.prepare(SELECT_OBJECT_ALARM).get() as { scheduled_at_ms: number | null } | undefined
    return row?.scheduled_at_ms ?? null
  } finally {
    db.close()
  }
}
