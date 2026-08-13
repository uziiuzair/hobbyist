import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { HobbyError } from '@hobby.sh/core'
import { MAX_BATCH_COUNT, MAX_MESSAGE_BYTES, depth, enqueue } from '../src/broker.js'
import { NOW, cleanupQueues, json, tempQueue } from './fixtures.js'

after(cleanupQueues)

test('enqueue returns one id per message and the depth follows', () => {
  const db = tempQueue()
  const ids = enqueue(db, [json({ a: 1 }), json({ a: 2 })], NOW)
  assert.equal(ids.length, 2)
  assert.equal(depth(db), 2)
})

test('a message with no delay is visible immediately', () => {
  const db = tempQueue()
  enqueue(db, [json({ a: 1 })], NOW)
  const row = db.prepare('SELECT visible_at, enqueued_at, attempts FROM messages').get() as {
    visible_at: number
    enqueued_at: number
    attempts: number
  }
  assert.equal(row.visible_at, NOW)
  assert.equal(row.enqueued_at, NOW)
  assert.equal(row.attempts, 0)
})

test('delaySeconds pushes visible_at forward without touching enqueued_at', () => {
  const db = tempQueue()
  enqueue(db, [{ ...json({ a: 1 }), delaySeconds: 60 }], NOW)
  const row = db.prepare('SELECT visible_at, enqueued_at FROM messages').get() as {
    visible_at: number
    enqueued_at: number
  }
  assert.equal(row.visible_at, NOW + 60000)
  assert.equal(row.enqueued_at, NOW)
})

test('a message over 128000 bytes is refused', () => {
  const db = tempQueue()
  const tooBig = { body: 'x'.repeat(MAX_MESSAGE_BYTES + 1), contentType: 'text' as const }
  assert.throws(() => enqueue(db, [tooBig], NOW), (err: unknown) => {
    assert.ok(err instanceof HobbyError)
    assert.match(err.message, /128000/)
    return true
  })
  assert.equal(depth(db), 0)
})

test('more than 100 messages in one call is refused', () => {
  const db = tempQueue()
  const many = Array.from({ length: MAX_BATCH_COUNT + 1 }, (_, i) => json({ i }))
  assert.throws(() => enqueue(db, many, NOW), /100/)
  assert.equal(depth(db), 0)
})

test('a batch over 288000 bytes total is refused', () => {
  const db = tempQueue()
  const chunky = Array.from({ length: 3 }, () => ({ body: 'x'.repeat(100000), contentType: 'text' as const }))
  assert.throws(() => enqueue(db, chunky, NOW), /288000/)
  assert.equal(depth(db), 0)
})

test('delaySeconds outside 0 to 86400 is refused', () => {
  const db = tempQueue()
  assert.throws(() => enqueue(db, [{ ...json({ a: 1 }), delaySeconds: 86401 }], NOW), /86400/)
  assert.throws(() => enqueue(db, [{ ...json({ a: 1 }), delaySeconds: -1 }], NOW), /86400/)
})

test('a rejected batch inserts nothing, so a partial send cannot happen', () => {
  const db = tempQueue()
  const mixed = [json({ ok: true }), { body: 'x'.repeat(MAX_MESSAGE_BYTES + 1), contentType: 'text' as const }]
  assert.throws(() => enqueue(db, mixed, NOW))
  assert.equal(depth(db), 0)
})
