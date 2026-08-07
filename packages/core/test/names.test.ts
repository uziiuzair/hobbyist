// Written but not executed in this task, see task-1-report.md.

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { HobbyError, parseRoutingKey, parseTarget, validateName } from '../src/index.js'

test('validateName accepts a valid name', () => {
  assert.doesNotThrow(() => validateName('my-project'))
})

test('validateName accepts the shortest valid name', () => {
  assert.doesNotThrow(() => validateName('ab'))
})

test('validateName rejects a single character name', () => {
  assert.throws(() => validateName('a'), HobbyError)
})

test('validateName rejects a name starting with a digit', () => {
  assert.throws(() => validateName('1project'), HobbyError)
})

test('validateName rejects uppercase letters', () => {
  assert.throws(() => validateName('MyProject'), HobbyError)
})

test('validateName rejects underscores', () => {
  assert.throws(() => validateName('my_project'), HobbyError)
})

test('validateName rejects the reserved name postgres', () => {
  assert.throws(() => validateName('postgres'), HobbyError)
})

test('validateName rejects the reserved name template0', () => {
  assert.throws(() => validateName('template0'), HobbyError)
})

test('validateName rejects the reserved name template1', () => {
  assert.throws(() => validateName('template1'), HobbyError)
})

test('validateName rejects the reserved name hobby', () => {
  assert.throws(() => validateName('hobby'), HobbyError)
})

test('parseRoutingKey with no dot returns a null database', () => {
  assert.deepEqual(parseRoutingKey('blog'), { project: 'blog', database: null })
})

test('parseRoutingKey splits on the first dot', () => {
  assert.deepEqual(parseRoutingKey('blog.analytics'), { project: 'blog', database: 'analytics' })
})

test('parseRoutingKey with multiple dots keeps the rest in database', () => {
  assert.deepEqual(parseRoutingKey('blog.a.b'), { project: 'blog', database: 'a.b' })
})

test('parseTarget with no slash returns a null resource', () => {
  assert.deepEqual(parseTarget('blog'), { project: 'blog', resource: null })
})

test('parseTarget splits on the first slash', () => {
  assert.deepEqual(parseTarget('blog/primary'), { project: 'blog', resource: 'primary' })
})

test('parseTarget with multiple slashes keeps the rest in resource', () => {
  assert.deepEqual(parseTarget('blog/a/b'), { project: 'blog', resource: 'a/b' })
})
