// The broker: every queue semantic, and no IO beyond sqlite.
//
// It takes `nowMs` rather than reading a clock, and it never opens a second
// database. Both are what let the whole of Cloudflare's queue behaviour be
// tested with no Docker, no workerd and no timers. The impure half is tick.ts.

import { HobbyError, type SqliteDatabase } from '@hobby.sh/core'
import { newMessageId } from './ids.js'

export type ContentType = 'json' | 'text' | 'bytes' | 'v8'

export interface EnqueueInput {
  body: string
  contentType: ContentType
  delaySeconds?: number
}

// Cloudflare's, copied from miniflare's broker.worker.js:84 rather than from
// the docs, so local behaviour matches the simulator a user tests against.
export const MAX_MESSAGE_BYTES = 128000
export const MAX_BATCH_COUNT = 100
export const MAX_BATCH_BYTES = 288000
export const MAX_DELAY_SECONDS = 86400

function bodyBytes(body: string): number {
  return Buffer.byteLength(body, 'utf8')
}

// Every check runs before any insert. A batch that is half accepted is worse
// than one that is refused: the caller's `sendBatch` contract is all or
// nothing, and a partial success has no way to be reported through it.
export function enqueue(db: SqliteDatabase, inputs: EnqueueInput[], nowMs: number): string[] {
  if (inputs.length > MAX_BATCH_COUNT) {
    throw new HobbyError(
      'usage',
      `a batch holds at most ${MAX_BATCH_COUNT} messages, got ${inputs.length}`,
      'send fewer messages per call'
    )
  }

  let total = 0
  for (const input of inputs) {
    const bytes = bodyBytes(input.body)
    if (bytes > MAX_MESSAGE_BYTES) {
      throw new HobbyError(
        'usage',
        `a message is at most ${MAX_MESSAGE_BYTES} bytes, got ${bytes}`,
        'send a reference instead of the payload, or split the work'
      )
    }
    total += bytes
    const delay = input.delaySeconds ?? 0
    if (!Number.isInteger(delay) || delay < 0 || delay > MAX_DELAY_SECONDS) {
      throw new HobbyError(
        'usage',
        `delaySeconds must be a whole number from 0 to ${MAX_DELAY_SECONDS}, got ${String(delay)}`,
        'use a scheduled worker for anything longer'
      )
    }
  }
  if (total > MAX_BATCH_BYTES) {
    throw new HobbyError(
      'usage',
      `a batch is at most ${MAX_BATCH_BYTES} bytes, got ${total}`,
      'send fewer messages per call'
    )
  }

  const insert = db.prepare(
    'INSERT INTO messages (id, body, content_type, bytes, enqueued_at, visible_at, attempts) VALUES (?, ?, ?, ?, ?, ?, 0)'
  )
  const ids: string[] = []
  for (const input of inputs) {
    const id = newMessageId(nowMs)
    insert.run(
      id,
      input.body,
      input.contentType,
      bodyBytes(input.body),
      nowMs,
      nowMs + (input.delaySeconds ?? 0) * 1000
    )
    ids.push(id)
  }
  return ids
}

export function depth(db: SqliteDatabase): number {
  const row = db.prepare('SELECT count(*) AS n FROM messages').get() as { n: number }
  return row.n
}

export interface ConsumerOptions {
  maxBatchSize: number
  maxBatchTimeoutSeconds: number
  maxRetries: number
  retryDelaySeconds: number
  deadLetterQueue: string | null
}

// miniflare's DEFAULT_BATCH_SIZE, DEFAULT_BATCH_TIMEOUT and DEFAULT_RETRIES,
// so a worker behaves here the way it behaves under `wrangler dev`.
export const DEFAULT_CONSUMER_OPTIONS: ConsumerOptions = {
  maxBatchSize: 5,
  maxBatchTimeoutSeconds: 1,
  maxRetries: 2,
  retryDelaySeconds: 0,
  deadLetterQueue: null,
}

export interface LeasedMessage {
  id: string
  body: string
  contentType: ContentType
  timestampMs: number
  attempts: number
}

export interface LeasedBatch {
  leaseId: string
  messages: LeasedMessage[]
  backlogCount: number
  backlogBytes: number
  oldestMessageTimestampMs: number | null
}

// How long a consumer has to answer before the batch is assumed lost. Longer
// than any reasonable handler, because the cost of expiring too early is a
// duplicate delivery of work that may already have happened.
export const LEASE_MS = 60000

interface ReadyRow {
  id: string
  body: string
  content_type: string
  timestamp: number
  attempts: number
}

function readyRows(db: SqliteDatabase, nowMs: number, limit: number): ReadyRow[] {
  return db
    .prepare(
      `SELECT id, body, content_type, enqueued_at AS timestamp, attempts
         FROM messages
        WHERE lease_id IS NULL AND visible_at <= ?
        ORDER BY id
        LIMIT ?`
    )
    .all(nowMs, limit) as ReadyRow[]
}

export function isBatchReady(db: SqliteDatabase, opts: ConsumerOptions, nowMs: number): boolean {
  const row = db
    .prepare(
      `SELECT count(*) AS n, min(visible_at) AS oldest
         FROM messages
        WHERE lease_id IS NULL AND visible_at <= ?`
    )
    .get(nowMs) as { n: number; oldest: number | null }
  if (row.n === 0) return false
  if (row.n >= opts.maxBatchSize) return true
  if (row.oldest === null) return false
  return nowMs - row.oldest >= opts.maxBatchTimeoutSeconds * 1000
}

export function leaseBatch(
  db: SqliteDatabase,
  opts: ConsumerOptions,
  nowMs: number,
  leaseMs: number = LEASE_MS
): LeasedBatch | null {
  const rows = readyRows(db, nowMs, opts.maxBatchSize)
  if (rows.length === 0) return null

  const leaseId = newMessageId(nowMs)
  const claim = db.prepare(
    'UPDATE messages SET lease_id = ?, lease_expires_at = ?, attempts = attempts + 1 WHERE id = ?'
  )
  for (const row of rows) {
    claim.run(leaseId, nowMs + leaseMs, row.id)
  }

  // Read AFTER the claim, so the metrics describe what is still waiting
  // rather than counting the batch we are about to deliver.
  const backlog = db
    .prepare(
      `SELECT count(*) AS n, coalesce(sum(bytes), 0) AS bytes, min(enqueued_at) AS oldest
         FROM messages
        WHERE lease_id IS NULL`
    )
    .get() as { n: number; bytes: number; oldest: number | null }

  return {
    leaseId,
    messages: rows.map((row) => ({
      id: row.id,
      body: row.body,
      contentType: row.content_type as ContentType,
      timestampMs: row.timestamp,
      // Incremented by the claim above, so the value delivered is the number
      // of attempts INCLUDING this one. Cloudflare documents attempts as
      // starting at 1 on the first delivery, which is exactly this.
      attempts: row.attempts + 1,
    })),
    backlogCount: backlog.n,
    backlogBytes: backlog.bytes,
    oldestMessageTimestampMs: backlog.oldest,
  }
}

export function hasOutstandingLease(db: SqliteDatabase, nowMs: number): boolean {
  const row = db
    .prepare('SELECT count(*) AS n FROM messages WHERE lease_id IS NOT NULL AND lease_expires_at > ?')
    .get(nowMs) as { n: number }
  return row.n > 0
}
