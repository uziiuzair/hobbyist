// POST /v1/import (packages/cli/src/daemon/import.ts) against the fake
// runtime, with ctx.importExec playing the throwaway container: it records
// the docker argv and the service file written to stdin, and answers with
// the lines the real script prints. The script itself was run against real
// containers (docs/portability/CLAUDE.md, 2026-11-17 import amendment); these
// tests pin the daemon's half: target choice, the credential's path, the
// refusals, rollback, and keeping the target awake only while it runs.

import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Readable } from 'node:stream'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createFakeRuntime, openStore, resolvePaths, type ExecFn, type HobbyConfig } from '@hobby.sh/core'
import { ActivityTracker } from '@hobby.sh/proxy'
import { createDefaultKindRegistry } from '../src/daemon/context.js'
import { parseScriptOutput } from '../src/daemon/import.js'
import { createApp, type DaemonContext } from '../src/index.js'

const SOURCE_PASSWORD = 'n30n-Pa55word!'
const SOURCE = `postgresql://alex:${encodeURIComponent(SOURCE_PASSWORD)}@ep-cool-123.us-east-2.aws.neon.tech/neondb?sslmode=require`

function testConfig(): HobbyConfig {
  return {
    image: 'postgres:18-alpine',
    proxyPort: 5432,
    proxyHost: '127.0.0.1',
    proxyTls: null,
    studioPort: 8443,
    apiPort: 7432,
    httpPort: 7433,
    domain: 'localhost',
    sleepAfterSeconds: 300,
    wakeTimeoutMs: 150,
    readinessPollMs: 20,
    queuePort: 0,
    caddyEnabled: false,
    caddyAdminPort: 2019,
    caddyStudioHost: null,
    project: null,
  }
}

const HAPPY = [
  'hobby-import pg-dump-major 18',
  'hobby-import target-objects 0',
  'hobby-import source-version 170004',
  'hobby-import source-bytes 9000000',
  'hobby-import source-extension pg_trgm public shipped',
  'hobby-import source-extension vector public missing',
  'hobby-import dump-bytes 81808',
  'hobby-import dump-tables 3',
  'hobby-import dump-extension pg_trgm',
  'hobby-import restore-exit 1',
  'hobby-import restore-errors 1',
  'hobby-import restore-error could not execute query: ERROR:  role "authenticated" does not exist',
  'hobby-import tables 3',
  'hobby-import rows 3734',
  'hobby-import target-bytes 9400000',
  'hobby-import done',
].join('\n')

interface Recorded {
  args: string[]
  stdin: string
  activeDuring: number
}

type Answer = { stdout: string; stderr?: string; fail?: boolean }

function buildContext(answer: (call: Recorded) => Answer): DaemonContext & { calls: Recorded[] } {
  const calls: Recorded[] = []
  const ctx: DaemonContext & { calls: Recorded[] } = {
    store: openStore(':memory:'),
    runtime: createFakeRuntime(),
    paths: resolvePaths({ HOBBY_HOME: join(tmpdir(), `hobby-import-test-${randomUUID()}`) }),
    config: testConfig(),
    activity: new ActivityTracker(),
    kinds: createDefaultKindRegistry(),
    probeFactory: () => async () => true,
    calls,
  }
  const exec: ExecFn = async (cmd, args, opts) => {
    assert.equal(cmd, 'docker')
    let stdin = ''
    for await (const chunk of opts?.stdin as Readable) stdin += String(chunk)
    const resource = ctx.store.listResources().find((r) => r.kind === 'postgres')
    const call: Recorded = { args, stdin, activeDuring: resource === undefined ? -1 : ctx.activity.count(resource.id) }
    calls.push(call)
    const a = answer(call)
    if (a.fail === true) {
      throw Object.assign(new Error('docker exited with 3'), { stdout: a.stdout, stderr: a.stderr ?? '' })
    }
    return { stdout: a.stdout, stderr: a.stderr ?? '' }
  }
  ctx.importExec = exec
  return ctx
}

async function withServer(ctx: DaemonContext, fn: (baseUrl: string) => Promise<void>): Promise<void> {
  const server = createServer(createApp(ctx))
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const address = server.address() as AddressInfo
  try {
    await fn(`http://127.0.0.1:${address.port}`)
  } finally {
    const closed = new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())))
    server.closeAllConnections()
    await closed
    ctx.store.close()
  }
}

async function call(baseUrl: string, method: string, path: string, body?: unknown): Promise<{ status: number; body: any; text: string }> {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  return { status: res.status, body: text.length > 0 ? JSON.parse(text) : undefined, text }
}

function assertNoSecret(text: string, what: string): void {
  assert.ok(!text.includes(SOURCE_PASSWORD), `${what} contains the source password`)
  assert.ok(!text.includes(encodeURIComponent(SOURCE_PASSWORD)), `${what} contains the encoded source password`)
  assert.ok(!text.includes(SOURCE), `${what} contains the source string`)
}

test('importing into a new project creates it, passes the credential only on stdin, and reports the copy', async () => {
  const ctx = buildContext(() => ({ stdout: HAPPY }))
  await withServer(ctx, async (baseUrl) => {
    const res = await call(baseUrl, 'POST', '/v1/import', { project: 'shop', source: SOURCE })
    assert.equal(res.status, 200, res.text)
    const report = res.body.import
    assert.equal(report.project, 'shop')
    assert.equal(report.resource, 'primary')
    assert.equal(report.created, 'project')
    assert.deepEqual(report.source, { host: 'ep-cool-123.us-east-2.aws.neon.tech', database: 'neondb', serverVersion: '17.4', bytes: 9000000, viaHostAlias: false })
    assert.equal(report.tables, 3)
    assert.equal(report.rows, 3734)
    assert.equal(report.dumpBytes, 81808)
    assert.equal(report.pgDumpMajor, 18)
    assert.deepEqual(report.extensions.copied, ['pg_trgm'])
    assert.deepEqual(report.extensions.notCopied, [{ name: 'vector', schema: 'public', shipped: false }])
    assert.equal(report.restore.errors, 1)
    assert.deepEqual(report.restore.messages, ['ERROR: role "authenticated" does not exist'])
    assertNoSecret(res.text, 'the response')

    assert.equal(ctx.calls.length, 1)
    const { args, stdin } = ctx.calls[0] as Recorded
    // Nothing secret in the argv the host's process list shows.
    assertNoSecret(args.join(' '), 'the docker argv')
    const target = ctx.store.listResources()[0]
    assert.ok(target !== undefined && target.kind === 'postgres')
    assert.ok(!args.join(' ').includes(target.config.password), 'the docker argv contains the target password')
    // The container runs from the target's own image, never pulled, on the
    // project's network.
    assert.ok(args.includes('postgres:18-alpine'))
    assert.deepEqual(args.slice(0, 5), ['run', '--rm', '-i', '--pull', 'never'])
    assert.equal(args[args.indexOf('--network') + 1], 'hobby-shop')
    assert.ok(args.includes('HOBBY_IMPORT_RESTRICTED=0'))
    // The service file on stdin carries both sessions.
    assert.match(stdin, /^\[source\]\n/)
    assert.ok(stdin.includes(`password=${SOURCE_PASSWORD}\n`))
    assert.ok(stdin.includes('sslmode=require\n'))
    assert.ok(stdin.includes('application_name=hobby-import\n'))
    assert.ok(stdin.includes('[target]\n'))
    assert.ok(stdin.includes(`host=${target.config.containerName}\n`))
    assert.ok(stdin.includes('application_name=hobby\n'))
  })
})

test('the target holds an activity handle while the container runs, and none after', async () => {
  const ctx = buildContext(() => ({ stdout: HAPPY }))
  await withServer(ctx, async (baseUrl) => {
    const res = await call(baseUrl, 'POST', '/v1/import', { project: 'shop', source: SOURCE })
    assert.equal(res.status, 200, res.text)
    assert.equal(ctx.calls[0]?.activeDuring, 1)
    const id = res.body.import.resourceId as string
    assert.equal(ctx.activity.count(id), 0)
    // The idle clock starts when the import ends, so the database sleeps on
    // its ordinary threshold afterwards.
    assert.notEqual(ctx.activity.idleSeconds(id), null)
  })
})

test('a non-empty target is refused and an existing resource is never removed', async () => {
  const ctx = buildContext(() => ({ stdout: 'hobby-import pg-dump-major 18\nhobby-import target-objects 5\n', stderr: '', fail: true }))
  await withServer(ctx, async (baseUrl) => {
    await call(baseUrl, 'POST', '/v1/projects', { name: 'shop' })
    await call(baseUrl, 'POST', '/v1/projects/shop/resources', { kind: 'postgres', name: 'primary' })
    const res = await call(baseUrl, 'POST', '/v1/import', { project: 'shop', source: SOURCE })
    assert.equal(res.status, 409, res.text)
    assert.equal(res.body.error.code, 'conflict')
    assert.match(res.body.error.message, /not empty/)
    const project = await call(baseUrl, 'GET', '/v1/projects/shop')
    assert.equal(project.body.resources.length, 1)
  })
})

test('a source newer than the image\'s pg_dump is refused clearly and the project the import created is rolled back', async () => {
  const ctx = buildContext(() => ({
    stdout: 'hobby-import pg-dump-major 16\nhobby-import target-objects 0\nhobby-import source-version 180001\n',
    fail: true,
  }))
  await withServer(ctx, async (baseUrl) => {
    const res = await call(baseUrl, 'POST', '/v1/import', { project: 'shop', source: SOURCE })
    assert.equal(res.status, 400, res.text)
    assert.match(res.body.error.message, /PostgreSQL 18.*pg_dump 16/)
    assert.match(res.body.error.hint, /issues\/2/)
    const project = await call(baseUrl, 'GET', '/v1/projects/shop')
    assert.equal(project.status, 404)
  })
})

test('extensions the image does not ship are listed before anything is restored', async () => {
  const ctx = buildContext(() => ({
    stdout: [
      'hobby-import pg-dump-major 18',
      'hobby-import target-objects 0',
      'hobby-import source-version 160000',
      'hobby-import dump-extension pg_graphql',
      'hobby-import missing-extension pg_graphql',
      'hobby-import missing-extension pgsodium',
    ].join('\n'),
    fail: true,
  }))
  await withServer(ctx, async (baseUrl) => {
    const res = await call(baseUrl, 'POST', '/v1/import', { project: 'shop', source: SOURCE })
    assert.equal(res.status, 400, res.text)
    assert.match(res.body.error.message, /pg_graphql, pgsodium/)
    assert.match(res.body.error.hint, /--schema public/)
    assert.match(res.body.error.hint, /hobby pg ext ls/)
  })
})

test('tool output that names the password is redacted before it reaches the error', async () => {
  const ctx = buildContext(() => ({
    stdout: 'hobby-import pg-dump-major 18\nhobby-import target-objects 0\nhobby-import fail connect-source\n',
    stderr: `psql: error: connection to server failed: FATAL: password authentication failed for user "alex" (tried ${SOURCE_PASSWORD} via ${SOURCE})`,
    fail: true,
  }))
  const logged: string[] = []
  const original = console.error
  console.error = (...parts: unknown[]) => logged.push(parts.map(String).join(' '))
  try {
    await withServer(ctx, async (baseUrl) => {
      const res = await call(baseUrl, 'POST', '/v1/import', { project: 'shop', source: SOURCE })
      assert.equal(res.status, 503, res.text)
      assert.equal(res.body.error.message, 'could not connect to the source database')
      assert.match(res.body.error.hint, /\[redacted\]/)
      assert.match(res.body.error.hint, /check the user and password/)
      assertNoSecret(res.text, 'the error response')
    })
  } finally {
    console.error = original
  }
  assertNoSecret(logged.join('\n'), 'the daemon log')
})

test('schema restriction passes pg_dump --schema flags as separate argv elements and marks the import restricted', async () => {
  const ctx = buildContext(() => ({
    stdout: HAPPY.replace(
      'hobby-import restore-error',
      'hobby-import restore-error could not execute query: ERROR:  schema "public" already exists\nhobby-import restore-error'
    ).replace('restore-errors 1', 'restore-errors 2'),
  }))
  await withServer(ctx, async (baseUrl) => {
    const res = await call(baseUrl, 'POST', '/v1/import', { project: 'shop', source: SOURCE, schemas: ['public'], excludeSchemas: ['audit'] })
    assert.equal(res.status, 200, res.text)
    const args = ctx.calls[0]?.args ?? []
    assert.ok(args.includes('HOBBY_IMPORT_RESTRICTED=1'))
    assert.deepEqual(args.slice(-2), ['--schema=public', '--exclude-schema=audit'])
    // pg_dump --schema=public always emits CREATE SCHEMA public; that error
    // is expected, not counted.
    assert.equal(res.body.import.restore.errors, 1)
    assert.deepEqual(res.body.import.restore.expected, ['ERROR: schema "public" already exists'])
  })
})

test('an existing project gets a new named resource, rolled back alone when the import fails', async () => {
  const ctx = buildContext(() => ({ stdout: 'hobby-import pg-dump-major 18\nhobby-import target-objects 0\nhobby-import fail dump\n', stderr: 'pg_dump: error: query failed', fail: true }))
  await withServer(ctx, async (baseUrl) => {
    await call(baseUrl, 'POST', '/v1/projects', { name: 'shop' })
    await call(baseUrl, 'POST', '/v1/projects/shop/resources', { kind: 'postgres', name: 'primary' })
    const res = await call(baseUrl, 'POST', '/v1/import', { project: 'shop', resource: 'legacy', source: SOURCE })
    assert.equal(res.status, 503, res.text)
    assert.equal(res.body.error.message, 'pg_dump failed')
    const project = await call(baseUrl, 'GET', '/v1/projects/shop')
    assert.deepEqual(project.body.resources.map((r: { name: string }) => r.name), ['primary'])
  })
})

test('a malformed source is refused before any project is created, without quoting it', async () => {
  const ctx = buildContext(() => ({ stdout: HAPPY }))
  await withServer(ctx, async (baseUrl) => {
    const bad = `host=db.example.com password=${SOURCE_PASSWORD} sslkey=/home/me/key`
    const res = await call(baseUrl, 'POST', '/v1/import', { project: 'shop', source: bad })
    assert.equal(res.status, 400)
    assert.ok(!res.text.includes(SOURCE_PASSWORD))
    assert.equal((await call(baseUrl, 'GET', '/v1/projects/shop')).status, 404)
    assert.equal(ctx.calls.length, 0)
    const missing = await call(baseUrl, 'POST', '/v1/import', { project: 'shop' })
    assert.equal(missing.status, 400)
    assert.match(missing.body.error.hint, /--from-file or --from-env/)
    const flag = await call(baseUrl, 'POST', '/v1/import', { project: 'shop', source: SOURCE, schemas: ['--file=/etc/passwd'] })
    assert.equal(flag.status, 400)
  })
})

test('docker itself failing (no script output) is reported, redacted', async () => {
  const ctx = buildContext(() => ({ stdout: '', stderr: 'Unable to find image postgres:18-alpine locally', fail: true }))
  await withServer(ctx, async (baseUrl) => {
    const res = await call(baseUrl, 'POST', '/v1/import', { project: 'shop', source: SOURCE })
    assert.equal(res.status, 503)
    assert.equal(res.body.error.message, 'the import container did not finish')
    assert.match(res.body.error.hint, /Unable to find image/)
  })
})

test('parseScriptOutput ignores lines that are not the marker', () => {
  const out = parseScriptOutput('noise\nhobby-import tables 4\nhobby-import done\nhobby-importx 1\n')
  assert.deepEqual(out.facts.get('tables'), ['4'])
  assert.equal(out.done, true)
})
