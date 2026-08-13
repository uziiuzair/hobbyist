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
