import { test } from 'node:test'
import assert from 'node:assert/strict'
import { waitReady } from '../src/ready.ts'

function controlledClock() {
  let t = 0
  return {
    now: () => t,
    sleepFor: async (ms: number) => {
      t += ms
    },
    advance: (ms: number) => {
      t += ms
    },
  }
}

test('returns immediately when the first probe succeeds', async () => {
  const c = controlledClock()
  const r = await waitReady({
    probe: async () => true,
    pollMs: 100,
    timeoutMs: 5000,
    now: c.now,
    sleepFor: c.sleepFor,
  })
  assert.equal(r.ready, true)
  assert.equal(r.attempts, 1)
  assert.equal(r.waitedMs, 0)
})

test('polls until the probe succeeds and counts every attempt', async () => {
  const c = controlledClock()
  let calls = 0
  const r = await waitReady({
    probe: async () => ++calls >= 4,
    pollMs: 25,
    timeoutMs: 5000,
    now: c.now,
    sleepFor: c.sleepFor,
  })
  assert.equal(r.ready, true)
  assert.equal(r.attempts, 4)
  assert.equal(r.waitedMs, 75)
})

test('a coarser poll interval costs more waiting for the same readiness point', async () => {
  const fine = controlledClock()
  const coarse = controlledClock()
  let a = 0
  let b = 0
  const fineResult = await waitReady({
    probe: async () => ++a >= 4,
    pollMs: 25,
    timeoutMs: 5000,
    now: fine.now,
    sleepFor: fine.sleepFor,
  })
  const coarseResult = await waitReady({
    probe: async () => ++b >= 4,
    pollMs: 1000,
    timeoutMs: 50_000,
    now: coarse.now,
    sleepFor: coarse.sleepFor,
  })
  assert.ok(coarseResult.waitedMs > fineResult.waitedMs)
})

test('gives up at the timeout and reports not ready rather than hanging', async () => {
  const c = controlledClock()
  const r = await waitReady({
    probe: async () => false,
    pollMs: 100,
    timeoutMs: 500,
    now: c.now,
    sleepFor: c.sleepFor,
  })
  assert.equal(r.ready, false)
  assert.ok(r.waitedMs >= 500)
})
