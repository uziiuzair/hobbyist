// Real SQLite files in a temp directory, laid out exactly the way workerd
// lays them out, built from the schema in alarm-scheduler.c++:55.
//
// Not mocks. A mocked database would have accepted a nanosecond value as a
// JavaScript number without complaint, and the whole reason alarms.ts divides
// in SQL is that node:sqlite refuses to: 1.79e18 is far past
// Number.MAX_SAFE_INTEGER. That bug is invisible to a fake and obvious to a
// real file, which is the argument for these fixtures existing at all.

import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '@hobby.sh/core'

// Verbatim from src/workerd/server/alarm-scheduler.c++:55. If this ever needs
// editing to make a test pass, the thing that changed is upstream, and
// docs/durable-objects/research/2026-08-10-alarms-are-readable-from-outside.md
// is the file to update first.
export const ALARM_SCHEMA = `
  CREATE TABLE IF NOT EXISTS _cf_ALARM (
    actor_id TEXT PRIMARY KEY,
    scheduled_time INTEGER,
    actor_name TEXT
  ) WITHOUT ROWID;
`

// 64 lowercase hex characters, the shape workerd renders an actor id in.
export function objectId(seed: string): string {
  const body = seed.repeat(64).slice(0, 64)
  return [...body].map((char) => (/[0-9a-f]/.test(char) ? char : 'a')).join('')
}

export interface FixtureObject {
  id: string
  alarmAtMs?: number
  name?: string | null
  // Emit the -wal and -shm sidecars workerd may leave beside a database.
  sidecars?: boolean
}

export function makeTempRoot(): string {
  return mkdtempSync(join(tmpdir(), 'hobby-do-'))
}

// Nanoseconds as a decimal literal, six zeros appended to the millisecond
// count. It cannot be a bound parameter and it cannot be computed in SQL from
// one: node:sqlite binds as a double, and 1786375171389000000 has 19
// significant digits where a double holds about 16, so `? * 1000000` stores
// 1786375171388999936 and every assertion comes back one millisecond low.
// workerd computes in int64 and never rounds, so a fixture that reproduced the
// rounding would be testing a database workerd never writes.
export function nanosecondLiteral(alarmAtMs: number): string {
  if (!Number.isSafeInteger(alarmAtMs)) {
    throw new Error(`alarmAtMs ${alarmAtMs} is not a safe integer millisecond value`)
  }
  return `${alarmAtMs}000000`
}

// One namespace directory: an object file per entry, plus a metadata.sqlite
// holding rows for those with alarms. Returns the namespace directory.
export function makeNamespace(doRoot: string, uniqueKey: string, objects: FixtureObject[]): string {
  const namespaceDir = join(doRoot, uniqueKey)
  mkdirSync(namespaceDir, { recursive: true })

  for (const object of objects) {
    const db = openDatabase(join(namespaceDir, `${object.id}.sqlite`))
    try {
      // A user table, because that is what a real object file contains
      // alongside workerd's own. Objects with an alarm also carry
      // _cf_METADATA; writeObjectAlarm below adds it for those that need it.
      db.exec('CREATE TABLE IF NOT EXISTS app_data (id INTEGER PRIMARY KEY, body TEXT)')
      db.prepare('INSERT INTO app_data (body) VALUES (?)').run('x')

      // Real object files carry ActorSqlite's own copy of the alarm too, and
      // only when one has been set: _cf_METADATA is created lazily on first
      // write. Reproducing that laziness is the point. A fixture that created
      // the table unconditionally would have hidden the sampling error that
      // produced the first, wrong version of the research note.
      if (object.alarmAtMs !== undefined) {
        db.exec('CREATE TABLE IF NOT EXISTS _cf_METADATA (key INTEGER PRIMARY KEY, value BLOB)')
        db.exec(`INSERT INTO _cf_METADATA VALUES (1, ${nanosecondLiteral(object.alarmAtMs)})`)
      }
    } finally {
      db.close()
    }
    if (object.sidecars === true) {
      writeFileSync(join(namespaceDir, `${object.id}.sqlite-wal`), '')
      writeFileSync(join(namespaceDir, `${object.id}.sqlite-shm`), '')
    }
  }

  const withAlarms = objects.filter((object) => object.alarmAtMs !== undefined)
  if (withAlarms.length > 0) {
    writeAlarms(namespaceDir, withAlarms)
  }

  return namespaceDir
}

export function writeAlarms(namespaceDir: string, objects: FixtureObject[]): void {
  const db = openDatabase(join(namespaceDir, 'metadata.sqlite'))
  try {
    db.exec(ALARM_SCHEMA)
    for (const object of objects) {
      if (object.alarmAtMs === undefined) {
        continue
      }
      // Digits only, so this is not string-built SQL in the injectable sense.
      // See nanosecondLiteral for why it cannot be a bound parameter.
      db.prepare(
        `INSERT INTO _cf_ALARM (actor_id, scheduled_time, actor_name) VALUES (?, ${nanosecondLiteral(object.alarmAtMs)}, ?)`
      ).run(object.id, object.name ?? null)
    }
  } finally {
    db.close()
  }
}

// A metadata.sqlite that exists but is not the table we expect, for the tests
// that pin "loud failure, never an empty result".
export function makeBrokenAlarmDb(namespaceDir: string, sql: string): void {
  mkdirSync(namespaceDir, { recursive: true })
  const db = openDatabase(join(namespaceDir, 'metadata.sqlite'))
  try {
    db.exec(sql)
  } finally {
    db.close()
  }
}
