import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import {
  DEFAULT_CONSUMER_OPTIONS,
  hasOutstandingLease,
  isBatchReady,
  enqueue,
  leaseBatch,
} from '../src/broker.js'
import { NOW, cleanupQueues, json, tempQueue } from './fixtures.js'

after(cleanupQueues)

const OPTS = DEFAULT_CONSUMER_OPTIONS

test('the defaults are the ones miniflare uses, not invented here', () => {
  assert.equal(OPTS.maxBatchSize, 5)
  assert.equal(OPTS.maxBatchTimeoutSeconds, 1)
  assert.equal(OPTS.maxRetries, 2)
})

test('an empty queue is never ready', () => {
  const db = tempQueue()
  assert.equal(isBatchReady(db, OPTS, NOW), false)
  assert.equal(leaseBatch(db, OPTS, NOW), null)
})

test('a full batch is ready immediately', () => {
  const db = tempQueue()
  enqueue(db, Array.from({ length: 5 }, (_, i) => json({ i })), NOW)
  assert.equal(isBatchReady(db, OPTS, NOW), true)
})

test('a partial batch waits for maxBatchTimeout and then goes', () => {
  const db = tempQueue()
  enqueue(db, [json({ a: 1 })], NOW)
  assert.equal(isBatchReady(db, OPTS, NOW), false)
  assert.equal(isBatchReady(db, OPTS, NOW + 999), false)
  assert.equal(isBatchReady(db, OPTS, NOW + 1000), true)
})

test('a delayed message is not ready before its time', () => {
  const db = tempQueue()
  enqueue(db, [{ ...json({ a: 1 }), delaySeconds: 60 }], NOW)
  assert.equal(isBatchReady(db, OPTS, NOW + 5000), false)
  assert.equal(isBatchReady(db, OPTS, NOW + 61000), true)
})

test('a lease takes at most maxBatchSize, oldest first', () => {
  const db = tempQueue()
  const ids = enqueue(db, Array.from({ length: 7 }, (_, i) => json({ i })), NOW)
  const batch = leaseBatch(db, OPTS, NOW + 2000)
  assert.ok(batch !== null)
  assert.equal(batch.messages.length, 5)
  assert.deepEqual(
    batch.messages.map((m) => m.id),
    ids.slice(0, 5)
  )
})

test('attempts is 1 during the first delivery, matching Cloudflare', () => {
  const db = tempQueue()
  enqueue(db, [json({ a: 1 })], NOW)
  const batch = leaseBatch(db, OPTS, NOW + 2000)
  assert.equal(batch?.messages[0]?.attempts, 1)
})

test('a leased message is not leased again', () => {
  const db = tempQueue()
  enqueue(db, [json({ a: 1 })], NOW)
  const first = leaseBatch(db, OPTS, NOW + 2000)
  assert.ok(first !== null)
  const second = leaseBatch(db, OPTS, NOW + 2001)
  assert.equal(second, null)
})

test('the batch carries the backlog metrics Cloudflare sends as metadata', () => {
  const db = tempQueue()
  enqueue(db, Array.from({ length: 7 }, (_, i) => json({ i })), NOW)
  const batch = leaseBatch(db, OPTS, NOW + 2000)
  assert.ok(batch !== null)
  assert.equal(batch.backlogCount, 2)
  assert.ok(batch.backlogBytes > 0)
  assert.equal(batch.oldestMessageTimestampMs, NOW)
})

test('an outstanding lease is visible to the sleep guard, and expires', () => {
  const db = tempQueue()
  enqueue(db, [json({ a: 1 })], NOW)
  leaseBatch(db, OPTS, NOW + 2000, 60000)
  assert.equal(hasOutstandingLease(db, NOW + 3000), true)
  assert.equal(hasOutstandingLease(db, NOW + 2000 + 60001), false)
})
