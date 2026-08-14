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

export interface DeliveryResult {
  outcome: 'ok' | 'exception'
  retryBatch: { retry: boolean; delaySeconds?: number }
  retryMessages: Array<{ msgId: string; delaySeconds?: number }>
}

export interface ApplyOutcome {
  acked: number
  retried: number
  // Returned rather than written: this module owns one database and the dead
  // letter queue is a different one. The tick routes them.
  deadLettered: LeasedMessage[]
}

interface LeasedRow {
  id: string
  body: string
  content_type: string
  timestamp: number
  attempts: number
}

export function applyResult(
  db: SqliteDatabase,
  leaseId: string,
  result: DeliveryResult,
  opts: ConsumerOptions,
  nowMs: number,
  onDeadLetter?: (message: LeasedMessage) => void
): ApplyOutcome {
  const rows = db
    .prepare(
      `SELECT id, body, content_type, enqueued_at AS timestamp, attempts
         FROM messages
        WHERE lease_id = ?
        ORDER BY id`
    )
    .all(leaseId) as LeasedRow[]
  if (rows.length === 0) {
    return { acked: 0, retried: 0, deadLettered: [] }
  }

  // An outcome that is not `ok` retries everything, matching
  // broker.worker.js:250. A handler that threw told us nothing about which
  // messages it got through.
  const retryAll = result.retryBatch.retry || result.outcome !== 'ok'
  const perMessage = new Map(result.retryMessages.map((entry) => [entry.msgId, entry.delaySeconds]))

  const requeue = db.prepare(
    'UPDATE messages SET lease_id = NULL, lease_expires_at = NULL, visible_at = ? WHERE id = ?'
  )
  const remove = db.prepare('DELETE FROM messages WHERE id = ?')

  let acked = 0
  let retried = 0
  const deadLettered: LeasedMessage[] = []

  // Wrap writes in an explicit transaction. This covers only this database:
  // the dead letter queue is separate and cannot join this transaction, so
  // finding 2's fix is the ordering below (callback before delete), not the
  // transaction.
  db.exec('BEGIN')
  try {
    for (const row of rows) {
      const isRetry = retryAll || perMessage.has(row.id)
      if (!isRetry) {
        remove.run(row.id)
        acked += 1
        continue
      }

      // attempts was incremented at lease time, so it already counts the
      // delivery that just failed.
      if (row.attempts > opts.maxRetries) {
        const message: LeasedMessage = {
          id: row.id,
          body: row.body,
          contentType: row.content_type as ContentType,
          timestampMs: row.timestamp,
          attempts: row.attempts,
        }
        deadLettered.push(message)
        // Call the callback before deleting, inside the transaction. The dead
        // letter queue is a different database and cannot join this
        // transaction, so the ordering is the guarantee: writing to the dead
        // letter queue before deleting from here turns a possible loss into a
        // possible duplicate. At-least-once delivery is already this queue's
        // contract (Cloudflare's too), so a duplicate is acceptable and a loss
        // is not.
        if (onDeadLetter) {
          onDeadLetter(message)
        }
        remove.run(row.id)
        continue
      }

      const delaySeconds =
        perMessage.get(row.id) ?? result.retryBatch.delaySeconds ?? opts.retryDelaySeconds
      requeue.run(nowMs + delaySeconds * 1000, row.id)
      retried += 1
    }
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }

  return { acked, retried, deadLettered }
}

// Cloudflare's own bounds: four days by default, settable from 60 seconds to
// 14 days (`wrangler queues update --message-retention-period-secs`).
export const DEFAULT_RETENTION_SECONDS = 345600
export const MIN_RETENTION_SECONDS = 60
export const MAX_RETENTION_SECONDS = 1209600

// A lease that ran out means the consumer never answered: it crashed, it was
// slept, or the daemon restarted mid-batch. The attempt was counted when the
// batch went out, so this only decides between another try and the dead
// letter queue. Counting here instead would let a crash loop retry forever.
export function expireLeases(
  db: SqliteDatabase,
  opts: ConsumerOptions,
  nowMs: number,
  onDeadLetter?: (message: LeasedMessage) => void
): { requeued: number; deadLettered: LeasedMessage[] } {
  const rows = db
    .prepare(
      `SELECT id, body, content_type, enqueued_at AS timestamp, attempts
         FROM messages
        WHERE lease_id IS NOT NULL AND lease_expires_at <= ?`
    )
    .all(nowMs) as LeasedRow[]

  if (rows.length === 0) {
    return { requeued: 0, deadLettered: [] }
  }

  const requeue = db.prepare(
    'UPDATE messages SET lease_id = NULL, lease_expires_at = NULL, visible_at = ? WHERE id = ?'
  )
  const remove = db.prepare('DELETE FROM messages WHERE id = ?')

  let requeued = 0
  const deadLettered: LeasedMessage[] = []

  db.exec('BEGIN')
  try {
    for (const row of rows) {
      if (row.attempts > opts.maxRetries) {
        const message: LeasedMessage = {
          id: row.id,
          body: row.body,
          contentType: row.content_type as ContentType,
          timestampMs: row.timestamp,
          attempts: row.attempts,
        }
        deadLettered.push(message)
        // Call the callback before deleting, inside the transaction. The dead
        // letter queue is a different database and cannot join this
        // transaction, so the ordering is the guarantee: writing to the dead
        // letter queue before deleting from here turns a possible loss into a
        // possible duplicate. At-least-once delivery is already this queue's
        // contract (Cloudflare's too), so a duplicate is acceptable and a loss
        // is not.
        if (onDeadLetter) {
          onDeadLetter(message)
        }
        remove.run(row.id)
        continue
      }
      requeue.run(nowMs, row.id)
      requeued += 1
    }
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }

  return { requeued, deadLettered }
}

// Returns the count so the tick can log it. A queue that silently drops what
// it holds is a queue that lies about its depth.
export function sweepRetention(db: SqliteDatabase, retentionSeconds: number, nowMs: number): number {
  const cutoff = nowMs - retentionSeconds * 1000
  const doomed = db
    .prepare('SELECT count(*) AS n FROM messages WHERE enqueued_at <= ?')
    .get(cutoff) as { n: number }
  if (doomed.n === 0) return 0
  db.prepare('DELETE FROM messages WHERE enqueued_at <= ?').run(cutoff)
  return doomed.n
}

export function peek(db: SqliteDatabase, limit: number): LeasedMessage[] {
  const rows = db
    .prepare(
      `SELECT id, body, content_type, enqueued_at AS timestamp, attempts
         FROM messages
        ORDER BY id
        LIMIT ?`
    )
    .all(limit) as LeasedRow[]
  return rows.map((row) => ({
    id: row.id,
    body: row.body,
    contentType: row.content_type as ContentType,
    timestampMs: row.timestamp,
    attempts: row.attempts,
  }))
}

export function purge(db: SqliteDatabase): number {
  const before = depth(db)
  db.exec('DELETE FROM messages')
  return before
}
