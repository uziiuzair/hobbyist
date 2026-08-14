// The semantics Arlo's three drivers already guarantee
// (~/ooozzy/arlo/packages/queue/README.md, "Canonical semantics"), asserted
// against our broker. If one of these fails, a handler written for Cloudflare
// behaves differently here, which is the whole thing this capability exists
// to avoid.

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

test('conformance: at-least-once, a message is never lost by a failed delivery', () => {
  const db = tempQueue()
  enqueue(db, [json({ a: 1 })], NOW)
  const batch = leaseBatch(db, OPTS, NOW + 2000)
  assert.ok(batch !== null)
  applyResult(
    db,
    batch.leaseId,
    { outcome: 'exception', retryBatch: { retry: false }, retryMessages: [] },
    OPTS,
    NOW + 2100
  )
  assert.equal(depth(db), 1)
})

test('conformance: a handler that decides nothing gets the message again', () => {
  const db = tempQueue()
  enqueue(db, [json({ a: 1 })], NOW)
  const batch = leaseBatch(db, OPTS, NOW + 2000)
  assert.ok(batch !== null)
  // outcome ok, no acks, no retries: workerd reports this as an implicit
  // retry of the untouched messages via retryBatch.
  const implicit: DeliveryResult = { outcome: 'ok', retryBatch: { retry: true }, retryMessages: [] }
  applyResult(db, batch.leaseId, implicit, OPTS, NOW + 2100)
  assert.equal(depth(db), 1)
})

test('conformance: attempts is 1 on first delivery and climbs by one', () => {
  const db = tempQueue()
  enqueue(db, [json({ a: 1 })], NOW)
  const seen: number[] = []
  for (let round = 0; round < 3; round += 1) {
    const at = NOW + 2000 + round * 5000
    const batch = leaseBatch(db, OPTS, at)
    if (batch === null) break
    const message = batch.messages[0]
    assert.ok(message !== undefined)
    seen.push(message.attempts)
    applyResult(
      db,
      batch.leaseId,
      { outcome: 'ok', retryBatch: { retry: true }, retryMessages: [] },
      OPTS,
      at + 100
    )
  }
  assert.deepEqual(seen, [1, 2, 3])
})

test('conformance: an uncaught throw fails the whole batch, not one message', () => {
  const db = tempQueue()
  enqueue(db, [json({ a: 1 }), json({ a: 2 }), json({ a: 3 })], NOW)
  const batch = leaseBatch(db, OPTS, NOW + 2000)
  assert.ok(batch !== null)
  const outcome = applyResult(
    db,
    batch.leaseId,
    { outcome: 'exception', retryBatch: { retry: false }, retryMessages: [] },
    OPTS,
    NOW + 2100
  )
  assert.equal(outcome.acked, 0)
  assert.equal(outcome.retried, 3)
})

test('conformance: per-message ack and retry can be mixed in one batch', () => {
  const db = tempQueue()
  const ids = enqueue(db, [json({ a: 1 }), json({ a: 2 }), json({ a: 3 })], NOW)
  const second = ids[1]
  assert.ok(second !== undefined)
  const batch = leaseBatch(db, OPTS, NOW + 2000)
  assert.ok(batch !== null)
  const outcome = applyResult(
    db,
    batch.leaseId,
    { outcome: 'ok', retryBatch: { retry: false }, retryMessages: [{ msgId: second }] },
    OPTS,
    NOW + 2100
  )
  assert.equal(outcome.acked, 2)
  assert.equal(outcome.retried, 1)
  assert.equal(depth(db), 1)
})

test('conformance: a dead lettered message leaves the queue exactly once', () => {
  const db = tempQueue()
  enqueue(db, [json({ a: 1 })], NOW)
  let deliveries = 0
  let deadLettered: Array<{ id: string; attempts: number }> = []
  for (let round = 0; round < 6; round += 1) {
    const at = NOW + 2000 + round * 5000
    const batch = leaseBatch(db, OPTS, at)
    if (batch === null) break
    deliveries += 1
    const outcome = applyResult(
      db,
      batch.leaseId,
      { outcome: 'ok', retryBatch: { retry: true }, retryMessages: [] },
      OPTS,
      at + 100
    )
    for (const message of outcome.deadLettered) {
      deadLettered.push({ id: message.id, attempts: message.attempts })
    }
  }
  assert.equal(deliveries, OPTS.maxRetries + 1)
  assert.equal(deadLettered.length, 1)
  const dead = deadLettered[0]
  assert.ok(dead !== undefined)
  assert.equal(dead.attempts, OPTS.maxRetries + 1)
  assert.equal(depth(db), 0)
})
