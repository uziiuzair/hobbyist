import assert from 'node:assert/strict'
import { test } from 'node:test'
import { decodeBody, encodeBody } from '../src/codec.js'

function roundTrip(value: unknown): unknown {
  return decodeBody(encodeBody(value))
}

test('primitives survive', () => {
  assert.equal(roundTrip('hello'), 'hello')
  assert.equal(roundTrip(42), 42)
  assert.equal(roundTrip(true), true)
  assert.equal(roundTrip(null), null)
  assert.equal(roundTrip(undefined), undefined)
})

test('a plain object survives', () => {
  assert.deepEqual(roundTrip({ orgId: 'o_9', nested: { count: 2 } }), {
    orgId: 'o_9',
    nested: { count: 2 },
  })
})

test('an array survives', () => {
  assert.deepEqual(roundTrip([1, 'two', { three: 3 }]), [1, 'two', { three: 3 }])
})

test('a Date survives as a Date, which is the whole reason this exists', () => {
  const value = roundTrip({ at: new Date('2026-08-13T10:00:00.000Z') }) as { at: Date }
  assert.ok(value.at instanceof Date)
  assert.equal(value.at.toISOString(), '2026-08-13T10:00:00.000Z')
})

test('a Map survives as a Map', () => {
  const value = roundTrip(new Map([['a', 1]])) as Map<string, number>
  assert.ok(value instanceof Map)
  assert.equal(value.get('a'), 1)
})

test('a Set survives as a Set', () => {
  const value = roundTrip(new Set([1, 2, 2])) as Set<number>
  assert.ok(value instanceof Set)
  assert.equal(value.size, 2)
})

test('a bigint survives', () => {
  assert.equal(roundTrip(90071992547409911n), 90071992547409911n)
})

test('a cycle survives instead of throwing', () => {
  const source: Record<string, unknown> = { name: 'loop' }
  source.self = source
  const value = roundTrip(source) as Record<string, unknown>
  assert.equal(value.name, 'loop')
  assert.equal(value.self, value)
})

test('the same object referenced twice decodes to one object', () => {
  const shared = { id: 1 }
  const value = roundTrip({ a: shared, b: shared }) as { a: object; b: object }
  assert.equal(value.a, value.b)
})

test('encoded output is a JSON string, because the daemon stores it as text', () => {
  const text = encodeBody({ a: 1 })
  assert.doesNotThrow(() => JSON.parse(text))
})
