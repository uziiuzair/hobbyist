import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import {
  DEFAULT_CONSUMER_OPTIONS,
  DEFAULT_RETENTION_SECONDS,
  depth,
  enqueue,
  expireLeases,
  leaseBatch,
  peek,
  purge,
  sweepRetention,
} from '../src/broker.js'
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
