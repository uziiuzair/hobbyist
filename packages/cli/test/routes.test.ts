// Written but not executed against Docker or real Postgres, and (unlike the
// other packages' test suites, see task-3-report.md) some of these ARE
// actually run: everything here is a fake runtime, an in-memory store, and
// loopback HTTP, so nothing needs Docker or a real network. See the task
// report for exactly which tests were run and which were not, and why the
// start-route tests below assert an error shape rather than success.

import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  createFakeRuntime,
  HobbyError,
  openStore,
  resolvePaths,
  type AppConfig,
  type ComputeRuntime,
  type HobbyConfig,
  type PostgresConfig,
  type Store,
} from '@hobby.sh/core'
import { ActivityTracker } from '@hobby.sh/proxy'
import { createDefaultKindRegistry } from '../src/daemon/context.js'
import { createApp, createProxyDeps, reconcile, type DaemonContext } from '../src/index.js'

function testConfig(overrides: Partial<HobbyConfig> = {}): HobbyConfig {
  return {
    image: 'postgres:18-alpine',
    proxyPort: 5432,
    studioPort: 8443,
    apiPort: 7432,
    httpPort: 7433,
    domain: 'localhost',
    sleepAfterSeconds: 300,
    // Short on purpose: every route test below runs against a fake runtime
    // with nothing real listening on any allocated port, so any code path
    // that waits for Postgres readiness (startPostgres, createPostgres)
    // always runs out its timeout. Short values keep those tests fast
    // instead of making them either flaky or three-minutes-slow.
    wakeTimeoutMs: 150,
    readinessPollMs: 20,
    ...overrides,
  }
}

function buildContext(runtime: ComputeRuntime = createFakeRuntime()): DaemonContext {
  const store: Store = openStore(':memory:')
  const paths = resolvePaths({ HOBBY_HOME: join(tmpdir(), `hobby-cli-test-${randomUUID()}`) })
  return { store, runtime, paths, config: testConfig(), activity: new ActivityTracker(), kinds: createDefaultKindRegistry() }
}

function samplePostgresConfig(overrides: Partial<PostgresConfig> = {}): PostgresConfig {
  return {
    image: 'postgres:18-alpine',
    containerName: `hobby-blog-primary-${randomUUID()}`,
    dataDir: '/home/user/.hobby/projects/blog/primary/pgdata',
    hostPort: 25555,
    superuser: 'postgres',
    password: 'secret',
    database: 'blog',
    ...overrides,
  }
}

interface JsonResponse {
  status: number
  body: unknown
}

async function withServer(ctx: DaemonContext, fn: (baseUrl: string) => Promise<void>): Promise<void> {
  const server = createServer(createApp(ctx))
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const address = server.address() as AddressInfo
  try {
    await fn(`http://127.0.0.1:${address.port}`)
  } finally {
    // Forces any lingering keep-alive socket closed immediately rather than
    // waiting on it: server.close()'s own callback does not fire until
    // every connection has ended on its own, and a client that already got
    // its response but never explicitly closed its socket can otherwise
    // leave that wait pending indefinitely, which hangs this file's own
    // test process well after every test has already reported a result.
    const closed = new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())))
    server.closeAllConnections()
    await closed
    ctx.store.close()
  }
}

async function call(
  baseUrl: string,
  method: string,
  path: string,
  body?: unknown
): Promise<JsonResponse> {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  return { status: res.status, body: text.length > 0 ? JSON.parse(text) : undefined }
}

test('GET /v1/health returns ok', async () => {
  await withServer(buildContext(), async (baseUrl) => {
    const res = await call(baseUrl, 'GET', '/v1/health')
    assert.equal(res.status, 200)
    assert.deepEqual(res.body, { status: 'ok' })
  })
})

test('GET /v1/preflight reports runtime, filesystem and port shape without mutating anything', async () => {
  await withServer(buildContext(), async (baseUrl) => {
    const res = await call(baseUrl, 'GET', '/v1/preflight')
    assert.equal(res.status, 200)
    const body = res.body as {
      runtimeAvailable: boolean
      filesystem: { path: string; reflinkSupported: boolean; freeBytes: number }
      ports: { proxy: { port: number; bound: boolean }; studio: { port: number; bound: boolean } }
    }
    assert.equal(body.runtimeAvailable, true) // createFakeRuntime().available() always resolves true
    assert.equal(typeof body.filesystem.path, 'string')
    assert.equal(typeof body.filesystem.reflinkSupported, 'boolean')
    assert.equal(typeof body.filesystem.freeBytes, 'number')
    assert.equal(body.ports.proxy.port, 5432)
    assert.equal(body.ports.studio.port, 8443)
    assert.equal(typeof body.ports.proxy.bound, 'boolean')
    assert.equal(typeof body.ports.studio.bound, 'boolean')
  })
})

test('POST /v1/projects creates a project, and GET /v1/projects lists it', async () => {
  await withServer(buildContext(), async (baseUrl) => {
    const created = await call(baseUrl, 'POST', '/v1/projects', { name: 'blog' })
    assert.equal(created.status, 201)
    const createdBody = created.body as { project: { name: string } }
    assert.equal(createdBody.project.name, 'blog')

    const listed = await call(baseUrl, 'GET', '/v1/projects')
    assert.equal(listed.status, 200)
    const listedBody = listed.body as { projects: Array<{ name: string }> }
    assert.equal(listedBody.projects.length, 1)
    assert.equal(listedBody.projects[0]?.name, 'blog')
  })
})

test('POST /v1/projects with a taken name returns 409 name_taken', async () => {
  await withServer(buildContext(), async (baseUrl) => {
    const first = await call(baseUrl, 'POST', '/v1/projects', { name: 'blog' })
    assert.equal(first.status, 201)

    const second = await call(baseUrl, 'POST', '/v1/projects', { name: 'blog' })
    assert.equal(second.status, 409)
    const body = second.body as { error: { code: string } }
    assert.equal(body.error.code, 'name_taken')
  })
})

test('POST /v1/projects without a name returns 400 usage', async () => {
  await withServer(buildContext(), async (baseUrl) => {
    const res = await call(baseUrl, 'POST', '/v1/projects', {})
    assert.equal(res.status, 400)
    const body = res.body as { error: { code: string } }
    assert.equal(body.error.code, 'usage')
  })
})

test('POST /v1/projects with invalid JSON returns 400 usage', async () => {
  await withServer(buildContext(), async (baseUrl) => {
    const res = await fetch(`${baseUrl}/v1/projects`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{ not json',
    })
    assert.equal(res.status, 400)
    const body = (await res.json()) as { error: { code: string } }
    assert.equal(body.error.code, 'usage')
  })
})

test('GET /v1/projects/:name returns 404 project_not_found for an unknown project', async () => {
  await withServer(buildContext(), async (baseUrl) => {
    const res = await call(baseUrl, 'GET', '/v1/projects/does-not-exist')
    assert.equal(res.status, 404)
    const body = res.body as { error: { code: string } }
    assert.equal(body.error.code, 'project_not_found')
  })
})

test('GET /v1/projects/:name returns the project with its resources', async () => {
  const ctx = buildContext()
  const project = ctx.store.createProject({ name: 'blog', sleepAfterSeconds: 300 })
  ctx.store.createResource({
    projectId: project.id,
    kind: 'postgres',
    name: 'primary',
    config: samplePostgresConfig(),
  })

  await withServer(ctx, async (baseUrl) => {
    const res = await call(baseUrl, 'GET', '/v1/projects/blog')
    assert.equal(res.status, 200)
    const body = res.body as { project: { name: string }; resources: Array<{ name: string }> }
    assert.equal(body.project.name, 'blog')
    assert.equal(body.resources.length, 1)
    assert.equal(body.resources[0]?.name, 'primary')
  })
})

// The same Item 1 guarantee, but for the list-shaped route: a project's
// resources array is a second, independent place a password could have
// leaked back in (a different code path than the single-resource route
// above), so it gets its own real-body assertion rather than trusting that
// fixing one route's shape implies the other.
test('GET /v1/projects/:name never leaks config.password on any resource in the list', async () => {
  const ctx = buildContext()
  const project = ctx.store.createProject({ name: 'blog', sleepAfterSeconds: 300 })
  ctx.store.createResource({
    projectId: project.id,
    kind: 'postgres',
    name: 'primary',
    config: samplePostgresConfig({ password: 'this-must-never-cross-the-wire-either' }),
  })

  await withServer(ctx, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/v1/projects/blog`)
    const text = await res.text()
    assert.equal(res.status, 200)
    assert.ok(!text.includes('this-must-never-cross-the-wire-either'))
    assert.ok(!text.includes('"password"'))
  })
})

test('DELETE /v1/projects/:name deletes the project and its resources', async () => {
  const ctx = buildContext()
  const project = ctx.store.createProject({ name: 'blog', sleepAfterSeconds: 300 })
  const resource = ctx.store.createResource({
    projectId: project.id,
    kind: 'postgres',
    name: 'primary',
    config: samplePostgresConfig(),
  })
  ctx.store.setResourceState(resource.id, 'sleeping')

  await withServer(ctx, async (baseUrl) => {
    const res = await call(baseUrl, 'DELETE', '/v1/projects/blog')
    assert.equal(res.status, 200)
    assert.deepEqual(res.body, { deleted: true })

    const after = await call(baseUrl, 'GET', '/v1/projects/blog')
    assert.equal(after.status, 404)

    const resourceAfter = await call(baseUrl, 'GET', `/v1/resources/${resource.id}`)
    assert.equal(resourceAfter.status, 404)
  })
})

test('DELETE /v1/projects/:name returns 404 project_not_found for an unknown project', async () => {
  await withServer(buildContext(), async (baseUrl) => {
    const res = await call(baseUrl, 'DELETE', '/v1/projects/does-not-exist')
    assert.equal(res.status, 404)
    const body = res.body as { error: { code: string } }
    assert.equal(body.error.code, 'project_not_found')
  })
})

test('POST /v1/projects/:name/resources against a fake runtime eventually reports wake_failed', async () => {
  // createPostgres waits for a real Postgres readiness probe
  // (packages/pg/src/readiness.ts's pgProbe), and DaemonContext deliberately
  // never supplies PgDeps.probeFactory (see context.ts's file comment: the
  // daemon takes the real code paths). Against createFakeRuntime, nothing is
  // really listening on the allocated host port, so the probe can only ever
  // time out. This pins that the route surfaces that failure honestly as
  // wake_failed / 500, not as a hang or a misleading success.
  const ctx = buildContext()
  ctx.store.createProject({ name: 'blog', sleepAfterSeconds: 300 })

  await withServer(ctx, async (baseUrl) => {
    const res = await call(baseUrl, 'POST', '/v1/projects/blog/resources', {
      kind: 'postgres',
      name: 'primary',
    })
    assert.equal(res.status, 500)
    const body = res.body as { error: { code: string } }
    assert.equal(body.error.code, 'wake_failed')
  })
})

test('POST /v1/projects/:name/resources for an unknown project returns 404 project_not_found', async () => {
  await withServer(buildContext(), async (baseUrl) => {
    const res = await call(baseUrl, 'POST', '/v1/projects/does-not-exist/resources', {
      kind: 'postgres',
      name: 'primary',
    })
    assert.equal(res.status, 404)
    const body = res.body as { error: { code: string } }
    assert.equal(body.error.code, 'project_not_found')
  })
})

test('POST /v1/projects/:name/resources rejects an unsupported kind', async () => {
  const ctx = buildContext()
  ctx.store.createProject({ name: 'blog', sleepAfterSeconds: 300 })

  await withServer(ctx, async (baseUrl) => {
    const res = await call(baseUrl, 'POST', '/v1/projects/blog/resources', {
      kind: 'redis',
      name: 'cache',
    })
    assert.equal(res.status, 400)
    const body = res.body as { error: { code: string } }
    assert.equal(body.error.code, 'usage')
  })
})

test('GET /v1/resources/:id returns 404 resource_not_found for an unknown id', async () => {
  await withServer(buildContext(), async (baseUrl) => {
    const res = await call(baseUrl, 'GET', '/v1/resources/does-not-exist')
    assert.equal(res.status, 404)
    const body = res.body as { error: { code: string } }
    assert.equal(body.error.code, 'resource_not_found')
  })
})

test('GET /v1/resources/:id returns the resource', async () => {
  const ctx = buildContext()
  const project = ctx.store.createProject({ name: 'blog', sleepAfterSeconds: 300 })
  const resource = ctx.store.createResource({
    projectId: project.id,
    kind: 'postgres',
    name: 'primary',
    config: samplePostgresConfig(),
  })

  await withServer(ctx, async (baseUrl) => {
    const res = await call(baseUrl, 'GET', `/v1/resources/${resource.id}`)
    assert.equal(res.status, 200)
    const body = res.body as { resource: { id: string; name: string } }
    assert.equal(body.resource.id, resource.id)
    assert.equal(body.resource.name, 'primary')
  })
})

// Item 1's own test, per the task brief: the password must be absent from a
// real response body, not merely shown to work in isolation against
// toWireResource. This asserts on the raw bytes the server actually sent
// (never even reaching JSON.parse for the string-contents half of the
// check) as well as on the parsed shape, so neither a key rename nor a
// value hidden inside some other field could slip past.
test('GET /v1/resources/:id never leaks config.password, in the raw body or the parsed shape', async () => {
  const ctx = buildContext()
  const project = ctx.store.createProject({ name: 'blog', sleepAfterSeconds: 300 })
  const resource = ctx.store.createResource({
    projectId: project.id,
    kind: 'postgres',
    name: 'primary',
    config: samplePostgresConfig({ password: 'this-must-never-cross-the-wire' }),
  })

  await withServer(ctx, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/v1/resources/${resource.id}`)
    const text = await res.text()
    assert.equal(res.status, 200)
    assert.ok(!text.includes('this-must-never-cross-the-wire'), 'the raw response body must never contain the real password')
    assert.ok(!text.includes('"password"'), 'the raw response body must never contain a password key at all')

    const body = JSON.parse(text) as { resource: { config: Record<string, unknown> } }
    assert.equal(body.resource.config.password, undefined)
    assert.ok(!('password' in body.resource.config), 'config must not carry a password key, not even a blanked one')
  })
})

// Item 3's own test for the two computed fields, on the same route: a
// freshly created resource (state `creating`, per store.ts) has never run,
// so sizeBytes is null (no cached figure exists yet, and this state is not
// `running` so nothing is queried); connectionCount reflects the daemon's
// own ActivityTracker directly, with no proxy or Postgres involved at all.
test('GET /v1/resources/:id includes sizeBytes (null, nothing cached yet) and connectionCount from the ActivityTracker', async () => {
  const ctx = buildContext()
  const project = ctx.store.createProject({ name: 'blog', sleepAfterSeconds: 300 })
  const resource = ctx.store.createResource({
    projectId: project.id,
    kind: 'postgres',
    name: 'primary',
    config: samplePostgresConfig(),
  })

  await withServer(ctx, async (baseUrl) => {
    const before = await call(baseUrl, 'GET', `/v1/resources/${resource.id}`)
    const beforeBody = before.body as { resource: { sizeBytes: number | null; connectionCount: number } }
    assert.equal(beforeBody.resource.sizeBytes, null)
    assert.equal(beforeBody.resource.connectionCount, 0)

    ctx.activity.open(resource.id)
    ctx.activity.open(resource.id)

    const after = await call(baseUrl, 'GET', `/v1/resources/${resource.id}`)
    const afterBody = after.body as { resource: { connectionCount: number } }
    assert.equal(afterBody.resource.connectionCount, 2)
  })
})

test('POST /v1/resources/:id/stop stops a resource against a fake runtime', async () => {
  // Unlike start, stopPostgres never waits on a readiness probe (see
  // packages/pg/src/postgres.ts): it only calls runtime.stop(), which the
  // fake runtime resolves immediately. This is a real, fast, deterministic
  // success path.
  const ctx = buildContext()
  const project = ctx.store.createProject({ name: 'blog', sleepAfterSeconds: 300 })
  const resource = ctx.store.createResource({
    projectId: project.id,
    kind: 'postgres',
    name: 'primary',
    config: samplePostgresConfig(),
  })
  ctx.store.setResourceState(resource.id, 'running')

  await withServer(ctx, async (baseUrl) => {
    const res = await call(baseUrl, 'POST', `/v1/resources/${resource.id}/stop`)
    assert.equal(res.status, 200)
    const body = res.body as { resource: { state: string } }
    assert.equal(body.resource.state, 'sleeping')
  })
})

test('POST /v1/resources/:id/start against a fake runtime eventually reports wake_timeout', async () => {
  const ctx = buildContext()
  const project = ctx.store.createProject({ name: 'blog', sleepAfterSeconds: 300 })
  const resource = ctx.store.createResource({
    projectId: project.id,
    kind: 'postgres',
    name: 'primary',
    config: samplePostgresConfig(),
  })
  ctx.store.setResourceState(resource.id, 'sleeping')

  await withServer(ctx, async (baseUrl) => {
    const res = await call(baseUrl, 'POST', `/v1/resources/${resource.id}/start`)
    assert.equal(res.status, 504)
    const body = res.body as { error: { code: string } }
    assert.equal(body.error.code, 'wake_timeout')
  })
})

test('POST /v1/resources/:id/start for an unknown id returns 404 resource_not_found', async () => {
  await withServer(buildContext(), async (baseUrl) => {
    const res = await call(baseUrl, 'POST', '/v1/resources/does-not-exist/start')
    assert.equal(res.status, 404)
    const body = res.body as { error: { code: string } }
    assert.equal(body.error.code, 'resource_not_found')
  })
})

test('GET /v1/resources/:id/connection renders a proxy connection string', async () => {
  const ctx = buildContext()
  const project = ctx.store.createProject({ name: 'blog', sleepAfterSeconds: 300 })
  const resource = ctx.store.createResource({
    projectId: project.id,
    kind: 'postgres',
    name: 'primary',
    config: samplePostgresConfig({ superuser: 'postgres', password: 'secret', database: 'blog' }),
  })

  await withServer(ctx, async (baseUrl) => {
    const res = await call(baseUrl, 'GET', `/v1/resources/${resource.id}/connection`)
    assert.equal(res.status, 200)
    const body = res.body as { connectionString: string }
    // proxyPort (5432 in testConfig), never the resource's own hostPort:
    // connectionRoute always renders viaProxy: true, see routes.ts.
    assert.equal(body.connectionString, 'postgres://postgres:secret@127.0.0.1:5432/blog')
  })
})

test('GET /v1/resources/:id/logs returns the container logs', async () => {
  const ctx = buildContext()
  const project = ctx.store.createProject({ name: 'blog', sleepAfterSeconds: 300 })
  const resource = ctx.store.createResource({
    projectId: project.id,
    kind: 'postgres',
    name: 'primary',
    config: samplePostgresConfig(),
  })

  await withServer(ctx, async (baseUrl) => {
    const res = await call(baseUrl, 'GET', `/v1/resources/${resource.id}/logs`)
    assert.equal(res.status, 200)
    const body = res.body as { logs: string }
    assert.equal(typeof body.logs, 'string')
  })
})

// --- Item 2: POST /v1/resources/:id/query ---------------------------------

test('POST /v1/resources/:id/query for an unknown id returns 404 resource_not_found', async () => {
  await withServer(buildContext(), async (baseUrl) => {
    const res = await call(baseUrl, 'POST', '/v1/resources/does-not-exist/query', { sql: 'select 1' })
    assert.equal(res.status, 404)
    const body = res.body as { error: { code: string } }
    assert.equal(body.error.code, 'resource_not_found')
  })
})

test('POST /v1/resources/:id/query without sql returns 400 usage', async () => {
  const ctx = buildContext()
  const project = ctx.store.createProject({ name: 'blog', sleepAfterSeconds: 300 })
  const resource = ctx.store.createResource({
    projectId: project.id,
    kind: 'postgres',
    name: 'primary',
    config: samplePostgresConfig(),
  })

  await withServer(ctx, async (baseUrl) => {
    const res = await call(baseUrl, 'POST', `/v1/resources/${resource.id}/query`, {})
    assert.equal(res.status, 400)
    const body = res.body as { error: { code: string } }
    assert.equal(body.error.code, 'usage')
  })
})

test('POST /v1/resources/:id/query with a non-array params returns 400 usage', async () => {
  const ctx = buildContext()
  const project = ctx.store.createProject({ name: 'blog', sleepAfterSeconds: 300 })
  const resource = ctx.store.createResource({
    projectId: project.id,
    kind: 'postgres',
    name: 'primary',
    config: samplePostgresConfig(),
  })

  await withServer(ctx, async (baseUrl) => {
    const res = await call(baseUrl, 'POST', `/v1/resources/${resource.id}/query`, { sql: 'select 1', params: 'nope' })
    assert.equal(res.status, 400)
    const body = res.body as { error: { code: string } }
    assert.equal(body.error.code, 'usage')
  })
})

// The wake-before-query contract from the task brief, pinned the same way
// the existing start-route test above pins startPostgres's own readiness
// wait: against a fake runtime, nothing is really listening on the
// allocated host port, so waking a sleeping resource can only ever time
// out. Seeing that exact wake_timeout / 504 here, for a route that never
// calls startResource itself, is what proves queryRoute actually attempts
// to wake the resource (through the same getOrCreateWake path the proxy
// uses, see context.ts) before ever trying to run the query, rather than
// either querying a container that is not there or silently skipping the
// wake.
test('POST /v1/resources/:id/query against a sleeping resource wakes it first, and surfaces a real wake failure honestly', async () => {
  const ctx = buildContext()
  const project = ctx.store.createProject({ name: 'blog', sleepAfterSeconds: 300 })
  const resource = ctx.store.createResource({
    projectId: project.id,
    kind: 'postgres',
    name: 'primary',
    config: samplePostgresConfig(),
  })
  ctx.store.setResourceState(resource.id, 'sleeping')

  await withServer(ctx, async (baseUrl) => {
    const res = await call(baseUrl, 'POST', `/v1/resources/${resource.id}/query`, { sql: 'select 1' })
    assert.equal(res.status, 504)
    const body = res.body as { error: { code: string } }
    assert.equal(body.error.code, 'wake_timeout')

    // The wake attempt itself must have actually run (and left the
    // resource `failed`, per startPostgres's own contract on a readiness
    // timeout, packages/pg/src/postgres.ts), not been silently skipped.
    const after = ctx.store.getResource(resource.id)
    assert.equal(after?.state, 'failed')
  })
})

test('POST /v1/resources/:id/query does not attempt to wake a resource that is already running', async () => {
  const ctx = buildContext()
  const project = ctx.store.createProject({ name: 'blog', sleepAfterSeconds: 300 })
  const resource = ctx.store.createResource({
    projectId: project.id,
    kind: 'postgres',
    name: 'primary',
    config: samplePostgresConfig({ hostPort: 1 }),
  })
  ctx.store.setResourceState(resource.id, 'running')

  await withServer(ctx, async (baseUrl) => {
    const res = await call(baseUrl, 'POST', `/v1/resources/${resource.id}/query`, { sql: 'select 1' })
    // Never reaches wake_timeout/wake_failed: the resource never leaves
    // `running`, which it would if startPostgres had been called (it
    // transitions through `starting` first). Instead the query itself
    // fails fast because nothing is listening on the (deliberately
    // unroutable) hostPort, surfacing as not_ready from runQuery.
    const body = res.body as { error?: { code: string } }
    assert.notEqual(body.error?.code, 'wake_timeout')
    assert.notEqual(body.error?.code, 'wake_failed')
    assert.equal(ctx.store.getResource(resource.id)?.state, 'running')
  })
})

test('DELETE /v1/resources/:id destroys the resource', async () => {
  const ctx = buildContext()
  const project = ctx.store.createProject({ name: 'blog', sleepAfterSeconds: 300 })
  const resource = ctx.store.createResource({
    projectId: project.id,
    kind: 'postgres',
    name: 'primary',
    config: samplePostgresConfig(),
  })
  ctx.store.setResourceState(resource.id, 'sleeping')

  await withServer(ctx, async (baseUrl) => {
    const res = await call(baseUrl, 'DELETE', `/v1/resources/${resource.id}`)
    assert.equal(res.status, 200)
    assert.deepEqual(res.body, { deleted: true })

    const after = await call(baseUrl, 'GET', `/v1/resources/${resource.id}`)
    assert.equal(after.status, 404)
  })
})

test('DELETE /v1/resources/:id for an unknown id returns 404 resource_not_found', async () => {
  await withServer(buildContext(), async (baseUrl) => {
    const res = await call(baseUrl, 'DELETE', '/v1/resources/does-not-exist')
    assert.equal(res.status, 404)
    const body = res.body as { error: { code: string } }
    assert.equal(body.error.code, 'resource_not_found')
  })
})

test('POST /v1/projects/:name/eject renders a compose file grounded in the real container config', async () => {
  const ctx = buildContext()
  const project = ctx.store.createProject({ name: 'blog', sleepAfterSeconds: 300 })
  const config = samplePostgresConfig({
    containerName: 'hobby-blog-primary',
    hostPort: 25555,
    dataDir: '/home/user/.hobby/projects/blog/primary/pgdata',
  })
  ctx.store.createResource({ projectId: project.id, kind: 'postgres', name: 'primary', config })

  await withServer(ctx, async (baseUrl) => {
    const res = await call(baseUrl, 'POST', '/v1/projects/blog/eject')
    assert.equal(res.status, 200)
    const body = res.body as { compose: string; dataDirs: string[] }
    // No container_name, deliberately. This test previously asserted its
    // presence, which pinned a real defect: the emitted file reused the name
    // Hobbyist's own container holds, so `docker compose up` failed with a
    // name conflict while Hobbyist was still managing the project, which is
    // the state eject leaves you in. Verified against real Docker before and
    // after. An ejected stack that cannot start is not an escape hatch.
    assert.doesNotMatch(body.compose, /container_name:/)
    // Loopback-bound, exactly as the daemon itself publishes the container
    // (packages/core/src/docker.ts): a compose file that published the
    // database on every interface would hand the departing user a strictly
    // more exposed setup than the one they were running.
    assert.match(body.compose, /"127\.0\.0\.1:25555:5432"/)
    assert.match(body.compose, /pgdata:\/var\/lib\/postgresql"/)
    assert.deepEqual(body.dataDirs, ['/home/user/.hobby/projects/blog/primary/pgdata'])
  })
})

test('POST /v1/projects/:name/eject for an unknown project returns 404 project_not_found', async () => {
  await withServer(buildContext(), async (baseUrl) => {
    const res = await call(baseUrl, 'POST', '/v1/projects/does-not-exist/eject')
    assert.equal(res.status, 404)
    const body = res.body as { error: { code: string } }
    assert.equal(body.error.code, 'project_not_found')
  })
})

test('an unknown route returns 400 usage', async () => {
  await withServer(buildContext(), async (baseUrl) => {
    const res = await call(baseUrl, 'GET', '/v1/not-a-real-route')
    assert.equal(res.status, 400)
    const body = res.body as { error: { code: string } }
    assert.equal(body.error.code, 'usage')
  })
})

// --- reconcile -------------------------------------------------------------

test('reconcile corrects a resource recorded running whose container is absent, to failed', async () => {
  const ctx = buildContext()
  const project = ctx.store.createProject({ name: 'blog', sleepAfterSeconds: 300 })
  const resource = ctx.store.createResource({
    projectId: project.id,
    kind: 'postgres',
    name: 'primary',
    // The fake runtime was never told about this container (no
    // ensureCreated call), so runtime.inspect reports exists: false: this
    // is the "container has vanished" case the brief names explicitly.
    config: samplePostgresConfig(),
  })
  ctx.store.setResourceState(resource.id, 'running')

  await reconcile(ctx)

  const after = ctx.store.getResource(resource.id)
  assert.equal(after?.state, 'failed')
  ctx.store.close()
})

test('reconcile leaves a resource recorded sleeping whose container is stopped, unchanged', async () => {
  const ctx = buildContext()
  const project = ctx.store.createProject({ name: 'blog', sleepAfterSeconds: 300 })
  const config = samplePostgresConfig()
  const resource = ctx.store.createResource({
    projectId: project.id,
    kind: 'postgres',
    name: 'primary',
    config,
  })
  ctx.store.setResourceState(resource.id, 'sleeping')
  await ctx.runtime.ensureCreated({ name: config.containerName, image: config.image, env: {}, ports: [], binds: [] })
  // never started: exists, not running, exactly what "sleeping" already asserts

  await reconcile(ctx)

  const after = ctx.store.getResource(resource.id)
  assert.equal(after?.state, 'sleeping')
  ctx.store.close()
})

test('reconcile promotes a resource recorded sleeping whose container is running AND whose postgres answers, to running', async () => {
  const ctx = buildContext()
  // A Postgres that accepts connections. Without this the container being
  // up proves nothing: see the next test.
  ctx.probeFactory = () => async (): Promise<boolean> => true
  const project = ctx.store.createProject({ name: 'blog', sleepAfterSeconds: 300 })
  const config = samplePostgresConfig()
  const resource = ctx.store.createResource({
    projectId: project.id,
    kind: 'postgres',
    name: 'primary',
    config,
  })
  ctx.store.setResourceState(resource.id, 'sleeping')
  await ctx.runtime.ensureCreated({ name: config.containerName, image: config.image, env: {}, ports: [], binds: [] })
  await ctx.runtime.start(config.containerName)

  await reconcile(ctx)

  const after = ctx.store.getResource(resource.id)
  assert.equal(after?.state, 'running')
  // And it now has an idle clock. The activity tracker is in-memory, so a
  // daemon restart wipes it; without this touch, every resource that
  // survived a restart reported idleSeconds null forever and the
  // hibernator skipped it on every single tick, so nothing ever slept
  // again until a proxy connection happened to open and close.
  assert.notEqual(ctx.activity.idleSeconds(resource.id), null)
  ctx.store.close()
})

test('reconcile does NOT report running for a container that is up before postgres accepts connections', async () => {
  const ctx = buildContext()
  // The real case this closes: a container's published port accepts TCP the
  // instant it starts, while the postmaster is still in crash recovery. The
  // probe is the only thing that can tell the difference, and a false probe
  // is exactly what a still-booting Postgres produces.
  ctx.probeFactory = () => async (): Promise<boolean> => false
  const project = ctx.store.createProject({ name: 'blog', sleepAfterSeconds: 300 })
  const config = samplePostgresConfig()
  const resource = ctx.store.createResource({
    projectId: project.id,
    kind: 'postgres',
    name: 'primary',
    config,
  })
  ctx.store.setResourceState(resource.id, 'running')
  await ctx.runtime.ensureCreated({ name: config.containerName, image: config.image, env: {}, ports: [], binds: [] })
  await ctx.runtime.start(config.containerName)

  await reconcile(ctx)

  const after = ctx.store.getResource(resource.id)
  // `starting`, not `running`: the proxy skips the wake for a `running`
  // target (packages/proxy/src/proxy.ts's handleStartup) and would splice
  // the client straight into a Postgres that answers `FATAL: the database
  // system is starting up`. Any state other than `running` makes the proxy
  // wake it and wait for real readiness first.
  assert.notEqual(after?.state, 'running')
  assert.equal(after?.state, 'starting')
  ctx.store.close()
})

test('reconcile bounds its readiness probing: an exhausted budget records starting rather than blocking', async () => {
  const ctx = buildContext()
  let probeCalls = 0
  ctx.probeFactory = () => async (): Promise<boolean> => {
    probeCalls += 1
    return true
  }
  const project = ctx.store.createProject({ name: 'blog', sleepAfterSeconds: 300 })
  const config = samplePostgresConfig()
  const resource = ctx.store.createResource({
    projectId: project.id,
    kind: 'postgres',
    name: 'primary',
    config,
  })
  ctx.store.setResourceState(resource.id, 'running')
  await ctx.runtime.ensureCreated({ name: config.containerName, image: config.image, env: {}, ports: [], binds: [] })
  await ctx.runtime.start(config.containerName)

  // Zero budget: reconcile runs before the daemon accepts a single request,
  // so it must never spend unbounded time probing a box full of wedged
  // containers. Spent budget means "do not probe," and not probing means
  // the conservative answer, never an unverified `running`.
  await reconcile(ctx, { probeBudgetMs: 0 })

  assert.equal(probeCalls, 0, 'no probe may run once the budget is spent')
  assert.equal(ctx.store.getResource(resource.id)?.state, 'starting')
  ctx.store.close()
})

test('reconcile resolves a resource recorded stopping whose container has already stopped, to sleeping', async () => {
  const ctx = buildContext()
  const project = ctx.store.createProject({ name: 'blog', sleepAfterSeconds: 300 })
  const config = samplePostgresConfig()
  const resource = ctx.store.createResource({
    projectId: project.id,
    kind: 'postgres',
    name: 'primary',
    config,
  })
  ctx.store.setResourceState(resource.id, 'stopping')
  await ctx.runtime.ensureCreated({ name: config.containerName, image: config.image, env: {}, ports: [], binds: [] })
  // never started, so inspect reports exists && !running: exactly the
  // postcondition stopPostgres's own runtime.stop() call would have left
  // behind had the daemon survived to write `sleeping` itself.

  await reconcile(ctx)

  const after = ctx.store.getResource(resource.id)
  assert.equal(after?.state, 'sleeping')
  ctx.store.close()
})

test('reconcile resumes a resource recorded destroying and removes it', async () => {
  const ctx = buildContext()
  const project = ctx.store.createProject({ name: 'blog', sleepAfterSeconds: 300 })
  const config = samplePostgresConfig()
  const resource = ctx.store.createResource({
    projectId: project.id,
    kind: 'postgres',
    name: 'primary',
    config,
  })
  ctx.store.setResourceState(resource.id, 'destroying')
  await ctx.runtime.ensureCreated({ name: config.containerName, image: config.image, env: {}, ports: [], binds: [] })
  await ctx.runtime.start(config.containerName)

  await reconcile(ctx)

  // destroyPostgres deletes the row as its last step (see
  // packages/pg/src/postgres.ts): a resumed `destroying` resource is gone,
  // not relabeled, because there is no state left to preserve, the user
  // already asked for it to be deleted.
  assert.equal(ctx.store.getResource(resource.id), null)
  const status = await ctx.runtime.inspect(config.containerName)
  assert.equal(status.exists, false)
  ctx.store.close()
})

test('an undeployed resource survives a reconcile tick unchanged', async () => {
  // An app that has never been deployed has no container by definition.
  // Without an explicit exemption, correctedState() buckets that as
  // `missing` (reconcile.ts:137) and maps it to `failed`, so the daemon
  // would mark every code-less resource broken on its first tick.
  const ctx = buildContext()
  const project = ctx.store.createProject({ name: 'blog', sleepAfterSeconds: null })
  const config: AppConfig = {
    image: 'hobby-blog-site:seed',
    containerName: 'hobby-blog-site',
    hostPort: 15500,
    containerPort: 8080,
    hostname: 'blog-site.hobby.local',
    source: null,
    env: {},
    databaseResourceId: null,
  }
  const resource = ctx.store.createResource({
    projectId: project.id,
    kind: 'app',
    name: 'site',
    config,
  })
  ctx.store.setResourceState(resource.id, 'undeployed')

  await reconcile(ctx)

  assert.equal(ctx.store.getResource(resource.id)?.state, 'undeployed')
  ctx.store.close()
})

// ---------------------------------------------------------------------------
// eject: the read, and the handover. CLAUDE.md's first promise is "you can
// always leave," so what these pin is that the file you leave with is
// complete, and that leaving actually stops Hobbyist managing the project
// without touching the data that makes the file worth having.
// ---------------------------------------------------------------------------

async function seedProject(ctx: DaemonContext): Promise<{ projectId: string; config: PostgresConfig }> {
  const project = ctx.store.createProject({ name: 'blog', sleepAfterSeconds: 300 })
  const config = samplePostgresConfig()
  const resource = ctx.store.createResource({ projectId: project.id, kind: 'postgres', name: 'primary', config })
  ctx.store.setResourceState(resource.id, 'running')
  await ctx.runtime.ensureNetwork(project.networkName)
  await ctx.runtime.ensureCreated({ name: config.containerName, image: config.image, env: {}, ports: [], binds: [] })
  await ctx.runtime.start(config.containerName)
  return { projectId: project.id, config }
}

test('POST /v1/projects/:name/eject without release changes nothing', async () => {
  const runtime = createFakeRuntime()
  const ctx = buildContext(runtime)
  const { projectId, config } = await seedProject(ctx)

  await withServer(ctx, async (baseUrl) => {
    const res = await call(baseUrl, 'POST', '/v1/projects/blog/eject')
    assert.equal(res.status, 200)
    const body = res.body as { compose: string; dataDirs: string[]; released: boolean }
    assert.equal(body.released, false)
    assert.match(body.compose, /POSTGRES_PASSWORD: secret/)
    assert.deepEqual(body.dataDirs, [config.dataDir])

    // Inside the server scope: withServer closes the store on the way out.
    assert.notEqual(ctx.store.getProject(projectId), null, 'the project is still managed')
    assert.equal(runtime._state.get(config.containerName)?.running, true, 'the container is still running')
  })
})

test('POST /v1/projects/:name/eject?release=true hands the project over and deletes nothing', async () => {
  const runtime = createFakeRuntime()
  const ctx = buildContext(runtime)
  const { projectId, config } = await seedProject(ctx)
  const networkName = ctx.store.getProject(projectId)?.networkName as string

  await withServer(ctx, async (baseUrl) => {
    const res = await call(baseUrl, 'POST', '/v1/projects/blog/eject?release=true')
    assert.equal(res.status, 200)
    const body = res.body as { compose: string; dataDirs: string[]; released: boolean }
    assert.equal(body.released, true)
    // Rendered before anything else runs, from the rows and the real
    // credentials. A compose file with no services is the failure this
    // ordering exists to prevent.
    assert.match(body.compose, /services:\n {2}primary:/)
    assert.match(body.compose, /POSTGRES_PASSWORD: secret/)
    assert.deepEqual(body.dataDirs, [config.dataDir])

    // The whole point of the change: --release is a flag someone types once
    // out of curiosity, so it must not be the thing that loses their project.
    const project = ctx.store.getProject(projectId)
    assert.notEqual(project, null, 'the project row survives')
    assert.notEqual(project?.releasedAt, null, 'and is marked released')
    assert.equal(ctx.store.listResources(projectId).length, 1, 'the resource row survives')

    const status = await runtime.inspect(config.containerName)
    assert.equal(status.exists, true, 'the container is stopped, not removed')
    assert.equal(status.running, false)
    assert.equal(runtime._networks.has(networkName), true, 'the network survives, ready for adopt')
  })
})

test('a released project is refused by the wake path rather than woken', async () => {
  const ctx = buildContext()
  const { projectId } = await seedProject(ctx)
  ctx.store.setProjectReleased(projectId, new Date())

  // Two postgres processes on one PGDATA is corruption, not a conflict the
  // user gets an error about, so this refuses before anything starts.
  const deps = createProxyDeps(ctx)
  await assert.rejects(deps.resolve('blog'), (err: unknown) => {
    assert.ok(err instanceof HobbyError)
    assert.equal(err.code, 'conflict')
    assert.match(err.hint ?? '', /hobby adopt blog/)
    return true
  })
  ctx.store.close()
})

test('POST /v1/projects/:name/adopt takes a released project back', async () => {
  const ctx = buildContext()
  const { projectId } = await seedProject(ctx)
  ctx.store.setProjectReleased(projectId, new Date())

  await withServer(ctx, async (baseUrl) => {
    const res = await call(baseUrl, 'POST', '/v1/projects/blog/adopt')
    assert.equal(res.status, 200)
    assert.equal(ctx.store.getProject(projectId)?.releasedAt, null)

    // Nothing was rebuilt: adopting is one column changing, because nothing
    // was ever taken apart.
    const again = await call(baseUrl, 'POST', '/v1/projects/blog/adopt')
    assert.equal(again.status, 409)
    assert.equal((again.body as { error: { code: string } }).error.code, 'conflict')
  })
})

test('DELETE /v1/projects/:name removes the project network rather than leaking it', async () => {
  const runtime = createFakeRuntime()
  const ctx = buildContext(runtime)
  const { projectId } = await seedProject(ctx)
  const networkName = ctx.store.getProject(projectId)?.networkName as string
  assert.equal(runtime._networks.has(networkName), true)

  await withServer(ctx, async (baseUrl) => {
    const res = await call(baseUrl, 'DELETE', '/v1/projects/blog?force=true')
    assert.equal(res.status, 200)
    assert.equal(ctx.store.getProject(projectId), null)
    assert.equal(runtime._networks.has(networkName), false, 'nothing else ever removed a project network')
  })
})

// A daemon built before releasedAt existed answers with a project that has no
// such field. The CLI reads that response, and the first version of the ls
// display asked `releasedAt === null`, so every project served by an older
// daemon was labelled as handed over. Found by running the new CLI against the
// daemon that was already up.
test('a project payload with no releasedAt field is not treated as released', async () => {
  const ctx = buildContext()
  const { projectId } = await seedProject(ctx)

  const stored = ctx.store.getProject(projectId)
  assert.equal(stored?.releasedAt, null, 'a project that was never released reads as null, not undefined')

  // The shape an older daemon sends: the key is simply absent.
  const legacy = JSON.parse(JSON.stringify({ ...stored, releasedAt: undefined })) as { releasedAt?: string }
  assert.equal('releasedAt' in legacy, false)
  assert.equal(legacy.releasedAt != null, false, 'the loose check the CLI uses reads it as not released')
  ctx.store.close()
})
