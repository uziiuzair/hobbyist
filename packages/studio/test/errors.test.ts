// Issue #120: the waking banner's "did not come up" narrative must be shown
// for a failed wake and for nothing else. The daemon's error code is the
// only thing that separates a wake failure from a statement Postgres
// rejected, because both arrive as a non-2xx response to the same route and
// the HTTP status is not a reliable signal (wake_failed is a 500, but so is
// internal; a bad statement is a 400, but so is a malformed body).

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ApiError } from '../src/api.js'
import { describeError, isWakeFailure } from '../src/lib/errors.js'

test('isWakeFailure is true for the two wake codes the daemon raises', () => {
  assert.equal(isWakeFailure(new ApiError('wake_failed', 'container exited', 500)), true)
  assert.equal(isWakeFailure(new ApiError('wake_timeout', 'did not become ready', 504)), true)
})

test('isWakeFailure is false for a statement Postgres rejected, whatever the status', () => {
  // toQueryError (packages/pg/src/query.ts) reports a bad statement as
  // `usage` with the SQLSTATE in the hint.
  const sqlError = new ApiError('usage', 'syntax error at or near "selec"', 400, 'SQLSTATE 42601')
  assert.equal(isWakeFailure(sqlError), false)
  // A 500 that is not a wake failure is still not a wake failure: the
  // branch is on the code, never on the status.
  assert.equal(isWakeFailure(new ApiError('internal', 'internal error', 500)), false)
  // Same for a 504 that did not come from the wake path.
  assert.equal(isWakeFailure(new ApiError('unreachable', 'request failed with status 504', 504)), false)
})

test('isWakeFailure is false for anything that is not an ApiError', () => {
  assert.equal(isWakeFailure(new Error('wake_failed')), false)
  assert.equal(isWakeFailure('wake_timeout'), false)
  assert.equal(isWakeFailure(undefined), false)
})

test('describeError renders the message with the SQLSTATE hint when there is one', () => {
  const sqlError = new ApiError('usage', 'syntax error at or near "selec"', 400, 'SQLSTATE 42601')
  assert.equal(describeError(sqlError, 'query failed'), 'syntax error at or near "selec" (SQLSTATE 42601)')
})

test('describeError renders the bare message when there is no hint', () => {
  assert.equal(describeError(new ApiError('wake_failed', 'container exited', 500), 'query failed'), 'container exited')
  assert.equal(describeError(new ApiError('usage', 'sql is required', 400, ''), 'query failed'), 'sql is required')
})

test('describeError falls back to the caller phrasing for a non-ApiError', () => {
  assert.equal(describeError(new Error('boom'), 'query failed'), 'query failed')
  assert.equal(describeError('boom', 'query failed'), 'query failed')
})
