// Pure tests: argv parsing, the exit code table, and parseTarget. None of
// these touch a socket, Docker, or the filesystem, so they run for real
// (see the package's own test/routes.test.ts for the precedent on running
// tests that need no Docker and no network).

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseTarget, type ErrorCode } from '@hobby.sh/core'
import { parseDeploy, parseEnvAssignments, parseEnvFile } from '../src/cli/commands.js'
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
  build_failed: 2,
  runtime_unavailable: 1,
  unknown_kind: 1,
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

// `hobby deploy` takes exactly one positional, the path; a second optional
// positional for the resource name cannot be disambiguated from the first,
// so the name is `--name`, defaulting to the basename of the resolved path.
// `hobby deploy ./site` therefore targets a resource called `site`. When
// the path is left at its default `.`, there is no basename to take without
// the caller's own cwd, which parseDeploy deliberately never reads (see its
// own comment in commands.ts), so `name` comes back undefined in that one
// case; cmdDeploy resolves it from `c.io.cwd` instead.
test('parseDeploy: one positional path, --name overrides the basename default, "." leaves name undefined', () => {
  assert.deepEqual(parseDeploy(['./site'], { project: 'blog' }), {
    path: './site',
    project: 'blog',
    name: 'site',
  })
  assert.deepEqual(parseDeploy(['./site'], { project: 'blog', name: 'web' }), {
    path: './site',
    project: 'blog',
    name: 'web',
  })
  assert.deepEqual(parseDeploy([], { project: 'blog' }), { path: '.', project: 'blog', name: undefined })
})

// The dotenv subset `hobby deploy --env-file` reads. No interpolation and
// no escapes: what is written is what the container gets.
test('parseEnvFile: comments, blanks, export, quotes and = inside a value', () => {
  const text = [
    '# a comment',
    '',
    'PLAIN=value',
    'export EXPORTED=yes',
    'DOUBLE="has spaces"',
    "SINGLE='single'",
    'MISMATCHED="open',
    'URL=postgres://u:p@h/db?sslmode=require&x=y',
    'PADDED=abc==',
    'EMPTY=',
    'REF=$PLAIN',
    '  INDENTED = trimmed  ',
  ].join('\n')
  assert.deepEqual(parseEnvFile(text), {
    PLAIN: 'value',
    EXPORTED: 'yes',
    DOUBLE: 'has spaces',
    SINGLE: 'single',
    MISMATCHED: '"open',
    URL: 'postgres://u:p@h/db?sslmode=require&x=y',
    PADDED: 'abc==',
    EMPTY: '',
    REF: '$PLAIN',
    INDENTED: 'trimmed',
  })
})

test('parseEnvFile: an invalid key is a UsageError naming its line', () => {
  assert.throws(
    () => parseEnvFile('GOOD=1\n# comment\n1BAD=2\n'),
    (err: unknown) => err instanceof UsageError && err.message.includes('line 3')
  )
  assert.throws(
    () => parseEnvFile('GOOD=1\nno equals sign\n'),
    (err: unknown) => err instanceof UsageError && err.message.includes('line 2')
  )
})

test('parseTarget: a bare project has no resource segment', () => {
  assert.deepEqual(parseTarget('blog'), { project: 'blog', resource: null })
})

test('parseTarget: project/resource splits on the first slash', () => {
  assert.deepEqual(parseTarget('blog/analytics'), { project: 'blog', resource: 'analytics' })
})

test('parseArgs: a multi flag collects every occurrence, in order, in both spellings', () => {
  const result = parseArgs(['.', '--env', 'A=1', '--env=B=2', '--env', 'C=x=y'], { multi: ['env'] })
  assert.deepEqual(result.positionals, ['.'])
  assert.deepEqual(result.flags.env, ['A=1', 'B=2', 'C=x=y'])
  assert.throws(() => parseArgs(['--env'], { multi: ['env'] }), UsageError)
})

test('parseEnvAssignments: first = splits, keys are validated, no quote stripping', () => {
  assert.deepEqual(parseEnvAssignments(['A=1', 'URL=postgres://u:p@h/db?x=1', 'Q="quoted"']), {
    A: '1',
    URL: 'postgres://u:p@h/db?x=1',
    Q: '"quoted"',
  })
  assert.throws(() => parseEnvAssignments(['NOEQ']), /NOEQ/)
  assert.throws(() => parseEnvAssignments(['1A=2']), /not a valid variable name/)
})

// Issue #97: `hobby logs -h` used to reach the daemon as the target `-h`,
// and `hobby ls -j` silently ignored `-j`.
test('parseArgs: a single-dash token is a flag, -h is help, anything else is unknown', () => {
  assert.deepEqual(parseArgs(['blog', '-h'], { bool: ['json'] }), { positionals: ['blog'], flags: { help: true } })
  assert.throws(() => parseArgs(['-j'], { bool: ['json'] }), (err: unknown) => {
    assert.ok(err instanceof UsageError)
    assert.equal(err.message, 'unknown flag: -j')
    return true
  })
  assert.throws(() => parseArgs(['blog', '-x'], {}), UsageError)
  // A negative number is a value, not a flag, and a lone dash is a positional.
  assert.deepEqual(parseArgs(['-5', '-'], {}).positionals, ['-5', '-'])
})
