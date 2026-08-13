import assert from 'node:assert/strict'
import { test } from 'node:test'
import { newMessageId } from '../src/ids.js'

test('an id is 26 characters of Crockford base32', () => {
  const id = newMessageId(1786375171389)
  assert.equal(id.length, 26)
  assert.match(id, /^[0-9A-HJKMNP-TV-Z]{26}$/)
})

test('a later millisecond sorts after an earlier one', () => {
  const earlier = newMessageId(1786375171389)
  const later = newMessageId(1786375171390)
  assert.ok(earlier < later, `${earlier} should sort before ${later}`)
})

test('two ids in the same millisecond are distinct and ordered', () => {
  const first = newMessageId(1786375171389)
  const second = newMessageId(1786375171389)
  assert.notEqual(first, second)
  assert.ok(first < second, `${first} should sort before ${second}`)
})

test('a thousand ids in one millisecond stay unique and sorted', () => {
  const ids = Array.from({ length: 1000 }, () => newMessageId(1786375171389))
  const sorted = [...ids].sort()
  assert.deepEqual(ids, sorted)
  assert.equal(new Set(ids).size, 1000)
})
