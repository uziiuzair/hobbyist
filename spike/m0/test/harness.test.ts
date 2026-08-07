import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Timeline } from '../src/timeline.ts'
import { segmentsOf, SEGMENTS } from '../src/harness.ts'

function timelineWith(values: number[]): Timeline {
  let i = 0
  const t = new Timeline(() => BigInt(values[i++]!) * 1_000_000n)
  t.mark('accept')
  t.mark('parsed')
  t.mark('wake_issued')
  t.mark('container_up')
  t.mark('pg_ready')
  t.mark('upstream_connected')
  return t
}

test('the six segments are named exactly as the spec names them', () => {
  assert.deepEqual(
    SEGMENTS.map(([, to]) => to),
    ['parsed', 'wake_issued', 'container_up', 'pg_ready', 'upstream_connected'],
  )
})

test('segmentsOf reports each gap in milliseconds', () => {
  const t = timelineWith([0, 1, 2, 200, 900, 910])
  const s = segmentsOf(t)
  assert.equal(s.accept_parse, 1)
  assert.equal(s.wake_issue, 1)
  assert.equal(s.container_up, 198)
  assert.equal(s.pg_ready, 700)
  assert.equal(s.connect_splice, 10)
  assert.equal(s.total, 910)
})
