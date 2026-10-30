// Written but not executed in this task, see task-1-report.md.

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { HobbyError, isDiskFullError, type ErrorCode } from '../src/index.js'

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
  unknown_kind: 500,
  build_failed: 422,
  too_many_attempts: 429,
  not_found: 404,
  disk_full: 507,
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

// Issue #139: the two errno codes for "no room", and the same condition
// reported by a child process on stderr, all read as a full disk.
test('isDiskFullError recognises ENOSPC, EDQUOT and cp\'s own words, and nothing else', () => {
  assert.equal(isDiskFullError(Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' })), true)
  assert.equal(isDiskFullError(Object.assign(new Error('EDQUOT: disk quota exceeded'), { code: 'EDQUOT' })), true)
  assert.equal(isDiskFullError(Object.assign(new Error('Command failed: cp'), { code: 1, stderr: 'cp: x: No space left on device' })), true)
  assert.equal(isDiskFullError(new HobbyError('internal', 'online backup failed', 'tar: write error: No space left on device')), true)
  assert.equal(isDiskFullError(Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' })), false)
  assert.equal(isDiskFullError(new Error('boom')), false)
  assert.equal(isDiskFullError(null), false)
  assert.equal(isDiskFullError('ENOSPC'), false)
})
