// Issue #126: a sleep timeout is displayed exactly as configured. The old
// Math.round(seconds / 60) turned `--sleep-after 30` into "1 minute".

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { formatDuration, formatDurationShort } from '../src/lib/format.js'

test('formatDuration says the seconds back for a sub-minute timeout', () => {
  assert.equal(formatDuration(30), '30 seconds')
  assert.equal(formatDuration(1), '1 second')
})

test('formatDuration combines units and never rounds up', () => {
  assert.equal(formatDuration(90), '1 minute 30 seconds')
  assert.equal(formatDuration(60), '1 minute')
  assert.equal(formatDuration(300), '5 minutes')
  assert.equal(formatDuration(3600), '1 hour')
  assert.equal(formatDuration(3661), '1 hour 1 minute 1 second')
  assert.equal(formatDuration(7200), '2 hours')
  assert.equal(formatDuration(86400), '24 hours')
})

test('formatDuration treats a fractional or non-finite input as whole seconds', () => {
  assert.equal(formatDuration(29.9), '29 seconds')
  assert.equal(formatDuration(0), '0 seconds')
  assert.equal(formatDuration(Number.NaN), '0 seconds')
  assert.equal(formatDuration(-5), '0 seconds')
})

test('formatDurationShort is the same breakdown in stat-row form', () => {
  assert.equal(formatDurationShort(30), '30s')
  assert.equal(formatDurationShort(90), '1m 30s')
  assert.equal(formatDurationShort(300), '5m')
  assert.equal(formatDurationShort(3600), '1h')
  assert.equal(formatDurationShort(3661), '1h 1m 1s')
  assert.equal(formatDurationShort(0), '0s')
})
