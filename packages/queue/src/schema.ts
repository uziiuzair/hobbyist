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

export function openQueueDb(path: string): SqliteDatabase {
  mkdirSync(dirname(path), { recursive: true })
  const db = openDatabase(path)
  db.exec(SCHEMA)
  return db
}
