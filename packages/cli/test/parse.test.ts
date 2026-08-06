// Pure tests: argv parsing, the exit code table, and parseTarget. None of
// these touch a socket, Docker, or the filesystem, so they run for real
// (see the package's own test/routes.test.ts for the precedent on running
// tests that need no Docker and no network).

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseTarget, type ErrorCode } from '@hobby.sh/core'
import { exitCodeForError } from '../src/cli/exit.js'
import { parseArgs, UsageError } from '../src/cli/main.js'

test('parseArgs: pg create --project p name splits positionals from the value flag', () => {
  const result = parseArgs(['create', '--project', 'blog', 'analytics'], { bool: ['json'], value: ['project'] })
  assert.deepEqual(result.positionals, ['create', 'analytics'])
  assert.equal(result.flags.project, 'blog')
  assert.equal(result.flags.json, undefined)
})

test('parseArgs: --flag=value form is equivalent to --flag value', () => {
  const result = parseArgs(['logs', '--tail=50'], { value: ['tail'] })
  assert.deepEqual(result.positionals, ['logs'])
  assert.equal(result.flags.tail, '50')
})

test('parseArgs: declared boolean flags are true and never consume the next token', () => {
  const result = parseArgs(['blog', '--yes', '--json'], { bool: ['yes', 'json'] })
  assert.deepEqual(result.positionals, ['blog'])
  assert.equal(result.flags.yes, true)
  assert.equal(result.flags.json, true)
})

test('parseArgs: rm <target> [--yes] and eject <project> both parse a bare positional plus --json', () => {
  const rm = parseArgs(['blog/analytics', '--yes', '--json'], { bool: ['yes', 'json'] })
  assert.deepEqual(rm.positionals, ['blog/analytics'])
  assert.equal(rm.flags.yes, true)

  const eject = parseArgs(['blog', '--json'], { bool: ['json'] })
  assert.deepEqual(eject.positionals, ['blog'])
  assert.equal(eject.flags.json, true)
})

test('parseArgs: sleep/wake/connect accept only --json and a target positional', () => {
  const result = parseArgs(['blog/primary', '--json'], { bool: ['json'] })
  assert.deepEqual(result.positionals, ['blog/primary'])
  assert.equal(result.flags.json, true)
})

test('parseArgs: rejects an undeclared flag', () => {
  assert.throws(() => parseArgs(['--nope'], {}), UsageError)
})

test('parseArgs: rejects a value flag with no value and nothing after it', () => {
  assert.throws(() => parseArgs(['--project'], { value: ['project'] }), UsageError)
})

test('parseArgs: rejects giving a boolean flag a value via =', () => {
  assert.throws(() => parseArgs(['--json=true'], { bool: ['json'] }), UsageError)
})

// Every ErrorCode in @hobby.sh/core, kept as an explicit literal list here
// (rather than derived from the type, which cannot be enumerated at
// runtime) so this test fails loudly if core adds a new one and this list
// is not updated to match. exitCodeForError itself is additionally backed
// by TypeScript's own exhaustiveness check on Record<ErrorCode, number> in
// exit.ts: a code missing there is a compile error, not just a test
// failure.
const ALL_ERROR_CODES: ErrorCode[] = [
  'project_not_found',
  'resource_not_found',
  'name_taken',
  'invalid_name',
  'ambiguous_target',
  'runtime_unavailable',
  'wake_failed',
  'wake_timeout',
  'not_ready',
  'conflict',
  'usage',
  'unauthorized',
  'internal',
]

test('exitCodeForError: every ErrorCode maps to one of the six documented exit codes', () => {
  for (const code of ALL_ERROR_CODES) {
    const exitCode = exitCodeForError(code)
    assert.ok([0, 1, 2, 3, 4, 5].includes(exitCode), `${code} mapped to unexpected exit code ${exitCode}`)
  }
})

test('exitCodeForError: the specific mappings the brief calls out by name', () => {
  assert.equal(exitCodeForError('project_not_found'), 3)
  assert.equal(exitCodeForError('resource_not_found'), 3)
  assert.equal(exitCodeForError('name_taken'), 4)
  assert.equal(exitCodeForError('conflict'), 4)
  assert.equal(exitCodeForError('usage'), 2)
  assert.equal(exitCodeForError('invalid_name'), 2)
  assert.equal(exitCodeForError('ambiguous_target'), 2)
})

test('parseTarget: a bare project has no resource segment', () => {
  assert.deepEqual(parseTarget('blog'), { project: 'blog', resource: null })
})

test('parseTarget: project/resource splits on the first slash', () => {
  assert.deepEqual(parseTarget('blog/analytics'), { project: 'blog', resource: 'analytics' })
})
