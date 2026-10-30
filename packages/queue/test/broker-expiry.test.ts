import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { openDatabase } from '@hobby.sh/core'
import {
  DEFAULT_CONSUMER_OPTIONS,
  DEFAULT_RETENTION_SECONDS,
  depth,
  enqueue,
  expireLeases,
  insertDeadLetter,
  leaseBatch,
  peek,
  purge,
  sweepRetention,
} from '../src/broker.js'
import { openQueueDb } from '../src/schema.js'
import { NOW, cleanupQueues, json, tempQueue } from './fixtures.js'

after(cleanupQueues)

const OPTS = DEFAULT_CONSUMER_OPTIONS

test('an expired lease makes the message visible again', () => {
  const db = tempQueue()
  enqueue(db, [json({ a: 1 })], NOW)
  leaseBatch(db, OPTS, NOW, 60000)
  const result = expireLeases(db, OPTS, NOW + 60001)
  assert.equal(result.requeued, 1)
  assert.equal(depth(db), 1)
})

test('an unexpired lease is left alone', () => {
  const db = tempQueue()
  enqueue(db, [json({ a: 1 })], NOW)
  leaseBatch(db, OPTS, NOW, 60000)
  assert.equal(expireLeases(db, OPTS, NOW + 59999).requeued, 0)
})

test('expiry does not increment attempts, because leasing already did', () => {
  const db = tempQueue()
  enqueue(db, [json({ a: 1 })], NOW)
  leaseBatch(db, OPTS, NOW, 60000)
  expireLeases(db, OPTS, NOW + 60001)
  const row = db.prepare('SELECT attempts FROM messages').get() as { attempts: number }
  assert.equal(row.attempts, 1)
})

test('a consumer that keeps dying still reaches the dead letter queue', () => {
  const db = tempQueue()
  enqueue(db, [json({ a: 1 })], NOW)
  let dead = 0
  for (let round = 0; round < 5; round += 1) {
    const at = NOW + round * 100000
    if (leaseBatch(db, OPTS, at, 60000) === null) break
    dead += expireLeases(db, OPTS, at + 60001).deadLettered.length
  }
  assert.equal(dead, 1)
  assert.equal(depth(db), 0)
})

test('retention deletes by age and reports how many', () => {
  const db = tempQueue()
  enqueue(db, [json({ old: true })], NOW)
  enqueue(db, [json({ fresh: true })], NOW + DEFAULT_RETENTION_SECONDS * 1000)
  const swept = sweepRetention(db, DEFAULT_RETENTION_SECONDS, NOW + DEFAULT_RETENTION_SECONDS * 1000 + 1)
  assert.equal(swept, 1)
  assert.equal(depth(db), 1)
})

test('the default retention is four days, the same as Cloudflare', () => {
  assert.equal(DEFAULT_RETENTION_SECONDS, 345600)
})

test('peek reads oldest first without leasing anything', () => {
  const db = tempQueue()
  enqueue(db, [json({ a: 1 }), json({ a: 2 }), json({ a: 3 })], NOW)
  const seen = peek(db, 2)
  assert.equal(seen.length, 2)
  assert.equal(seen[0]?.attempts, 0)
  assert.equal(leaseBatch(db, OPTS, NOW + 2000)?.messages.length, 3)
})

test('purge empties the queue and reports the count', () => {
  const db = tempQueue()
  enqueue(db, [json({ a: 1 }), json({ a: 2 })], NOW)
  assert.equal(purge(db), 2)
  assert.equal(depth(db), 0)
})

test('onDeadLetter fires for a lease that expires past maxRetries, and the row is queryable inside the callback', () => {
  const db = tempQueue()
  enqueue(db, [json({ a: 1 })], NOW)
  let capturedId: string | undefined
  for (let round = 0; round < 5; round += 1) {
    const at = NOW + round * 100000
    if (leaseBatch(db, OPTS, at, 60000) === null) break
    expireLeases(db, OPTS, at + 60001, (message) => {
      // Verify the row is still in the database inside the callback
      const row = db.prepare('SELECT id FROM messages WHERE id = ?').get(message.id) as
        | { id: string }
        | undefined
      assert.ok(row, 'message should be queryable inside onDeadLetter callback')
      capturedId = message.id
    })
  }
  assert.ok(capturedId, 'onDeadLetter should have been called')
})

test('a throwing onDeadLetter leaves the row in place', () => {
  const db = tempQueue()
  enqueue(db, [json({ a: 1 })], NOW)
  const initialDepth = depth(db)
  let errorThrown = false
  try {
    for (let round = 0; round < 5; round += 1) {
      const at = NOW + round * 100000
      if (leaseBatch(db, OPTS, at, 60000) === null) break
      expireLeases(db, OPTS, at + 60001, () => {
        throw new Error('callback error')
      })
    }
  } catch (e) {
    errorThrown = true
    assert.ok(e instanceof Error)
    assert.equal((e as Error).message, 'callback error')
  }
  assert.ok(errorThrown, 'error should have been thrown')
  assert.equal(depth(db), initialDepth, 'depth should be unchanged after rollback')
})

test('a message exactly at the retention cutoff is swept, because the comparison is inclusive', () => {
  const db = tempQueue()
  enqueue(db, [json({ old: true })], NOW)
  const swept = sweepRetention(db, DEFAULT_RETENTION_SECONDS, NOW + DEFAULT_RETENTION_SECONDS * 1000)
  assert.equal(swept, 1)
  assert.equal(depth(db), 0)
})

test('peek returns messages in insertion order by comparing the decoded bodies', () => {
  const db = tempQueue()
  enqueue(
    db,
    [json({ order: 'first' }), json({ order: 'second' }), json({ order: 'third' })],
    NOW
  )
  const seen = peek(db, 3)
  assert.equal(seen.length, 3)
  const first = seen[0]
  const second = seen[1]
  const third = seen[2]
  assert.ok(first !== undefined)
  assert.ok(second !== undefined)
  assert.ok(third !== undefined)
  const firstBody = JSON.parse(first.body)
  const secondBody = JSON.parse(second.body)
  const thirdBody = JSON.parse(third.body)
  assert.equal(firstBody.order, 'first')
  assert.equal(secondBody.order, 'second')
  assert.equal(thirdBody.order, 'third')
})

// Issue #170: peek says what each message is doing, so a leased or delayed
// message is not mistaken for one that is simply waiting.
test('peek marks a leased message, a delayed message and a ready one', () => {
  const db = tempQueue()
  enqueue(db, [json({ a: 1 })], NOW)
  enqueue(db, [{ ...json({ b: 2 }), delaySeconds: 30 }], NOW)
  enqueue(db, [json({ c: 3 })], NOW)
  // Leases the first ready message only (the delayed one is not ready).
  leaseBatch(db, { ...OPTS, maxBatchSize: 1 }, NOW, 60000)

  const rows = peek(db, 10, NOW + 1000)
  assert.equal(rows.length, 3)
  assert.equal(rows[0]?.state, 'leased')
  assert.equal(rows[1]?.state, 'delayed')
  assert.equal(rows[1]?.visibleAtMs, NOW + 30_000)
  assert.equal(rows[2]?.state, 'ready')
  // A lease that has run out reads as ready: it will be the moment
  // expireLeases runs.
  assert.equal(peek(db, 1, NOW + 60_001)[0]?.state, 'ready')
  // Not a dead letter, so no provenance.
  assert.equal(rows[0]?.deadLetteredAtMs, null)
  assert.equal(rows[0]?.failedAttempts, null)
})

// Issue #168: writing the same dead letter twice (a crash between the dead
// letter write and the source delete) is a no-op, never a constraint error.
test('insertDeadLetter keeps the id and is idempotent on a repeat', () => {
  const db = tempQueue()
  const message = { id: 'FIXEDID00000000000000000000', body: '"x"', contentType: 'json' as const, timestampMs: NOW, attempts: 3 }
  insertDeadLetter(db, message, NOW + 5000)
  insertDeadLetter(db, message, NOW + 6000)
  assert.equal(depth(db), 1)
  const [row] = peek(db, 1, NOW + 7000)
  assert.equal(row?.id, message.id)
  assert.equal(row?.failedAttempts, 3)
  assert.equal(row?.attempts, 0)
  assert.equal(row?.deadLetteredAtMs, NOW + 5000, 'the first landing wins')
  assert.equal(row?.timestampMs, NOW)
})

test('a queue file written before the dead letter columns existed is migrated on open', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'hobby-queue-old-')), 'q.sqlite')
  const old = openDatabase(path)
  old.exec(`CREATE TABLE messages (
    id TEXT PRIMARY KEY, body TEXT NOT NULL, content_type TEXT NOT NULL, bytes INTEGER NOT NULL,
    enqueued_at INTEGER NOT NULL, visible_at INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
    lease_id TEXT, lease_expires_at INTEGER)`)
  old.prepare(
    'INSERT INTO messages (id, body, content_type, bytes, enqueued_at, visible_at, attempts) VALUES (?, ?, ?, ?, ?, ?, 0)'
  ).run('OLDID0000000000000000000000', '"x"', 'json', 3, NOW, NOW)
  old.close()

  const db = openQueueDb(path)
  const [row] = peek(db, 1, NOW)
  assert.equal(row?.id, 'OLDID0000000000000000000000')
  assert.equal(row?.deadLetteredAtMs, null)
  assert.equal(sweepRetention(db, 60, NOW + 61_000), 1, 'retention still works on a migrated file')
  db.close()
})
