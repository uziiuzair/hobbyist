// The settings allowlist (packages/pg/src/settings.ts): what is accepted,
// how it is normalized, what is refused and with which hint, and the
// server arguments a declaration becomes.

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { HobbyError } from '@hobby.sh/core'
import {
  missingPreloads,
  nextSettings,
  refuseMissingPreloads,
  settingCatalog,
  settingsCommand,
  validateSettings,
} from '../src/index.js'

function usageError(fn: () => unknown, pattern: RegExp): HobbyError {
  try {
    fn()
  } catch (err) {
    assert.ok(err instanceof HobbyError, `expected a HobbyError, got ${String(err)}`)
    assert.equal(err.code, 'usage')
    assert.match(`${err.message} ${err.hint ?? ''}`, pattern)
    return err
  }
  assert.fail('expected a usage error')
}

test('validateSettings normalizes values and returns them sorted by name', () => {
  assert.deepEqual(
    validateSettings(
      {
        work_mem: '16MB',
        jit: false,
        shared_buffers: '256 MB',
        random_page_cost: 1.1,
        statement_timeout: '30s',
        log_statement: 'DDL',
        max_connections: 50,
      },
      'test'
    ),
    {
      jit: 'off',
      log_statement: 'ddl',
      max_connections: '50',
      random_page_cost: '1.1',
      shared_buffers: '256MB',
      statement_timeout: '30s',
      work_mem: '16MB',
    }
  )
  assert.deepEqual(validateSettings(undefined, 'test'), {})
})

test('a setting outside the allowlist is refused by name', () => {
  usageError(() => validateSettings({ data_directory: '/tmp' }, 't'), /data_directory is not a setting hobby allows/)
  usageError(() => validateSettings({ shared_bufers: '1GB' }, 't'), /--all/)
})

test('values outside the bounds, with a wrong unit, or of the wrong shape are refused', () => {
  usageError(() => validateSettings({ shared_buffers: '64GB' }, 't'), /allowed range is 1MB to 8GB/)
  usageError(() => validateSettings({ shared_buffers: '256mb' }, 't'), /mb is not a memory unit/)
  usageError(() => validateSettings({ max_connections: '2' }, 't'), /5 to 1000/)
  usageError(() => validateSettings({ max_connections: '10; drop' }, 't'), /whole number/)
  usageError(() => validateSettings({ checkpoint_timeout: '10s' }, 't'), /30s to 1d/)
  usageError(() => validateSettings({ jit: 'maybe' }, 't'), /on or off/)
  usageError(() => validateSettings({ io_method: 'io_uring' }, 't'), /worker, sync/)
  usageError(() => validateSettings({ work_mem: '4MB --x' }, 't'), /whole number/)
})

test('bare numbers use the setting base unit; -1 is accepted only where Postgres means off by it', () => {
  // shared_buffers counts 8kB pages: 128 pages is 1MB, the floor.
  assert.deepEqual(validateSettings({ shared_buffers: '128' }, 't'), { shared_buffers: '128' })
  usageError(() => validateSettings({ shared_buffers: '127' }, 't'), /allowed range/)
  assert.deepEqual(validateSettings({ log_min_duration_statement: -1 }, 't'), { log_min_duration_statement: '-1' })
  usageError(() => validateSettings({ statement_timeout: -1 }, 't'), /allowed range/)
})

test('shared_preload_libraries accepts only what the image ships and hobby allows', () => {
  assert.deepEqual(validateSettings({ shared_preload_libraries: 'pg_stat_statements, auto_explain,pg_stat_statements' }, 't'), {
    shared_preload_libraries: 'pg_stat_statements,auto_explain',
  })
  usageError(() => validateSettings({ shared_preload_libraries: 'pg_prewarm' }, 't'), /ADR 0020/)
  usageError(() => validateSettings({ shared_preload_libraries: 'pg_cron' }, 't'), /awake/)
  usageError(() => validateSettings({ shared_preload_libraries: '' }, 't'), /unset/)
})

test('a library setting needs its library preloaded, whichever side of the change removes it', () => {
  usageError(() => validateSettings({ 'pg_stat_statements.max': 10000 }, 't'), /shared_preload_libraries=pg_stat_statements/)
  const both = validateSettings({ shared_preload_libraries: 'pg_stat_statements', 'pg_stat_statements.max': 10000 }, 't')
  usageError(() => nextSettings(both, { unset: ['shared_preload_libraries'] }), /unset pg_stat_statements.max too/)
  assert.deepEqual(nextSettings(both, { unset: ['shared_preload_libraries', 'pg_stat_statements.max'] }), {})
  usageError(() => nextSettings(both, { set: { work_mem: '8MB' }, unset: ['work_mem'] }), /both set and unset/)
})

test('settingsCommand is postgres -c name=value per setting, and empty for none', () => {
  assert.deepEqual(settingsCommand(undefined), [])
  assert.deepEqual(settingsCommand({}), [])
  assert.deepEqual(settingsCommand({ work_mem: '16MB', jit: 'off' }), ['postgres', '-c', 'jit=off', '-c', 'work_mem=16MB'])
})

test('missingPreloads and refuseMissingPreloads name the library and the exact command', () => {
  assert.deepEqual(missingPreloads(['pg_trgm', 'pg_stat_statements'], {}), [
    { extension: 'pg_stat_statements', library: 'pg_stat_statements', allowed: true },
  ])
  assert.deepEqual(missingPreloads(['pg_stat_statements'], { shared_preload_libraries: 'pg_stat_statements' }), [])
  const err = usageError(
    () => refuseMissingPreloads(missingPreloads(['pg_stat_statements'], { shared_preload_libraries: 'auto_explain' }), { shared_preload_libraries: 'auto_explain' }, 'blog/primary'),
    /hobby pg config set blog\/primary shared_preload_libraries=auto_explain,pg_stat_statements/
  )
  assert.match(err.message, /pg_stat_statements only works with pg_stat_statements/)
  usageError(() => refuseMissingPreloads(missingPreloads(['pg_cron'], {}), {}, 'blog'), /does not allow/)
  refuseMissingPreloads([], {}, 'blog')
})

test('the catalog reports restartRequired from the postmaster context, with docs links for every entry', () => {
  const catalog = settingCatalog()
  const byName = new Map(catalog.map((s) => [s.name, s]))
  assert.equal(byName.get('shared_buffers')?.restartRequired, true)
  assert.equal(byName.get('work_mem')?.restartRequired, false)
  assert.equal(byName.get('shared_buffers')?.max, '8GB')
  assert.deepEqual(byName.get('shared_preload_libraries')?.values, ['pg_stat_statements', 'auto_explain'])
  assert.equal(byName.get('pg_stat_statements.max')?.library, 'pg_stat_statements')
  for (const s of catalog) {
    assert.match(s.docs, /^https:\/\/www\.postgresql\.org\/docs\/18\//, s.name)
  }
  assert.equal(byName.has('pg_prewarm.autoprewarm'), false)
})
