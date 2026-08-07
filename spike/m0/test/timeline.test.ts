import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Timeline } from '../src/timeline.ts'

function fakeClock(values: bigint[]): () => bigint {
  let i = 0
  return () => values[i++]!
}

test('segmentMs converts nanosecond marks to milliseconds', () => {
  const t = new Timeline(fakeClock([0n, 1_500_000n]))
  t.mark('a')
  t.mark('b')
  assert.equal(t.segmentMs('a', 'b'), 1.5)
})

test('segmentMs throws on an unknown mark rather than returning NaN', () => {
  const t = new Timeline(fakeClock([0n]))
  t.mark('a')
  assert.throws(() => t.segmentMs('a', 'nope'), /no mark named "nope"/)
})

test('marking the same name twice throws, because a duplicate silently ruins a segment', () => {
  const t = new Timeline(fakeClock([0n, 1n]))
  t.mark('a')
  assert.throws(() => t.mark('a'), /duplicate mark "a"/)
})
