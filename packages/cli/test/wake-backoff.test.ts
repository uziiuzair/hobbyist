// The pure half of the wake backoff (packages/cli/src/daemon/wake-backoff.ts):
// the schedule as arithmetic, the delay as a person reads it, and the
// redaction of a start error before it is kept and put on the wire. The
// stateful half, driven through the real wake path, is in wake-failed.test.ts.

import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  formatRetryDelay,
  redactWakeError,
  WAKE_RETRY_BASE_MS,
  WAKE_RETRY_CAP_MS,
  wakeRetryDelayMs,
} from '../src/daemon/wake-backoff.js'

test('wakeRetryDelayMs doubles from 30s and caps at 15m', () => {
  assert.equal(WAKE_RETRY_BASE_MS, 30_000)
  assert.equal(WAKE_RETRY_CAP_MS, 900_000)
  assert.deepEqual(
    [1, 2, 3, 4, 5, 6, 7, 50].map(wakeRetryDelayMs),
    [30_000, 60_000, 120_000, 240_000, 480_000, 900_000, 900_000, 900_000]
  )
})

test('wakeRetryDelayMs stays finite for an absurd failure count, and treats 0 as the first failure', () => {
  assert.equal(wakeRetryDelayMs(100_000), 900_000)
  assert.equal(wakeRetryDelayMs(0), 30_000)
})

test('formatRetryDelay reads as minutes and seconds, rounded up', () => {
  assert.equal(formatRetryDelay(240_000), '4m 0s')
  assert.equal(formatRetryDelay(192_000), '3m 12s')
  assert.equal(formatRetryDelay(45_000), '45s')
  assert.equal(formatRetryDelay(200), '1s')
  assert.equal(formatRetryDelay(0), '0s')
  assert.equal(formatRetryDelay(-5_000), '0s')
})

test('redactWakeError strips URL credentials and password values, and caps the length', () => {
  assert.equal(
    redactWakeError('could not reach postgres://app:s3cret@db:5432/x and https://tok@example.com/a'),
    'could not reach postgres://<redacted>@db:5432/x and https://<redacted>@example.com/a'
  )
  assert.equal(redactWakeError('dsn host=db password=s3cret user=app'), 'dsn host=db password=<redacted> user=app')
  assert.equal(redactWakeError('PASSWORD=s3cret;next'), 'PASSWORD=<redacted>;next')
  // Ordinary errors pass through unchanged, whitespace collapsed.
  assert.equal(
    redactWakeError('postgres for resource r1 did not become ready\n  within 30000ms'),
    'postgres for resource r1 did not become ready within 30000ms'
  )
  // A URL with no credentials is left alone.
  assert.equal(redactWakeError('GET http://127.0.0.1:25433/ failed'), 'GET http://127.0.0.1:25433/ failed')
  const long = redactWakeError('x'.repeat(1000))
  assert.equal(long.length, 300)
  assert.ok(long.endsWith('...'))
})
