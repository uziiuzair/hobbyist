// Written but not executed against Docker or real Postgres, and (unlike the
// other packages' test suites, see task-3-report.md) some of these ARE
// actually run: everything here is a fake runtime, an in-memory store, and
// loopback HTTP, so nothing needs Docker or a real network. See the task
// report for exactly which tests were run and which were not, and why the
// start-route tests below assert an error shape rather than success.

import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, writeFileSync } from 'node:fs'
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
  type WorkerConfig,
  type WorkerManifest,
  type WorkerResource,
} from '@hobby.sh/core'
import { ActivityTracker } from '@hobby.sh/proxy'
import { DEFAULT_CONSUMER_OPTIONS, leaseBatch, openQueueDb, queueDbPath } from '@hobby.sh/queue'
import { createDefaultKindRegistry } from '../src/daemon/context.js'
import { createApp, createProxyDeps, reconcile, type DaemonContext } from '../src/index.js'
import { syncWorkerQueueBindings } from '../src/daemon/routes.js'
import { drainableQueues } from '../src/daemon/queues.js'

function testConfig(overrides: Partial<HobbyConfig> = {}): HobbyConfig {
  return {
    image: 'postgres:18-alpine',
    proxyPort: 5432,
  proxyHost: '127.0.0.1',
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
    queuePort: 0,
    caddyEnabled: false,
    caddyAdminPort: 2019,
    caddyStudioHost: null,
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

// A record-before-code app: a row, an id and a hostname, and no code. Every
// field a real undeployed app carries, not a shortcut shape, since the whole
// point of the tests that use this is to prove the daemon treats `image:
// null` faithfully rather than assuming a build already happened.
function sampleUndeployedAppConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    image: null,
    containerName: `hobby-blog-site-${randomUUID()}`,
    hostPort: 25500,
    containerPort: 8080,
    hostname: 'site.blog.hobby.local',
    source: null,
    env: {},
    databaseResourceId: null,
    ...overrides,
  }
}

// Same shape, for the worker kind: a record-before-code worker has no
// manifest either, which is the field buildRunnerManifest actually reads.
function sampleUndeployedWorkerConfig(overrides: Partial<WorkerConfig> = {}): WorkerConfig {
  return {
    image: null,
    containerName: `hobby-blog-cron-${randomUUID()}`,
    hostPort: 35500,
    containerPort: 8787,
    // Both allocated at row creation, above the manifest split, so an
    // undeployed worker carries them exactly like a deployed one does.
    controlPort: 35501,
    queueToken: 'res-placeholder-token',
    hostname: 'cron.blog.hobby.local',
    databaseResourceId: null,
    durableObjectUniqueKeyModifier: 'res-placeholder',
    manifest: null,
    ...overrides,
  }
}

// A deployed worker's manifest: what deployWorker actually persists after a
// real deploy (packages/worker/src/worker.ts's own config.manifest write).
// Queues default to empty; tests below fill in producers/consumers as their
// own scenario needs.
function sampleWorkerManifest(overrides: Partial<WorkerManifest> = {}): WorkerManifest {
  return {
    source: { path: '/src/api', manifest: 'wrangler.toml' },
    compatibilityDate: '2026-08-01',
    compatibilityFlags: [],
    vars: {},
    kvNamespaces: [],
    r2Buckets: [],
    d1Databases: [],
    queues: { producers: [], consumers: [] },
    durableObjects: [],
    ...overrides,
  }
}

// A worker that has been deployed at least once: manifest non-null, exactly
// what syncWorkerQueueBindings (routes.ts) requires to have anything to do.
function sampleDeployedWorkerConfig(overrides: Partial<WorkerConfig> = {}): WorkerConfig {
  return {
    image: 'hobby/workerd:1',
    containerName: `hobby-blog-api-${randomUUID()}`,
    hostPort: 35600,
    containerPort: 8787,
    controlPort: 35601,
    queueToken: 'res-placeholder-token',
    hostname: 'api.blog.hobby.local',
    databaseResourceId: null,
    durableObjectUniqueKeyModifier: 'res-placeholder',
    manifest: sampleWorkerManifest(),
    ...overrides,
  }
}

// One [[queues.consumers]] entry naming `queue`, every tuning key null
// (absent from wrangler.toml), which is the common case these tests start
// from before overriding the one key a given scenario cares about.
function consumerEntry(
  queue: string,
  overrides: Partial<WorkerManifest['queues']['consumers'][number]> = {}
): WorkerManifest['queues']['consumers'][number] {
  return {
    queue,
    maxBatchSize: null,
    maxBatchTimeoutSeconds: null,
    maxRetries: null,
    retryDelaySeconds: null,
    deadLetterQueue: null,
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

// The per-project sleep policy. Omitting the field keeps the config default
// (testConfig's 300); null pins the project awake from birth; the
// sleep-policy route changes it afterward. The hibernator side of the
// contract (a null threshold is checked before anything else and skips the
// project) is pinned by hibernator.test.ts; these pin the control surface.
test('POST /v1/projects without sleepAfterSeconds takes the config default', async () => {
  await withServer(buildContext(), async (baseUrl) => {
    const res = await call(baseUrl, 'POST', '/v1/projects', { name: 'blog' })
    assert.equal(res.status, 201)
    const body = res.body as { project: { sleepAfterSeconds: number | null } }
    assert.equal(body.project.sleepAfterSeconds, 300)
  })
})

test('POST /v1/projects with sleepAfterSeconds null creates a pinned project', async () => {
  await withServer(buildContext(), async (baseUrl) => {
    const res = await call(baseUrl, 'POST', '/v1/projects', { name: 'prod', sleepAfterSeconds: null })
    assert.equal(res.status, 201)
    const body = res.body as { project: { sleepAfterSeconds: number | null } }
    assert.equal(body.project.sleepAfterSeconds, null)
  })
})

test('POST /v1/projects with a custom sleepAfterSeconds stores it', async () => {
  await withServer(buildContext(), async (baseUrl) => {
    const res = await call(baseUrl, 'POST', '/v1/projects', { name: 'blog', sleepAfterSeconds: 60 })
    assert.equal(res.status, 201)
    const body = res.body as { project: { sleepAfterSeconds: number | null } }
    assert.equal(body.project.sleepAfterSeconds, 60)
  })
})

test('POST /v1/projects rejects zero, fractional and string sleepAfterSeconds', async () => {
  await withServer(buildContext(), async (baseUrl) => {
    for (const bad of [0, -5, 1.5, 'null', '300']) {
      const res = await call(baseUrl, 'POST', '/v1/projects', { name: 'blog', sleepAfterSeconds: bad })
      assert.equal(res.status, 400, `expected 400 for ${JSON.stringify(bad)}`)
      const body = res.body as { error: { code: string } }
      assert.equal(body.error.code, 'usage')
    }
  })
})

test('POST /v1/projects/:name/sleep-policy pins and unpins a project', async () => {
  await withServer(buildContext(), async (baseUrl) => {
    const created = await call(baseUrl, 'POST', '/v1/projects', { name: 'blog' })
    assert.equal(created.status, 201)

    const pinned = await call(baseUrl, 'POST', '/v1/projects/blog/sleep-policy', { sleepAfterSeconds: null })
    assert.equal(pinned.status, 200)
    assert.equal((pinned.body as { project: { sleepAfterSeconds: number | null } }).project.sleepAfterSeconds, null)

    // The change is persisted, not just echoed.
    const fetched = await call(baseUrl, 'GET', '/v1/projects/blog')
    assert.equal((fetched.body as { project: { sleepAfterSeconds: number | null } }).project.sleepAfterSeconds, null)

    const unpinned = await call(baseUrl, 'POST', '/v1/projects/blog/sleep-policy', { sleepAfterSeconds: 120 })
    assert.equal(unpinned.status, 200)
    assert.equal((unpinned.body as { project: { sleepAfterSeconds: number | null } }).project.sleepAfterSeconds, 120)
  })
})

test('POST /v1/projects/:name/sleep-policy without the field returns 400 usage', async () => {
  await withServer(buildContext(), async (baseUrl) => {
    await call(baseUrl, 'POST', '/v1/projects', { name: 'blog' })
    const res = await call(baseUrl, 'POST', '/v1/projects/blog/sleep-policy', {})
    assert.equal(res.status, 400)
    assert.equal((res.body as { error: { code: string } }).error.code, 'usage')
  })
})

test('POST /v1/projects/:name/sleep-policy on an unknown project returns 404', async () => {
  await withServer(buildContext(), async (baseUrl) => {
    const res = await call(baseUrl, 'POST', '/v1/projects/ghost/sleep-policy', { sleepAfterSeconds: null })
    assert.equal(res.status, 404)
    assert.equal((res.body as { error: { code: string } }).error.code, 'project_not_found')
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

// I2/I3: before this refusal, POST .../stop on an undeployed app wrote
// state=sleeping while image stayed null, exactly the failure `undeployed`
// exists to prevent (`hobby ls` claiming a resource can wake when it never
// can, ADR 0014's "`undeployed` is a state, not a derived condition"). Both
// kinds are covered deliberately: this branch has repeatedly shipped
// app-only coverage, and worker is the kind with the data-loss edge.
test('POST /v1/resources/:id/stop on an undeployed app refuses and leaves it undeployed', async () => {
  const ctx = buildContext()
  const project = ctx.store.createProject({ name: 'blog', sleepAfterSeconds: 300 })
  const resource = ctx.store.createResource({
    projectId: project.id,
    kind: 'app',
    name: 'site',
    config: sampleUndeployedAppConfig(),
  })
  ctx.store.setResourceState(resource.id, 'undeployed')

  await withServer(ctx, async (baseUrl) => {
    const res = await call(baseUrl, 'POST', `/v1/resources/${resource.id}/stop`)
    assert.equal(res.status, 400)
    const body = res.body as { error: { code: string; message: string } }
    assert.equal(body.error.code, 'usage')
    assert.match(body.error.message, /hobby deploy/)
    assert.equal(ctx.store.getResource(resource.id)?.state, 'undeployed')
  })
})

test('POST /v1/resources/:id/stop on an undeployed worker refuses and leaves it undeployed', async () => {
  const ctx = buildContext()
  const project = ctx.store.createProject({ name: 'blog', sleepAfterSeconds: 300 })
  const resource = ctx.store.createResource({
    projectId: project.id,
    kind: 'worker',
    name: 'cron',
    config: sampleUndeployedWorkerConfig(),
  })
  ctx.store.setResourceState(resource.id, 'undeployed')

  await withServer(ctx, async (baseUrl) => {
    const res = await call(baseUrl, 'POST', `/v1/resources/${resource.id}/stop`)
    assert.equal(res.status, 400)
    const body = res.body as { error: { code: string; message: string } }
    assert.equal(body.error.code, 'usage')
    assert.match(body.error.message, /hobby deploy/)
    assert.equal(ctx.store.getResource(resource.id)?.state, 'undeployed')
  })
})

// Before this refusal, POST .../start on an undeployed resource fell through
// to containerSpec's internal assertion and wrote state=failed: wrong code
// (`internal`, blaming the daemon for the user's own action) and an
// irreversible state change out of `undeployed`.
test('POST /v1/resources/:id/start on an undeployed app refuses and leaves it undeployed', async () => {
  const ctx = buildContext()
  const project = ctx.store.createProject({ name: 'blog', sleepAfterSeconds: 300 })
  const resource = ctx.store.createResource({
    projectId: project.id,
    kind: 'app',
    name: 'site',
    config: sampleUndeployedAppConfig(),
  })
  ctx.store.setResourceState(resource.id, 'undeployed')

  await withServer(ctx, async (baseUrl) => {
    const res = await call(baseUrl, 'POST', `/v1/resources/${resource.id}/start`)
    assert.equal(res.status, 400)
    const body = res.body as { error: { code: string; message: string } }
    assert.equal(body.error.code, 'usage')
    assert.match(body.error.message, /hobby deploy/)
    assert.equal(ctx.store.getResource(resource.id)?.state, 'undeployed')
  })
})

test('POST /v1/resources/:id/start on an undeployed worker refuses and leaves it undeployed', async () => {
  const ctx = buildContext()
  const project = ctx.store.createProject({ name: 'blog', sleepAfterSeconds: 300 })
  const resource = ctx.store.createResource({
    projectId: project.id,
    kind: 'worker',
    name: 'cron',
    config: sampleUndeployedWorkerConfig(),
  })
  ctx.store.setResourceState(resource.id, 'undeployed')

  await withServer(ctx, async (baseUrl) => {
    const res = await call(baseUrl, 'POST', `/v1/resources/${resource.id}/start`)
    assert.equal(res.status, 400)
    const body = res.body as { error: { code: string; message: string } }
    assert.equal(body.error.code, 'usage')
    assert.match(body.error.message, /hobby deploy/)
    assert.equal(ctx.store.getResource(resource.id)?.state, 'undeployed')
  })
})

// Minor fix, same guard: `hobby logs` on an undeployed resource used to
// surface a raw runtime error instead of telling the caller what to do.
test('GET /v1/resources/:id/logs on an undeployed app refuses with a usage error', async () => {
  const ctx = buildContext()
  const project = ctx.store.createProject({ name: 'blog', sleepAfterSeconds: 300 })
  const resource = ctx.store.createResource({
    projectId: project.id,
    kind: 'app',
    name: 'site',
    config: sampleUndeployedAppConfig(),
  })
  ctx.store.setResourceState(resource.id, 'undeployed')

  await withServer(ctx, async (baseUrl) => {
    const res = await call(baseUrl, 'GET', `/v1/resources/${resource.id}/logs`)
    assert.equal(res.status, 400)
    const body = res.body as { error: { code: string } }
    assert.equal(body.error.code, 'usage')
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

test('GET /v1/resources/:id/connection renders a tailnet string when a tailnet is detected', async () => {
  const ctx = buildContext()
  ctx.detectTailnet = async () => 'box.tail1234.ts.net'
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
    const body = res.body as { connectionString: string; tailnetConnectionString: string | null }
    assert.equal(body.connectionString, 'postgres://postgres:secret@127.0.0.1:5432/blog')
    // Same proxyPort: the tailnet path terminates at the same wake proxy,
    // only the host differs.
    assert.equal(body.tailnetConnectionString, 'postgres://postgres:secret@box.tail1234.ts.net:5432/blog')
  })
})

test('GET /v1/resources/:id/connection renders tailnetConnectionString null with no detector', async () => {
  const ctx = buildContext()
  const project = ctx.store.createProject({ name: 'blog', sleepAfterSeconds: 300 })
  const resource = ctx.store.createResource({
    projectId: project.id,
    kind: 'postgres',
    name: 'primary',
    config: samplePostgresConfig(),
  })

  await withServer(ctx, async (baseUrl) => {
    const res = await call(baseUrl, 'GET', `/v1/resources/${resource.id}/connection`)
    assert.equal(res.status, 200)
    const body = res.body as { tailnetConnectionString: string | null }
    assert.equal(body.tailnetConnectionString, null)
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

// ---------------------------------------------------------------------------
// Queue routes (Task 16). Every test below drives the same fake-runtime,
// in-memory-store harness the rest of this file uses; a queue holds no
// container, so none of these ever touch createFakeRuntime's own state.
// ---------------------------------------------------------------------------

interface QueueResourceBody {
  id: string
  kind: string
  state: string
  name: string
  config: {
    retentionSeconds: number
    consumerResourceId: string | null
    deadLetterQueue: string | null
  }
}

test('POST /v1/projects/:name/resources with kind queue creates a running queue with default settings', async () => {
  await withServer(buildContext(), async (baseUrl) => {
    await call(baseUrl, 'POST', '/v1/projects', { name: 'blog' })
    const res = await call(baseUrl, 'POST', '/v1/projects/blog/resources', { kind: 'queue', name: 'jobs' })
    assert.equal(res.status, 201)
    const body = res.body as { resource: QueueResourceBody }
    // Running from the moment it exists: a queue has no container to wait
    // on, and queue-kind.test.ts already pins that this state never changes.
    assert.equal(body.resource.kind, 'queue')
    assert.equal(body.resource.state, 'running')
    assert.equal(body.resource.config.retentionSeconds, 345600)
    assert.equal(body.resource.config.consumerResourceId, null)
  })
})

test('GET /v1/projects/:name/queues lists depth, oldest message age, consumer and dead letter queue', async () => {
  const ctx = buildContext()
  const project = ctx.store.createProject({ name: 'blog', sleepAfterSeconds: 300 })
  // An undeployed worker: manifest is null, the record-before-code resting
  // state for a row nothing has ever deployed to.
  const worker = ctx.store.createResource({
    projectId: project.id,
    kind: 'worker',
    name: 'consumer',
    config: sampleUndeployedWorkerConfig(),
  })

  await withServer(ctx, async (baseUrl) => {
    const created = await call(baseUrl, 'POST', '/v1/projects/blog/resources', { kind: 'queue', name: 'jobs' })
    const queueBody = created.body as { resource: QueueResourceBody }
    const queueId = queueBody.resource.id

    // Bound directly through the store: nothing in this task ever writes
    // consumerResourceId itself (no task before it does either, see the
    // task report), only reads it, so this stands in for whatever future
    // deploy-time wiring sets it.
    const queueResource = ctx.store.getResource(queueId)
    assert.ok(queueResource !== null && queueResource.kind === 'queue')
    ctx.store.updateResourceConfig(queueId, {
      ...queueResource.config,
      consumerResourceId: worker.id,
      deadLetterQueue: 'jobs-dlq',
    })

    const sent = await call(baseUrl, 'POST', `/v1/resources/${queueId}/queue/messages`, { body: { n: 1 } })
    assert.equal(sent.status, 201)

    const res = await call(baseUrl, 'GET', '/v1/projects/blog/queues')
    assert.equal(res.status, 200)
    const body = res.body as {
      queues: Array<{
        resource: QueueResourceBody
        depth: number
        oldestMessageAgeSeconds: number | null
        consumer: { name: string; kind: string; config: { manifest: unknown } } | null
      }>
    }
    const entry = body.queues[0]
    assert.equal(body.queues.length, 1)
    assert.ok(entry !== undefined)
    assert.equal(entry.resource.name, 'jobs')
    assert.equal(entry.depth, 1)
    assert.equal(typeof entry.oldestMessageAgeSeconds, 'number')
    assert.equal(entry.resource.config.deadLetterQueue, 'jobs-dlq')
    assert.ok(entry.consumer !== null)
    assert.equal(entry.consumer?.name, 'consumer')
    // The fact `hobby queue ls` renders as "(no code yet)"
    // (packages/cli/src/cli/output.ts's renderQueueConsumer): this route's
    // job is only to hand back the fact, manifest === null, honestly.
    assert.equal(entry.consumer?.config.manifest, null)
  })
})

test('GET /v1/resources/:id/queue/messages peeks oldest-first without leasing, so the message is still leasable afterward', async () => {
  const ctx = buildContext()
  ctx.store.createProject({ name: 'blog', sleepAfterSeconds: 300 })

  await withServer(ctx, async (baseUrl) => {
    const created = await call(baseUrl, 'POST', '/v1/projects/blog/resources', { kind: 'queue', name: 'jobs' })
    const queueId = (created.body as { resource: QueueResourceBody }).resource.id

    await call(baseUrl, 'POST', `/v1/resources/${queueId}/queue/messages`, { body: 'first' })
    await call(baseUrl, 'POST', `/v1/resources/${queueId}/queue/messages`, { body: 'second' })

    const peeked = await call(baseUrl, 'GET', `/v1/resources/${queueId}/queue/messages`)
    assert.equal(peeked.status, 200)
    const messages = (peeked.body as { messages: Array<{ id: string; body: unknown; attempts: number }> }).messages
    assert.equal(messages.length, 2)
    assert.equal(messages[0]?.body, 'first', 'oldest first')
    assert.equal(messages[0]?.attempts, 0, 'peek must never claim a lease, so attempts stays at its inserted value')

    // The real proof that peek did not lease anything: open the same sqlite
    // file the route just read from and ask the broker itself to lease a
    // batch. leaseBatch's own readyRows query is `WHERE lease_id IS NULL`
    // (packages/queue/src/broker.ts), so this only returns both messages if
    // peek left lease_id untouched on both rows.
    const db = openQueueDb(queueDbPath(ctx.paths, 'blog', 'jobs'))
    try {
      const batch = leaseBatch(db, DEFAULT_CONSUMER_OPTIONS, Date.now())
      assert.ok(batch !== null)
      assert.equal(batch?.messages.length, 2, 'both messages were still unleased and claimable')
    } finally {
      db.close()
    }
  })
})

test('DELETE /v1/resources/:id/queue/messages purges every message and returns the count', async () => {
  const ctx = buildContext()
  ctx.store.createProject({ name: 'blog', sleepAfterSeconds: 300 })

  await withServer(ctx, async (baseUrl) => {
    const created = await call(baseUrl, 'POST', '/v1/projects/blog/resources', { kind: 'queue', name: 'jobs' })
    const queueId = (created.body as { resource: QueueResourceBody }).resource.id

    for (const body of ['a', 'b', 'c']) {
      await call(baseUrl, 'POST', `/v1/resources/${queueId}/queue/messages`, { body })
    }

    const purged = await call(baseUrl, 'DELETE', `/v1/resources/${queueId}/queue/messages`)
    assert.equal(purged.status, 200)
    assert.deepEqual(purged.body, { purged: 3 })

    const after = await call(baseUrl, 'GET', `/v1/resources/${queueId}/queue/messages`)
    assert.deepEqual((after.body as { messages: unknown[] }).messages, [], 'the queue is empty after purge')

    // A second purge against an already-empty queue is not an error and
    // reports zero, matching broker.ts's own purge() contract.
    const purgedAgain = await call(baseUrl, 'DELETE', `/v1/resources/${queueId}/queue/messages`)
    assert.deepEqual(purgedAgain.body, { purged: 0 })
  })
})

test('DELETE /v1/resources/:id refuses to delete a queue while a worker binds it as consumer, naming that worker', async () => {
  const ctx = buildContext()
  const project = ctx.store.createProject({ name: 'blog', sleepAfterSeconds: 300 })
  const worker = ctx.store.createResource({
    projectId: project.id,
    kind: 'worker',
    name: 'api',
    config: sampleUndeployedWorkerConfig(),
  })

  await withServer(ctx, async (baseUrl) => {
    const created = await call(baseUrl, 'POST', '/v1/projects/blog/resources', { kind: 'queue', name: 'jobs' })
    const queueId = (created.body as { resource: QueueResourceBody }).resource.id
    const queueResource = ctx.store.getResource(queueId)
    assert.ok(queueResource !== null && queueResource.kind === 'queue')
    ctx.store.updateResourceConfig(queueId, { ...queueResource.config, consumerResourceId: worker.id })

    const res = await call(baseUrl, 'DELETE', `/v1/resources/${queueId}`)
    assert.equal(res.status, 400)
    const body = res.body as { error: { code: string; message: string } }
    assert.equal(body.error.code, 'usage')
    assert.match(body.error.message, /api/, 'the refusal names the binding worker')

    // Nothing was torn down: the resource still exists and is not left in
    // `destroying`, which is the state it would have been moved to before
    // the refusal if the check ran after that write instead of before it.
    const still = await call(baseUrl, 'GET', `/v1/resources/${queueId}`)
    assert.equal(still.status, 200)
    assert.equal((still.body as { resource: QueueResourceBody }).resource.state, 'running')

    // Unbinding it (as though the worker were redeployed without the queue,
    // or deleted) makes the delete succeed.
    ctx.store.updateResourceConfig(queueId, { ...queueResource.config, consumerResourceId: null })
    const deleted = await call(baseUrl, 'DELETE', `/v1/resources/${queueId}`)
    assert.equal(deleted.status, 200)
  })
})

test('POST /v1/resources/:id/queue/retention rejects a value outside Cloudflare bounds, and accepts one inside them', async () => {
  const ctx = buildContext()
  ctx.store.createProject({ name: 'blog', sleepAfterSeconds: 300 })

  await withServer(ctx, async (baseUrl) => {
    const created = await call(baseUrl, 'POST', '/v1/projects/blog/resources', { kind: 'queue', name: 'jobs' })
    const queueId = (created.body as { resource: QueueResourceBody }).resource.id

    const tooLow = await call(baseUrl, 'POST', `/v1/resources/${queueId}/queue/retention`, { retentionSeconds: 59 })
    assert.equal(tooLow.status, 400)
    const tooLowBody = tooLow.body as { error: { code: string; message: string } }
    assert.equal(tooLowBody.error.code, 'usage')
    assert.match(tooLowBody.error.message, /60/, 'the refusal names the real lower bound')

    const tooHigh = await call(baseUrl, 'POST', `/v1/resources/${queueId}/queue/retention`, {
      retentionSeconds: 1209601,
    })
    assert.equal(tooHigh.status, 400)
    const tooHighBody = tooHigh.body as { error: { code: string; message: string } }
    assert.match(tooHighBody.error.message, /1209600/, 'the refusal names the real upper bound')

    const ok = await call(baseUrl, 'POST', `/v1/resources/${queueId}/queue/retention`, { retentionSeconds: 3600 })
    assert.equal(ok.status, 200)
    assert.equal((ok.body as { resource: QueueResourceBody }).resource.config.retentionSeconds, 3600)

    // Nothing was silently clamped by the two rejected calls above: the
    // resource still carries the value the successful call set.
    const after = await call(baseUrl, 'GET', `/v1/resources/${queueId}`)
    assert.equal((after.body as { resource: QueueResourceBody }).resource.config.retentionSeconds, 3600)
  })
})

// ---------------------------------------------------------------------------
// syncWorkerQueueBindings (Task 16 fix round 1): the deploy-time wiring that
// creates a queue a worker's manifest names, binds a consumer, and refuses
// or clears as the manifest changes. Called directly against a
// DaemonContext rather than driven through a full HTTP deploy: deployWorker
// needs a real build and a real readiness probe, and this daemon's test
// harness has no seam to fake worker readiness the way postgres's
// probeFactory lets routes.test.ts fake postgres (see buildContext's own
// comment). deployResourceRoute's own call site (routes.ts) is what actually
// wires this into production; this file pins what it does once called.
// ---------------------------------------------------------------------------

test('syncWorkerQueueBindings creates a queue a consumer names, binds it to the worker, and the queue then appears in the drainable list', async () => {
  const ctx = buildContext()
  const project = ctx.store.createProject({ name: 'blog', sleepAfterSeconds: 300 })
  const worker = ctx.store.createResource({
    projectId: project.id,
    kind: 'worker',
    name: 'api',
    config: sampleDeployedWorkerConfig({
      manifest: sampleWorkerManifest({ queues: { producers: [], consumers: [consumerEntry('jobs')] } }),
    }),
  }) as WorkerResource
  ctx.store.setResourceState(worker.id, 'sleeping')

  assert.equal(ctx.store.getResourceByName(project.id, 'jobs'), null, 'the queue does not exist yet')

  await syncWorkerQueueBindings(ctx, project, worker)

  const queue = ctx.store.getResourceByName(project.id, 'jobs')
  assert.ok(queue !== null && queue.kind === 'queue', 'the queue was created')
  assert.equal(queue.config.consumerResourceId, worker.id, 'bound to the deploying worker')
  assert.equal(queue.state, 'running')

  // The assertion that pins the actual gap the fix round found: a field set
  // on the row is not the same thing as reaching the tick. drainableQueues
  // is the join the tick actually reads (packages/cli/src/daemon/queues.ts),
  // and it excludes a queue for four separate reasons (kind, no consumer, no
  // deployed code, released project); this worker satisfies all four.
  const drainable = drainableQueues(ctx)
  assert.equal(drainable.length, 1)
  assert.equal(drainable[0]?.queueName, 'jobs')
  assert.equal(drainable[0]?.consumerResourceId, worker.id)

  ctx.store.close()
})

test('syncWorkerQueueBindings creates a producer-only queue with no consumer bound', async () => {
  const ctx = buildContext()
  const project = ctx.store.createProject({ name: 'blog', sleepAfterSeconds: 300 })
  const worker = ctx.store.createResource({
    projectId: project.id,
    kind: 'worker',
    name: 'api',
    config: sampleDeployedWorkerConfig({
      manifest: sampleWorkerManifest({ queues: { producers: [{ queue: 'events', binding: 'EVENTS' }], consumers: [] } }),
    }),
  }) as WorkerResource

  await syncWorkerQueueBindings(ctx, project, worker)

  const queue = ctx.store.getResourceByName(project.id, 'events')
  assert.ok(queue !== null && queue.kind === 'queue')
  assert.equal(queue.config.consumerResourceId, null, 'nothing declared itself this queue\'s consumer')

  // Not drainable either: drainableQueues excludes any queue with no
  // consumer bound, exactly like a Cloudflare queue nothing consumes.
  assert.equal(drainableQueues(ctx).length, 0)

  ctx.store.close()
})

test('syncWorkerQueueBindings creates a consumer\'s dead letter queue too', async () => {
  const ctx = buildContext()
  const project = ctx.store.createProject({ name: 'blog', sleepAfterSeconds: 300 })
  const worker = ctx.store.createResource({
    projectId: project.id,
    kind: 'worker',
    name: 'api',
    config: sampleDeployedWorkerConfig({
      manifest: sampleWorkerManifest({
        queues: { producers: [], consumers: [consumerEntry('jobs', { deadLetterQueue: 'jobs-dlq' })] },
      }),
    }),
  }) as WorkerResource

  await syncWorkerQueueBindings(ctx, project, worker)

  const jobs = ctx.store.getResourceByName(project.id, 'jobs')
  assert.ok(jobs !== null && jobs.kind === 'queue')
  assert.equal(jobs.config.deadLetterQueue, 'jobs-dlq')

  const dlq = ctx.store.getResourceByName(project.id, 'jobs-dlq')
  assert.ok(dlq !== null && dlq.kind === 'queue', 'the dead letter queue itself was created, matching Cloudflare')
  // Named as a dead letter target, not as a consumer: nothing consumes the
  // dead letter queue itself just because it was auto-created.
  assert.equal(dlq.config.consumerResourceId, null)

  ctx.store.close()
})

test('syncWorkerQueueBindings copies only the tuning keys the manifest actually set, leaving the rest null', async () => {
  const ctx = buildContext()
  const project = ctx.store.createProject({ name: 'blog', sleepAfterSeconds: 300 })
  const worker = ctx.store.createResource({
    projectId: project.id,
    kind: 'worker',
    name: 'api',
    config: sampleDeployedWorkerConfig({
      manifest: sampleWorkerManifest({
        queues: { producers: [], consumers: [consumerEntry('jobs', { maxBatchSize: 20 })] },
      }),
    }),
  }) as WorkerResource

  await syncWorkerQueueBindings(ctx, project, worker)

  const queue = ctx.store.getResourceByName(project.id, 'jobs')
  assert.ok(queue !== null && queue.kind === 'queue')
  assert.equal(queue.config.maxBatchSize, 20, 'the manifest set this explicitly')
  assert.equal(queue.config.maxBatchTimeoutSeconds, null, 'the manifest left this unset; the row is not stamped with a default')
  assert.equal(queue.config.maxRetries, null)
  assert.equal(queue.config.retryDelaySeconds, null)

  ctx.store.close()
})

test('syncWorkerQueueBindings refuses a second worker consuming an already-consumed queue, naming both workers', async () => {
  const ctx = buildContext()
  const project = ctx.store.createProject({ name: 'blog', sleepAfterSeconds: 300 })
  const alpha = ctx.store.createResource({
    projectId: project.id,
    kind: 'worker',
    name: 'alpha',
    config: sampleDeployedWorkerConfig({
      manifest: sampleWorkerManifest({ queues: { producers: [], consumers: [consumerEntry('jobs')] } }),
    }),
  }) as WorkerResource
  await syncWorkerQueueBindings(ctx, project, alpha)

  const beta = ctx.store.createResource({
    projectId: project.id,
    kind: 'worker',
    name: 'beta',
    config: sampleDeployedWorkerConfig({
      manifest: sampleWorkerManifest({ queues: { producers: [], consumers: [consumerEntry('jobs')] } }),
    }),
  }) as WorkerResource

  await assert.rejects(
    () => syncWorkerQueueBindings(ctx, project, beta),
    (err: unknown) =>
      err instanceof HobbyError &&
      err.code === 'usage' &&
      err.message.includes('alpha') &&
      err.message.includes('beta') &&
      err.message.includes('jobs')
  )

  // Refused, not stolen: alpha's binding is exactly as it was.
  const queue = ctx.store.getResourceByName(project.id, 'jobs')
  assert.ok(queue !== null && queue.kind === 'queue')
  assert.equal(queue.config.consumerResourceId, alpha.id)

  ctx.store.close()
})

test('syncWorkerQueueBindings clears a stale consumer binding once the redeployed manifest no longer names it', async () => {
  const ctx = buildContext()
  const project = ctx.store.createProject({ name: 'blog', sleepAfterSeconds: 300 })
  const worker = ctx.store.createResource({
    projectId: project.id,
    kind: 'worker',
    name: 'api',
    config: sampleDeployedWorkerConfig({
      manifest: sampleWorkerManifest({ queues: { producers: [], consumers: [consumerEntry('jobs')] } }),
    }),
  }) as WorkerResource
  await syncWorkerQueueBindings(ctx, project, worker)

  const bound = ctx.store.getResourceByName(project.id, 'jobs')
  assert.ok(bound !== null && bound.kind === 'queue')
  assert.equal(bound.config.consumerResourceId, worker.id)

  // A redeploy whose manifest no longer declares the consumer: the same
  // worker row, a different manifest, exactly what deployWorker persists
  // before this function is ever called again.
  const redeployed = ctx.store.getResource(worker.id)
  assert.ok(redeployed !== null && redeployed.kind === 'worker')
  ctx.store.updateResourceConfig(worker.id, {
    ...redeployed.config,
    manifest: sampleWorkerManifest({ queues: { producers: [], consumers: [] } }),
  })
  const afterRedeploy = ctx.store.getResource(worker.id)
  assert.ok(afterRedeploy !== null && afterRedeploy.kind === 'worker')

  await syncWorkerQueueBindings(ctx, project, afterRedeploy)

  const releasedQueue = ctx.store.getResourceByName(project.id, 'jobs')
  assert.ok(releasedQueue !== null && releasedQueue.kind === 'queue')
  assert.equal(releasedQueue.config.consumerResourceId, null, 'a stale pointer must not survive a redeploy that dropped it')
  assert.equal(drainableQueues(ctx).length, 0, 'no longer drainable: nothing consumes it now')

  ctx.store.close()
})

// ---------------------------------------------------------------------------
// Fix round 2: the two-consumers conflict has to be refused BEFORE anything
// is built, not after. The tests above call syncWorkerQueueBindings
// directly and cannot pin this: they never touch the runtime at all. These
// two go through the real HTTP routes (deployResourceRoute and
// createResourceRoute), with a real wrangler.toml on disk for
// findWranglerManifest to read, and assert the runtime's own build call
// count and the resource's own row, not just the response.
// ---------------------------------------------------------------------------

function conflictingWranglerToml(queueName: string): string {
  return `main = "src/index.ts"\ncompatibility_date = "2026-08-01"\n\n[[queues.consumers]]\nqueue = "${queueName}"\n`
}

test('redeploying a worker onto a queue another worker already consumes is refused before deployWorker builds anything, and the worker is left exactly as it was', async () => {
  const runtime = createFakeRuntime()
  const ctx = buildContext(runtime)
  const project = ctx.store.createProject({ name: 'blog', sleepAfterSeconds: 300 })

  // alpha already consumes "jobs". Set up directly through the store and
  // syncWorkerQueueBindings, not through a real HTTP deploy: this file's
  // own header comment explains why a genuinely successful worker deploy
  // is not drivable through this harness (no seam to fake worker
  // readiness). The precondition this test needs, "a queue already has a
  // consumer", does not require one.
  const alpha = ctx.store.createResource({
    projectId: project.id,
    kind: 'worker',
    name: 'alpha',
    config: sampleDeployedWorkerConfig({
      manifest: sampleWorkerManifest({ queues: { producers: [], consumers: [consumerEntry('jobs')] } }),
    }),
  }) as WorkerResource
  ctx.store.setResourceState(alpha.id, 'sleeping')
  await syncWorkerQueueBindings(ctx, project, alpha)

  // beta: already deployed once, to something with no queue binding at
  // all. This is the worker under test; its own pre-existing image and
  // state are exactly what the refused redeploy attempt below must leave
  // untouched.
  const betaConfig = sampleDeployedWorkerConfig({ image: 'hobby/beta:previous-build' })
  const beta = ctx.store.createResource({ projectId: project.id, kind: 'worker', name: 'beta', config: betaConfig }) as WorkerResource
  ctx.store.setResourceState(beta.id, 'sleeping')

  const buildsBefore = runtime._builds.length

  const dir = mkdtempSync(join(tmpdir(), 'hobby-queue-conflict-deploy-'))
  writeFileSync(join(dir, 'wrangler.toml'), conflictingWranglerToml('jobs'))

  await withServer(ctx, async (baseUrl) => {
    const res = await call(baseUrl, 'POST', `/v1/resources/${beta.id}/deploy`, { source: { path: dir } })
    assert.equal(res.status, 400)
    const body = res.body as { error: { code: string; message: string } }
    assert.equal(body.error.code, 'usage')
    assert.match(body.error.message, /alpha/, 'names the worker that already consumes it')
    assert.match(body.error.message, /beta/, 'names the worker that was refused')
    assert.match(body.error.message, /jobs/, 'names the queue')

    // The assertion that pins this fix round: nothing was built for the
    // refused attempt, and beta's own row is exactly as it was before it.
    assert.equal(runtime._builds.length, buildsBefore, 'the runtime was never asked to build an image')
    const after = ctx.store.getResource(beta.id)
    assert.ok(after !== null && after.kind === 'worker')
    assert.equal(after.state, 'sleeping', 'state is unchanged from before the refused attempt')
    assert.equal(after.config.image, betaConfig.image, 'the previous image survives, nothing new was committed')

    // alpha's own binding is untouched too.
    const jobs = ctx.store.getResourceByName(project.id, 'jobs')
    assert.ok(jobs !== null && jobs.kind === 'queue')
    assert.equal(jobs.config.consumerResourceId, alpha.id)
  })
})

test('creating a brand new worker whose manifest conflicts with an existing consumer is refused before anything is built, and no row is left behind', async () => {
  const runtime = createFakeRuntime()
  const ctx = buildContext(runtime)
  const project = ctx.store.createProject({ name: 'blog', sleepAfterSeconds: 300 })

  const alpha = ctx.store.createResource({
    projectId: project.id,
    kind: 'worker',
    name: 'alpha',
    config: sampleDeployedWorkerConfig({
      manifest: sampleWorkerManifest({ queues: { producers: [], consumers: [consumerEntry('jobs')] } }),
    }),
  }) as WorkerResource
  await syncWorkerQueueBindings(ctx, project, alpha)

  const buildsBefore = runtime._builds.length

  // beta does not exist as a resource at all yet: this is the path `hobby
  // deploy` takes for a worker's very first deploy (createResourceRoute's
  // worker branch calls createWorkerResource directly, never
  // deployResourceRoute), which is a genuinely separate call site from the
  // redeploy test above and had the identical bug before this fix round.
  const dir = mkdtempSync(join(tmpdir(), 'hobby-queue-conflict-create-'))
  writeFileSync(join(dir, 'wrangler.toml'), conflictingWranglerToml('jobs'))

  await withServer(ctx, async (baseUrl) => {
    const res = await call(baseUrl, 'POST', '/v1/projects/blog/resources', {
      kind: 'worker',
      name: 'beta',
      source: { path: dir },
    })
    assert.equal(res.status, 400)
    const body = res.body as { error: { code: string; message: string } }
    assert.equal(body.error.code, 'usage')
    assert.match(body.error.message, /alpha/)
    assert.match(body.error.message, /beta/)

    assert.equal(runtime._builds.length, buildsBefore, 'the runtime was never asked to build an image')
    assert.equal(ctx.store.getResourceByName(project.id, 'beta'), null, 'no row was created for the refused worker')
  })
})
