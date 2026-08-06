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
  openStore,
  resolvePaths,
  type ComputeRuntime,
  type HobbyConfig,
  type PostgresConfig,
  type Store,
} from '@hobby.sh/core'
import { ActivityTracker } from '@hobby.sh/proxy'
import { createApp, reconcile, type DaemonContext } from '../src/index.js'

function testConfig(overrides: Partial<HobbyConfig> = {}): HobbyConfig {
  return {
    image: 'postgres:18-alpine',
    proxyPort: 5432,
    studioPort: 8443,
    apiPort: 7432,
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
  return { store, runtime, paths, config: testConfig(), activity: new ActivityTracker() }
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
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())))
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
    assert.match(body.compose, /container_name: hobby-blog-primary/)
    assert.match(body.compose, /"25555:5432"/)
    assert.match(body.compose, /pgdata:\/var\/lib\/postgresql\/data/)
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

test('reconcile promotes a resource recorded sleeping whose container is actually running, to running', async () => {
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
  await ctx.runtime.start(config.containerName)

  await reconcile(ctx)

  const after = ctx.store.getResource(resource.id)
  assert.equal(after?.state, 'running')
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
