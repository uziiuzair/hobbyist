// Per-project IP allowlists, the daemon's half: the routes behind `hobby
// allow` (and the MCP tools), the proxy deps that read the list, the
// rate-limited refusal log line, inheritance at branch time, and the CLI
// command. The proxy's enforcement is in packages/proxy/test/allowlist.test.ts.

import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { rmSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { createFakeRuntime, openStore, resolvePaths, resolvePgdataPath, type HobbyConfig, type Project } from '@hobby.sh/core'
import { createPostgres } from '@hobby.sh/pg'
import { ActivityTracker } from '@hobby.sh/proxy'
import { createDefaultKindRegistry, logAccessRefusal, type DaemonContext } from '../src/daemon/context.js'
import { branchProject } from '../src/daemon/branch.js'
import { cmdAllow, createApp, createProxyDeps, type Ctx } from '../src/index.js'
import type { Api, ProjectResponse } from '../src/cli/client.js'

const homes: string[] = []
after(() => {
  for (const home of homes) rmSync(home, { recursive: true, force: true })
})

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

function buildContext(): DaemonContext {
  const home = join(tmpdir(), `hobby-allowlist-${randomUUID()}`)
  homes.push(home)
  return {
    store: openStore(':memory:'),
    runtime: createFakeRuntime(),
    paths: resolvePaths({ HOBBY_HOME: home }),
    config: testConfig(),
    activity: new ActivityTracker(),
    kinds: createDefaultKindRegistry(),
    probeFactory: () => async (): Promise<boolean> => true,
  }
}

async function withServer(ctx: DaemonContext, fn: (baseUrl: string) => Promise<void>): Promise<void> {
  const server = createServer(createApp(ctx))
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const { port } = server.address() as AddressInfo
  try {
    await fn(`http://127.0.0.1:${port}`)
  } finally {
    const closed = new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())))
    server.closeAllConnections()
    await closed
  }
}

async function call(baseUrl: string, method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  return { status: res.status, body: text.length > 0 ? JSON.parse(text) : undefined }
}

test('allowlist routes: open by default, add restricts, rm never reopens, DELETE lifts', async () => {
  const ctx = buildContext()
  ctx.store.createProject({ name: 'blog', sleepAfterSeconds: 300 })
  await withServer(ctx, async (base) => {
    let res = await call(base, 'GET', '/v1/projects/blog/allowlist')
    assert.equal(res.status, 200)
    assert.equal(res.body.project.allowlist, null)

    res = await call(base, 'POST', '/v1/projects/blog/allowlist', { add: ['192.168.1.7/24', '2001:DB8::1', '192.168.1.0/24'] })
    assert.equal(res.status, 200)
    assert.deepEqual(res.body.project.allowlist, ['192.168.1.0/24', '2001:db8::1'])

    // Persisted, and visible on the ordinary project read `hobby ls --json` uses.
    res = await call(base, 'GET', '/v1/projects/blog')
    assert.deepEqual(res.body.project.allowlist, ['192.168.1.0/24', '2001:db8::1'])

    res = await call(base, 'POST', '/v1/projects/blog/allowlist', { remove: ['10.0.0.1'] })
    assert.equal(res.status, 404)
    assert.match(res.body.error.message, /10\.0\.0\.1 is not on project blog's allowlist/)

    res = await call(base, 'POST', '/v1/projects/blog/allowlist', { remove: ['192.168.1.99/24', '2001:db8::1'] })
    assert.deepEqual(res.body.project.allowlist, [], 'removing the last entry leaves the project restricted to the box')

    res = await call(base, 'DELETE', '/v1/projects/blog/allowlist')
    assert.equal(res.status, 200)
    assert.equal(res.body.project.allowlist, null)
  })
})

test('allowlist routes refuse bad entries, empty changes and unknown projects', async () => {
  const ctx = buildContext()
  ctx.store.createProject({ name: 'blog', sleepAfterSeconds: 300 })
  await withServer(ctx, async (base) => {
    let res = await call(base, 'POST', '/v1/projects/blog/allowlist', { add: ['10.0.0.0/8', 'example.com'] })
    assert.equal(res.status, 400)
    assert.match(res.body.error.message, /"example\.com" is not an IP address or CIDR range/)
    assert.equal(ctx.store.getProjectByName('blog')?.allowlist, null, 'a bad entry changes nothing')

    res = await call(base, 'POST', '/v1/projects/blog/allowlist', {})
    assert.equal(res.status, 400)
    res = await call(base, 'POST', '/v1/projects/blog/allowlist', { add: '10.0.0.1' })
    assert.equal(res.status, 400)
    res = await call(base, 'POST', '/v1/projects/blog/allowlist', { add: ['10.0.0.1'], remove: ['10.0.0.1/32'] })
    assert.equal(res.status, 400)
    res = await call(base, 'GET', '/v1/projects/nope/allowlist')
    assert.equal(res.status, 404)
  })
})

test('createProxyDeps reads the allowlist per connection, null for an unknown project', async () => {
  const ctx = buildContext()
  const project = ctx.store.createProject({ name: 'blog', sleepAfterSeconds: 300 })
  const deps = createProxyDeps(ctx)
  assert.equal(await deps.allowlist?.('blog'), null)
  ctx.store.setProjectAllowlist(project.id, ['10.0.0.0/8'])
  assert.deepEqual(await deps.allowlist?.('blog'), ['10.0.0.0/8'])
  assert.equal(await deps.allowlist?.('nope'), null)
})

test('refusals are logged once per address per minute, not once per attempt', () => {
  const ctx = buildContext()
  const lines: string[] = []
  for (let i = 0; i < 5000; i++) {
    logAccessRefusal(ctx, { project: 'blog', address: '203.0.113.9', via: 'startup' }, (l) => lines.push(l))
  }
  logAccessRefusal(ctx, { project: 'blog', address: '198.51.100.1', via: 'cancel' }, (l) => lines.push(l))
  assert.deepEqual(lines, [
    'proxy: refused a connection to project blog from 203.0.113.9, not on its allowlist',
    'proxy: refused a cancel request to project blog from 198.51.100.1, not on its allowlist',
  ])
})

test('a branch starts with a copy of its source allowlist', async () => {
  const ctx = buildContext()
  const source: Project = ctx.store.createProject({ name: 'blog', sleepAfterSeconds: 300 })
  const resource = await createPostgres(ctx, { project: source, name: 'primary' })
  const pgdata = resolvePgdataPath(resource.config.dataDir)
  await mkdir(pgdata, { recursive: true })
  await writeFile(join(pgdata, 'PG_VERSION'), '18\n')
  ctx.store.setProjectAllowlist(source.id, ['10.0.0.0/8'])

  await branchProject(ctx, 'blog', 'blog-exp', { quiesce: { guard: async () => 'idle' } })
  const branch = ctx.store.getProjectByName('blog-exp')
  assert.deepEqual(branch?.allowlist, ['10.0.0.0/8'])

  // A copy, not a link.
  ctx.store.setProjectAllowlist(source.id, null)
  assert.deepEqual(ctx.store.getProjectByName('blog-exp')?.allowlist, ['10.0.0.0/8'])
})

function fakeCtx(project: Partial<Project> & { name: string }): { ctx: Ctx; out: string[]; calls: unknown[] } {
  const out: string[] = []
  const calls: unknown[] = []
  const response = (allowlist: string[] | null): ProjectResponse => ({ project: { ...project, allowlist } as Project })
  const api = {
    getAllowlist: async (p: string) => (calls.push(['get', p]), response(project.allowlist ?? null)),
    setAllowlist: async (p: string, change: unknown) => (calls.push(['set', p, change]), response(['10.0.0.0/8'])),
    clearAllowlist: async (p: string) => (calls.push(['clear', p]), response(null)),
  }
  const ctx = {
    api: api as unknown as Api,
    io: { out: (line: string) => out.push(line), err: () => {} },
    config: { project: null },
  } as unknown as Ctx
  return { ctx, out, calls }
}

test('hobby allow: ls by default, add and rm send entries, off clears', async () => {
  let f = fakeCtx({ name: 'blog', allowlist: null })
  assert.equal(await cmdAllow(f.ctx, ['blog'], {}), 0)
  assert.deepEqual(f.calls, [['get', 'blog']])
  assert.match(f.out[0]!, /no allowlist, any address/)

  f = fakeCtx({ name: 'blog' })
  await cmdAllow(f.ctx, ['add', 'blog', '10.0.0.0/8', '::1'], {})
  assert.deepEqual(f.calls, [['set', 'blog', { add: ['10.0.0.0/8', '::1'] }]])
  assert.deepEqual(f.out.slice(0, 2), ['project blog: allowlist, plus this box (loopback and its own apps and workers):', '  10.0.0.0/8'])

  f = fakeCtx({ name: 'blog' })
  await cmdAllow(f.ctx, ['rm', 'blog', '10.0.0.0/8'], {})
  assert.deepEqual(f.calls, [['set', 'blog', { remove: ['10.0.0.0/8'] }]])

  f = fakeCtx({ name: 'blog' })
  await cmdAllow(f.ctx, ['off', 'blog'], { json: true })
  assert.deepEqual(f.calls, [['clear', 'blog']])
  assert.deepEqual(JSON.parse(f.out[0]!).project.allowlist, null)

  f = fakeCtx({ name: 'blog' })
  await assert.rejects(cmdAllow(f.ctx, ['add', 'blog'], {}), /usage: hobby allow/)
})
