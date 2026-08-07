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

// Every ErrorCode in @hobby.sh/core, paired with its exact expected exit
// code (not just "one of the six valid ones"), kept as an explicit literal
// table here rather than derived from the type, which cannot be enumerated
// at runtime, so this test fails loudly if core adds a new ErrorCode and
// this table is not updated to match. This table is the same one documented
// in exit.ts's own comment; a wrong mapping there (e.g. two codes silently
// swapped) fails here even though TypeScript's Record<ErrorCode, number>
// exhaustiveness check would not catch it, since that check only proves
// every key is present, never that its value is the right one.
const EXPECTED_EXIT_CODE: Record<ErrorCode, number> = {
  project_not_found: 3,
  resource_not_found: 3,
  name_taken: 4,
  conflict: 4,
  invalid_name: 2,
  ambiguous_target: 2,
  usage: 2,
  runtime_unavailable: 1,
  wake_failed: 1,
  wake_timeout: 1,
  not_ready: 1,
  unauthorized: 1,
  internal: 1,
}

test('exitCodeForError: every ErrorCode maps to its exact documented exit code', () => {
  for (const [code, expected] of Object.entries(EXPECTED_EXIT_CODE) as Array<[ErrorCode, number]>) {
    assert.equal(exitCodeForError(code), expected, `${code} should map to exit ${expected}`)
  }
})

test('parseTarget: a bare project has no resource segment', () => {
  assert.deepEqual(parseTarget('blog'), { project: 'blog', resource: null })
})

test('parseTarget: project/resource splits on the first slash', () => {
  assert.deepEqual(parseTarget('blog/analytics'), { project: 'blog', resource: 'analytics' })
})
