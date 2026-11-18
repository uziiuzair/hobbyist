// `hobby import`: where the source comes from (stdin, --from-file,
// --from-env, never an argument), what is sent to the daemon, and that the
// connection string is never printed.

import assert from 'node:assert/strict'
import { chmod, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { HobbyError } from '@hobby.sh/core'
import { cmdImport, parseArgs, resolveImportSource, UsageError, type Ctx } from '../src/index.js'
import type { Api, ImportReport } from '../src/cli/client.js'

const SOURCE = 'postgresql://alex:Sup3rS3cret@ep-cool-123.us-east-2.aws.neon.tech/neondb?sslmode=require'

const REPORT: ImportReport = {
  project: 'shop',
  resource: 'primary',
  resourceId: 'r1',
  created: 'project',
  source: { host: 'ep-cool-123.us-east-2.aws.neon.tech', database: 'neondb', serverVersion: '17.4', bytes: 9_000_000, viaHostAlias: false },
  image: 'postgres:18-alpine',
  pgDumpMajor: 18,
  dumpBytes: 81808,
  dumpTables: 3,
  tables: 3,
  rows: 3734,
  rowsAreEstimates: true,
  targetBytes: 9_400_000,
  durationMs: 1200,
  extensions: { copied: ['pg_trgm'], notCopied: [] },
  restore: { errors: 0, messages: [], expected: [] },
  warnings: [],
}

function fakeCtx(opts: { stdin?: string; env?: Record<string, string>; report?: ImportReport } = {}) {
  const sent: unknown[] = []
  const out: string[] = []
  const err: string[] = []
  const api = {
    async importDatabase(input: unknown) {
      sent.push(input)
      return { import: opts.report ?? REPORT }
    },
  }
  const ctx = {
    io: {
      out: (s: string) => out.push(s),
      err: (s: string) => err.push(s),
      env: opts.env ?? {},
      cwd: '/tmp',
      readLine: async (o?: { silent?: boolean }) => {
        assert.equal(o?.silent, true, 'the stdin prompt must be silent')
        return opts.stdin ?? ''
      },
    },
    api: api as unknown as Api,
    paths: {} as Ctx['paths'],
    config: { project: null } as Ctx['config'],
  } as Ctx
  return { ctx, sent, out, err }
}

function flagsOf(argv: string[]) {
  return parseArgs(argv, {
    bool: ['json', 'strict'],
    value: ['from-env', 'from-file', 'resource'],
    multi: ['schema', 'exclude-schema'],
  })
}

test('the default reads the source from stdin with a hidden prompt, and nothing printed contains it', async () => {
  const f = fakeCtx({ stdin: `${SOURCE}\n` })
  const { positionals, flags } = flagsOf(['shop'])
  assert.equal(await cmdImport(f.ctx, positionals, flags), 0)
  assert.deepEqual(f.sent, [{ project: 'shop', source: SOURCE }])
  const printed = [...f.out, ...f.err].join('\n')
  assert.ok(!printed.includes('Sup3rS3cret'))
  assert.match(f.out.join('\n'), /3 tables, about 3734 rows/)
})

test('--from-env reads the named variable, and --schema, --exclude-schema, --resource and --strict are sent', async () => {
  const f = fakeCtx({ env: { NEON_URL: SOURCE } })
  const { positionals, flags } = flagsOf(['shop', '--from-env', 'NEON_URL', '--resource', 'legacy', '--schema', 'public', '--schema', 'app', '--exclude-schema', 'audit', '--strict', '--json'])
  assert.equal(await cmdImport(f.ctx, positionals, flags), 0)
  assert.deepEqual(f.sent, [
    { project: 'shop', source: SOURCE, resource: 'legacy', schemas: ['public', 'app'], excludeSchemas: ['audit'], strict: true },
  ])
  assert.equal(JSON.parse(f.out[0] as string).import.tables, 3)
})

test('--from-file reads and trims the file', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'hobby-import-cli-'))
  const path = join(dir, 'neon-url')
  await writeFile(path, `${SOURCE}\n`)
  await chmod(path, 0o600)
  const f = fakeCtx()
  const { positionals, flags } = flagsOf(['shop', '--from-file', path])
  await cmdImport(f.ctx, positionals, flags)
  assert.deepEqual(f.sent, [{ project: 'shop', source: SOURCE }])
})

test('a connection string given as an argument is refused without being echoed', async () => {
  const f = fakeCtx()
  const { positionals, flags } = flagsOf(['shop', SOURCE])
  await assert.rejects(
    () => cmdImport(f.ctx, positionals, flags),
    (err: unknown) => err instanceof UsageError && !err.message.includes('Sup3rS3cret') && /shell history/.test(err.message)
  )
  assert.equal(f.sent.length, 0)
})

test('a restore with errors exits 1, like pg_restore, and lists them', async () => {
  const f = fakeCtx({ stdin: SOURCE, report: { ...REPORT, restore: { errors: 1, messages: ['ERROR: role "authenticated" does not exist'], expected: [] } } })
  const { positionals, flags } = flagsOf(['shop'])
  assert.equal(await cmdImport(f.ctx, positionals, flags), 1)
  assert.match(f.out.join('\n'), /role "authenticated"/)
})

test('resolveImportSource names the variable or path in its errors, never a value', async () => {
  await assert.rejects(() => resolveImportSource({ fromEnv: 'MISSING' }, {}, null), /MISSING is not set/)
  await assert.rejects(() => resolveImportSource({ fromEnv: SOURCE }, {}, null), (err: unknown) => err instanceof HobbyError && !err.message.includes('Sup3rS3cret') && !(err.hint ?? '').includes('Sup3rS3cret'))
  await assert.rejects(() => resolveImportSource({ fromFile: '/nonexistent/hobby-import' }, {}, null), /could not read the source file \/nonexistent\/hobby-import \(ENOENT\)/)
  await assert.rejects(() => resolveImportSource({ fromEnv: 'A', fromFile: '/x' }, { A: SOURCE }, null), /not both/)
  await assert.rejects(() => resolveImportSource({}, {}, null), /no source given/)
})
