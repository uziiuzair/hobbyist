import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import {
  DEFAULT_CONSUMER_OPTIONS,
  applyResult,
  depth,
  enqueue,
  leaseBatch,
  type DeliveryResult,
} from '../src/broker.js'
import { NOW, cleanupQueues, json, tempQueue } from './fixtures.js'

after(cleanupQueues)

const OPTS = DEFAULT_CONSUMER_OPTIONS
const OK: DeliveryResult = { outcome: 'ok', retryBatch: { retry: false }, retryMessages: [] }

test('a clean result deletes every message in the batch', () => {
  const db = tempQueue()
  enqueue(db, [json({ a: 1 }), json({ a: 2 })], NOW)
  const batch = leaseBatch(db, OPTS, NOW + 2000)
  assert.ok(batch !== null)
  const outcome = applyResult(db, batch.leaseId, OK, OPTS, NOW + 2100)
  assert.equal(outcome.acked, 2)
  assert.equal(depth(db), 0)
})

test('retryAll requeues the whole batch', () => {
  const db = tempQueue()
  enqueue(db, [json({ a: 1 }), json({ a: 2 })], NOW)
  const batch = leaseBatch(db, OPTS, NOW + 2000)
  assert.ok(batch !== null)
  const outcome = applyResult(
    db,
    batch.leaseId,
    { outcome: 'ok', retryBatch: { retry: true }, retryMessages: [] },
    OPTS,
    NOW + 2100
  )
  assert.equal(outcome.retried, 2)
  assert.equal(depth(db), 2)
})

test('an exception retries the whole batch even with no explicit retry', () => {
  const db = tempQueue()
  enqueue(db, [json({ a: 1 })], NOW)
  const batch = leaseBatch(db, OPTS, NOW + 2000)
  assert.ok(batch !== null)
  const outcome = applyResult(
    db,
    batch.leaseId,
    { outcome: 'exception', retryBatch: { retry: false }, retryMessages: [] },
    OPTS,
    NOW + 2100
  )
  assert.equal(outcome.retried, 1)
})

test('one retried message does not take its siblings with it', () => {
  const db = tempQueue()
  const ids = enqueue(db, [json({ a: 1 }), json({ a: 2 })], NOW)
  const batch = leaseBatch(db, OPTS, NOW + 2000)
  assert.ok(batch !== null)
  const first = ids[0]
  assert.ok(first !== undefined)
  const outcome = applyResult(
    db,
    batch.leaseId,
    { outcome: 'ok', retryBatch: { retry: false }, retryMessages: [{ msgId: first }] },
    OPTS,
    NOW + 2100
  )
  assert.equal(outcome.acked, 1)
  assert.equal(outcome.retried, 1)
  assert.equal(depth(db), 1)
})

test('delay precedence is per message, then batch, then retry_delay', () => {
  const db = tempQueue()
  const ids = enqueue(db, [json({ a: 1 })], NOW)
  const id = ids[0]
  assert.ok(id !== undefined)
  const batch = leaseBatch(db, OPTS, NOW + 2000)
  assert.ok(batch !== null)
  applyResult(
    db,
    batch.leaseId,
    {
      outcome: 'ok',
      retryBatch: { retry: true, delaySeconds: 30 },
      retryMessages: [{ msgId: id, delaySeconds: 5 }],
    },
    { ...OPTS, retryDelaySeconds: 90 },
    NOW + 2100
  )
  const row = db.prepare('SELECT visible_at FROM messages').get() as { visible_at: number }
  assert.equal(row.visible_at, NOW + 2100 + 5000)
})

test('with no delay anywhere the retry_delay applies', () => {
  const db = tempQueue()
  enqueue(db, [json({ a: 1 })], NOW)
  const batch = leaseBatch(db, OPTS, NOW + 2000)
  assert.ok(batch !== null)
  applyResult(
    db,
    batch.leaseId,
    { outcome: 'ok', retryBatch: { retry: true }, retryMessages: [] },
    { ...OPTS, retryDelaySeconds: 90 },
    NOW + 2100
  )
  const row = db.prepare('SELECT visible_at FROM messages').get() as { visible_at: number }
  assert.equal(row.visible_at, NOW + 2100 + 90000)
})

test('a message that always fails is delivered maxRetries plus one times, then dead lettered', () => {
  const db = tempQueue()
  enqueue(db, [json({ a: 1 })], NOW)
  const retryAll: DeliveryResult = { outcome: 'ok', retryBatch: { retry: true }, retryMessages: [] }

  let deliveries = 0
  let dead: string[] = []
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const batch = leaseBatch(db, OPTS, NOW + 2000 + attempt * 1000)
    if (batch === null) break
    deliveries += 1
    const outcome = applyResult(db, batch.leaseId, retryAll, OPTS, NOW + 2100 + attempt * 1000)
    dead = dead.concat(outcome.deadLettered.map((m) => m.id))
  }

  assert.equal(deliveries, 3, 'maxRetries 2 means three deliveries in total')
  assert.equal(dead.length, 1)
  assert.equal(depth(db), 0, 'a dead lettered message leaves this queue')
})

test('applying a stale lease id changes nothing', () => {
  const db = tempQueue()
  enqueue(db, [json({ a: 1 })], NOW)
  const batch = leaseBatch(db, OPTS, NOW + 2000)
  assert.ok(batch !== null)
  const outcome = applyResult(db, 'some-other-lease', OK, OPTS, NOW + 2100)
  assert.equal(outcome.acked, 0)
  assert.equal(depth(db), 1)
})
