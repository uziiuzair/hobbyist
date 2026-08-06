import { test } from 'node:test'
import assert from 'node:assert/strict'
import { percentile, summarise } from '../src/stats.ts'

test('percentile returns the exact value at a whole rank', () => {
  assert.equal(percentile([1, 2, 3, 4, 5], 50), 3)
})

test('percentile interpolates between ranks', () => {
  assert.equal(percentile([0, 10], 50), 5)
})

test('percentile 0 is the minimum and 100 is the maximum', () => {
  assert.equal(percentile([4, 8, 15, 16, 23, 42], 0), 4)
  assert.equal(percentile([4, 8, 15, 16, 23, 42], 100), 42)
})

test('percentile of a single sample is that sample', () => {
  assert.equal(percentile([7], 95), 7)
})

test('percentile of an empty sample throws rather than returning NaN', () => {
  assert.throws(() => percentile([], 50), /empty sample/)
})

test('summarise sorts before computing, so caller order does not matter', () => {
  const s = summarise([300, 100, 200])
  assert.equal(s.n, 3)
  assert.equal(s.p50, 200)
  assert.equal(s.max, 300)
})
