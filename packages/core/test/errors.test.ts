// Written but not executed in this task, see task-1-report.md.

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { HobbyError, type ErrorCode } from '../src/index.js'

const EXPECTED_STATUS: Record<ErrorCode, number> = {
  project_not_found: 404,
  resource_not_found: 404,
  name_taken: 409,
  invalid_name: 400,
  ambiguous_target: 500,
  runtime_unavailable: 503,
  wake_failed: 500,
  wake_timeout: 504,
  not_ready: 500,
  conflict: 409,
  usage: 400,
  unauthorized: 401,
  internal: 500,
}

for (const [code, status] of Object.entries(EXPECTED_STATUS) as Array<[ErrorCode, number]>) {
  test(`HobbyError maps ${code} to http ${status}`, () => {
    const error = new HobbyError(code, 'message')
    assert.equal(error.httpStatus, status)
  })
}

test('HobbyError.toWire includes the hint when one is given', () => {
  const error = new HobbyError('invalid_name', 'bad name', 'must be lowercase')
  assert.deepEqual(error.toWire(), {
    error: { code: 'invalid_name', message: 'bad name', hint: 'must be lowercase' },
  })
})

test('HobbyError.toWire omits hint when none is given', () => {
  const error = new HobbyError('internal', 'oops')
  assert.deepEqual(error.toWire(), {
    error: { code: 'internal', message: 'oops' },
  })
})
