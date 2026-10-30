// One sqlite file per queue, and the only file that knows its shape.
//
// The daemon is the only writer. That is what keeps this simple: no locking
// across a container boundary, no WAL over a bind mount, no second process
// with an opinion about the schema.
//
// Milliseconds, not the nanoseconds `_cf_ALARM` stores. A queue's clock is
// ours, so it does not inherit the ERR_OUT_OF_RANGE problem that reading
// workerd's alarm table has (see @hobby.sh/do).

import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { openDatabase, type SqliteDatabase } from '@hobby.sh/core'

const SCHEMA = `
CREATE TABLE IF NOT EXISTS messages (
  id               TEXT PRIMARY KEY,
  body             TEXT NOT NULL,
  content_type     TEXT NOT NULL,
  bytes            INTEGER NOT NULL,
  enqueued_at      INTEGER NOT NULL,
  visible_at       INTEGER NOT NULL,
  attempts         INTEGER NOT NULL DEFAULT 0,
  lease_id         TEXT,
  lease_expires_at INTEGER
);
CREATE INDEX IF NOT EXISTS messages_ready ON messages (visible_at) WHERE lease_id IS NULL;
CREATE INDEX IF NOT EXISTS messages_lease ON messages (lease_expires_at) WHERE lease_id IS NOT NULL;
`

// Columns added after the first release, applied with ALTER TABLE on open so
// a queue file written by an older daemon keeps working (issue #168). Both
// are null for a message that arrived through enqueue(); only a dead letter
// (broker.ts's insertDeadLetter) sets them:
//
//   dead_lettered_at   when the message landed in THIS queue as a dead
//                      letter. Retention counts from here rather than from
//                      enqueued_at, so a message that spent most of its
//                      retention window failing in the source queue is not
//                      swept the instant it arrives.
//   failed_attempts    how many deliveries failed in the source queue before
//                      it was dead lettered. `attempts` itself restarts at 0
//                      so a consumer bound to the dead letter queue gets the
//                      usual retry budget.
const ADDED_COLUMNS: ReadonlyArray<readonly [name: string, ddl: string]> = [
  ['dead_lettered_at', 'ALTER TABLE messages ADD COLUMN dead_lettered_at INTEGER'],
  ['failed_attempts', 'ALTER TABLE messages ADD COLUMN failed_attempts INTEGER'],
]

function addMissingColumns(db: SqliteDatabase): void {
  const present = new Set(
    (db.prepare('PRAGMA table_info(messages)').all() as Array<{ name: string }>).map((row) => row.name)
  )
  for (const [name, ddl] of ADDED_COLUMNS) {
    if (!present.has(name)) {
      db.exec(ddl)
    }
  }
}

export function openQueueDb(path: string): SqliteDatabase {
  mkdirSync(dirname(path), { recursive: true })
  const db = openDatabase(path)
  db.exec(SCHEMA)
  addMissingColumns(db)
  return db
}
