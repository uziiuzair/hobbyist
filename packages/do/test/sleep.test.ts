// The full truth table for shouldSleepNamespace, in a plain loop with no
// clock, no filesystem and no runtime. That is the property the function was
// shaped for, and it is the same property hibernator.test.ts relies on.

import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ResourceState } from '@hobby.sh/core'
import { isAlarmDue, isAlarmImminent, shouldSleepNamespace } from '../src/sleep.js'

const NOW = 1786375171389
const GRACE = 30

function input(overrides: Partial<Parameters<typeof shouldSleepNamespace>[0]> = {}) {
  return {
    state: 'running' as ResourceState,
    idleSeconds: 600,
    sleepAfterSeconds: 300,
    nextAlarmAtMs: null,
    nowMs: NOW,
    wakeGraceSeconds: GRACE,
    ...overrides,
  }
}

test('an idle running namespace with no alarms sleeps', () => {
  assert.equal(shouldSleepNamespace(input()), true)
})

test('a pinned namespace never sleeps, whatever else is true', () => {
  assert.equal(shouldSleepNamespace(input({ sleepAfterSeconds: null })), false)
})

test('only a running namespace sleeps', () => {
  const states: ResourceState[] = ['creating', 'starting', 'sleeping', 'stopping', 'failed', 'destroying']
  for (const state of states) {
    assert.equal(shouldSleepNamespace(input({ state })), false, `state ${state} must not sleep`)
  }
})

test('an unknown idle time does not sleep', () => {
  assert.equal(shouldSleepNamespace(input({ idleSeconds: null })), false)
})

test('idle below the threshold does not sleep, and exactly at it does', () => {
  assert.equal(shouldSleepNamespace(input({ idleSeconds: 299, sleepAfterSeconds: 300 })), false)
  assert.equal(shouldSleepNamespace(input({ idleSeconds: 300, sleepAfterSeconds: 300 })), true)
})

test('an alarm inside the grace window blocks sleep', () => {
  // Due in 10 seconds, grace is 30. Stopping now to start again in 10 seconds
  // pays a cold start to buy 10 seconds of idle memory.
  assert.equal(shouldSleepNamespace(input({ nextAlarmAtMs: NOW + 10_000 })), false)
})

test('an alarm exactly at the edge of the grace window blocks sleep', () => {
  assert.equal(shouldSleepNamespace(input({ nextAlarmAtMs: NOW + GRACE * 1000 })), false)
})

test('an alarm beyond the grace window does not block sleep', () => {
  assert.equal(shouldSleepNamespace(input({ nextAlarmAtMs: NOW + GRACE * 1000 + 1 })), true)
})

// The rule that keeps the predicate and the mirror from arguing over one row.
// If an overdue alarm also pinned the namespace awake, a namespace whose alarm
// could never fire would be held running forever by this function while the
// mirror kept asking for a wake it already had.
test('an overdue alarm does not block sleep, it is the mirror’s job', () => {
  assert.equal(shouldSleepNamespace(input({ nextAlarmAtMs: NOW - 1 })), true)
  assert.equal(isAlarmImminent(NOW - 1, NOW, GRACE), false)
  assert.equal(isAlarmDue(NOW - 1, NOW), true)
})

test('an alarm due exactly now is due, and is not merely imminent', () => {
  assert.equal(isAlarmDue(NOW, NOW), true)
  assert.equal(isAlarmImminent(NOW, NOW, GRACE), true)
})

test('no alarm is neither due nor imminent', () => {
  assert.equal(isAlarmDue(null, NOW), false)
  assert.equal(isAlarmImminent(null, NOW, GRACE), false)
})

test('a zero grace window still blocks nothing but an alarm due exactly now', () => {
  assert.equal(shouldSleepNamespace(input({ nextAlarmAtMs: NOW, wakeGraceSeconds: 0 })), false)
  assert.equal(shouldSleepNamespace(input({ nextAlarmAtMs: NOW + 1, wakeGraceSeconds: 0 })), true)
})
