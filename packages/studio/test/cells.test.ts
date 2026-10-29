// Issue #119: bytea and jsonb cells rendered as "[object Object]", and an
// unchanged edit of a bytea cell wrote that literal text into the column.

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { bufferToHex, cellText, isBinaryType, isBufferJson } from '../src/lib/cells.js'

const DEADBEEF = { type: 'Buffer' as const, data: [0xde, 0xad, 0xbe, 0xef] }

test('a bytea value arrives as a serialized Buffer and renders as Postgres hex', () => {
  assert.equal(isBufferJson(DEADBEEF), true)
  assert.equal(bufferToHex(DEADBEEF), '\\xdeadbeef')
  assert.equal(cellText(DEADBEEF, 'bytea'), '\\xdeadbeef')
  assert.equal(cellText({ type: 'Buffer', data: [0, 1] }, 'bytea'), '\\x0001', 'single-digit bytes are zero padded')
})

test('a json or jsonb value renders as JSON text, which is what the update route accepts back', () => {
  assert.equal(cellText({ a: 1 }, 'jsonb'), '{"a":1}')
  assert.equal(cellText([1, 'two'], 'json'), '[1,"two"]')
  assert.equal(cellText('already text', 'jsonb'), 'already text')
  assert.equal(cellText(42, 'jsonb'), '42')
})

test('bytea is the one type the inline editor refuses', () => {
  assert.equal(isBinaryType('bytea'), true)
  assert.equal(isBinaryType('text'), false)
  assert.equal(isBinaryType('jsonb'), false)
})

test('everything else is unchanged from String(value)', () => {
  assert.equal(cellText('hello', 'text'), 'hello')
  assert.equal(cellText(7, 'integer'), '7')
  assert.equal(cellText(true, 'boolean'), 'true')
  assert.equal(cellText([1, 2, 3], 'ARRAY'), '1,2,3')
  // An object of a type this code does not know is still never "[object Object]".
  assert.equal(cellText({ x: 1 }, 'composite'), '{"x":1}')
})
