// GET/POST /v1/resources/:id/settings, `settings` on a postgres create, the
// preload check on POST /extensions, and the eject compose `command:`,
// against the fake runtime. How a change lands (pg-settings.ts): a sleeping
// database gets a new stopped container and is not woken; an awake one is
// restarted under the pinned guard, the activity guard and a wake hold; a
// start that fails with the new settings is rolled back.

import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { rmSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import {
  createFakeRuntime,
  createKindRegistry,
  HobbyError,
  openStore,
  resolvePaths,
  type ActivityGuardResult,
  type HobbyConfig,
  type PostgresConfig,
  type PostgresResource,
  type Project,
} from '@hobby.sh/core'
import { appKindHandler } from '@hobby.sh/app'
import { postgresKindHandler, type ExtensionOps } from '@hobby.sh/pg'
import { ActivityTracker } from '@hobby.sh/proxy'
import { queueKindHandler } from '@hobby.sh/queue'
import { workerKindHandler } from '@hobby.sh/worker'
import { createApp, type DaemonContext } from '../src/index.js'
import { applyPostgresSettings } from '../src/daemon/pg-settings.js'

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

const noExtensions: ExtensionOps = {
  async apply() {
    return [{ name: 'pg_stat_statements', version: '1.12' }]
  },
  async list() {
    return [{ name: 'pg_stat_statements', version: '1.12' }]
  },
}

// A Postgres that refuses to come up with shared_buffers=8GB, the way a box
// without that much memory does, and accepts everything else.
function buildContext(guard: () => Promise<ActivityGuardResult> = async () => 'idle'): DaemonContext & { runtime: ReturnType<typeof createFakeRuntime>; ops: string[] } {
  const home = join(tmpdir(), `hobby-pg-settings-${randomUUID()}`)
  homes.push(home)
  const runtime = createFakeRuntime()
  const ops: string[] = []
  const start = runtime.start.bind(runtime)
  const stop = runtime.stop.bind(runtime)
  const remove = runtime.remove.bind(runtime)
  runtime.start = async (name) => {
    ops.push(`start ${name}`)
    await start(name)
  }
  runtime.stop = async (name, opts) => {
    ops.push(`stop ${name}`)
    await stop(name, opts)
  }
  runtime.remove = async (name) => {
    ops.push(`remove ${name}`)
    await remove(name)
  }
  return {
    store: openStore(':memory:'),
    runtime,
    ops,
    paths: resolvePaths({ HOBBY_HOME: home }),
    config: testConfig(),
    activity: new ActivityTracker(),
    kinds: createKindRegistry([{ ...postgresKindHandler, guard }, appKindHandler, workerKindHandler, queueKindHandler]),
    probeFactory: (config: PostgresConfig) => async () => config.settings?.['shared_buffers'] !== '8GB',
    extensions: noExtensions,
  }
}

function seed(ctx: DaemonContext, opts: { pinned?: boolean; state: PostgresResource['state']; config?: Partial<PostgresConfig> }): { project: Project; resource: PostgresResource } {
  const project = ctx.store.createProject({ name: 'blog', sleepAfterSeconds: opts.pinned === true ? null : 300 })
  const config: PostgresConfig = {
    image: 'postgres:18-alpine',
    containerName: 'hobby-blog-primary',
    hostPort: 15432,
    dataDir: ctx.paths.resourcePath('blog', 'primary', 'pgdata'),
    superuser: 'postgres',
    password: 'test-password',
    database: 'blog',
    ...opts.config,
  }
  const resource = ctx.store.createResource({ projectId: project.id, kind: 'postgres', name: 'primary', config })
  ctx.store.setResourceState(resource.id, opts.state)
  return { project, resource: ctx.store.getResource(resource.id) as PostgresResource }
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

async function call(baseUrl: string, method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  return { status: res.status, body: text.length > 0 ? JSON.parse(text) : undefined }
}

test('POST resources with settings stores them and boots the container with them', async () => {
  const ctx = buildContext()
  await withServer(ctx, async (baseUrl) => {
    await call(baseUrl, 'POST', '/v1/projects', { name: 'blog' })
    const res = await call(baseUrl, 'POST', '/v1/projects/blog/resources', {
      kind: 'postgres',
      name: 'primary',
      extensions: ['pg_stat_statements'],
      settings: { shared_preload_libraries: 'pg_stat_statements', work_mem: '8MB' },
    })
    assert.equal(res.status, 201, JSON.stringify(res.body))
    assert.deepEqual(res.body.resource.config.settings, { shared_preload_libraries: 'pg_stat_statements', work_mem: '8MB' })
    assert.deepEqual(ctx.runtime._specs.get('hobby-blog-primary')?.command, [
      'postgres', '-c', 'shared_preload_libraries=pg_stat_statements', '-c', 'work_mem=8MB',
    ])
  })
})

test('POST resources with a setting outside the allowlist creates nothing', async () => {
  const ctx = buildContext()
  await withServer(ctx, async (baseUrl) => {
    await call(baseUrl, 'POST', '/v1/projects', { name: 'blog' })
    const res = await call(baseUrl, 'POST', '/v1/projects/blog/resources', { kind: 'postgres', name: 'primary', settings: { port: '6543' } })
    assert.equal(res.status, 400)
    assert.match(res.body.error.message, /port is not a setting hobby allows/)
    assert.equal(ctx.runtime._specs.size, 0)
  })
})

test('GET settings never wakes, and reports the allowlist and missing preloads', async () => {
  const ctx = buildContext()
  const { resource } = seed(ctx, { state: 'sleeping', config: { extensions: ['pg_stat_statements'], settings: { jit: 'off' } } })
  await withServer(ctx, async (baseUrl) => {
    const res = await call(baseUrl, 'GET', `/v1/resources/${resource.id}/settings`)
    assert.equal(res.status, 200)
    assert.deepEqual(res.body.settings, { jit: 'off' })
    assert.deepEqual(res.body.needsPreload, [{ extension: 'pg_stat_statements', library: 'pg_stat_statements', allowed: true }])
    assert.ok(res.body.available.some((s: { name: string; restartRequired: boolean }) => s.name === 'shared_buffers' && s.restartRequired))
    assert.deepEqual(ctx.ops, [])
    assert.equal(ctx.store.getResource(resource.id)?.state, 'sleeping')
  })
})

test('POST settings on a sleeping database replaces its stopped container and wakes nothing', async () => {
  const ctx = buildContext()
  const { resource } = seed(ctx, { state: 'sleeping' })
  await withServer(ctx, async (baseUrl) => {
    const res = await call(baseUrl, 'POST', `/v1/resources/${resource.id}/settings`, { set: { shared_buffers: '256MB' } })
    assert.equal(res.status, 200, JSON.stringify(res.body))
    assert.equal(res.body.applied, 'next-start')
    assert.equal(res.body.pausedMs, null)
    assert.deepEqual(res.body.settings, { shared_buffers: '256MB' })
    assert.equal(res.body.resource.config.password, undefined)
    assert.deepEqual(ctx.ops, ['remove hobby-blog-primary'])
    assert.equal(ctx.store.getResource(resource.id)?.state, 'sleeping')
    assert.deepEqual(ctx.runtime._specs.get('hobby-blog-primary')?.command, ['postgres', '-c', 'shared_buffers=256MB'])

    // The same again changes nothing and touches no container.
    const again = await call(baseUrl, 'POST', `/v1/resources/${resource.id}/settings`, { set: { shared_buffers: '256MB' } })
    assert.equal(again.body.applied, 'unchanged')
    assert.deepEqual(ctx.ops, ['remove hobby-blog-primary'])

    // Unsetting the last one goes back to the image's own command.
    const unset = await call(baseUrl, 'POST', `/v1/resources/${resource.id}/settings`, { unset: ['shared_buffers'] })
    assert.equal(unset.body.applied, 'next-start')
    assert.equal(ctx.runtime._specs.get('hobby-blog-primary')?.command, undefined)
    assert.equal('settings' in (ctx.store.getResource(resource.id) as PostgresResource).config, false)
  })
})

test('POST settings on an awake database restarts it with them', async () => {
  const ctx = buildContext()
  const { resource } = seed(ctx, { state: 'running' })
  await ctx.runtime.ensureCreated({ name: 'hobby-blog-primary', image: 'postgres:18-alpine', env: {}, ports: [], binds: [] })
  await withServer(ctx, async (baseUrl) => {
    const res = await call(baseUrl, 'POST', `/v1/resources/${resource.id}/settings`, { set: { max_connections: 50 } })
    assert.equal(res.status, 200, JSON.stringify(res.body))
    assert.equal(res.body.applied, 'restarted')
    assert.equal(typeof res.body.pausedMs, 'number')
    assert.deepEqual(ctx.ops, ['stop hobby-blog-primary', 'remove hobby-blog-primary', 'start hobby-blog-primary'])
    assert.equal(ctx.store.getResource(resource.id)?.state, 'running')
    assert.deepEqual(ctx.runtime._specs.get('hobby-blog-primary')?.command, ['postgres', '-c', 'max_connections=50'])
  })
})

test('an awake database in a pinned project needs allowPause; an asleep one does not', async () => {
  const ctx = buildContext()
  const { resource } = seed(ctx, { state: 'running', pinned: true })
  await withServer(ctx, async (baseUrl) => {
    const refused = await call(baseUrl, 'POST', `/v1/resources/${resource.id}/settings`, { set: { jit: 'off' } })
    assert.equal(refused.status, 409)
    assert.match(refused.body.error.message, /pinned awake, and applying these settings would stop primary/)
    assert.deepEqual(ctx.ops, [])
    assert.equal((ctx.store.getResource(resource.id) as PostgresResource).config.settings, undefined)

    const allowed = await call(baseUrl, 'POST', `/v1/resources/${resource.id}/settings`, { set: { jit: 'off' }, allowPause: true })
    assert.equal(allowed.body.applied, 'restarted')

    ctx.store.setResourceState(resource.id, 'sleeping')
    const asleep = await call(baseUrl, 'POST', `/v1/resources/${resource.id}/settings`, { set: { jit: 'on' } })
    assert.equal(asleep.body.applied, 'next-start')
  })
})

test('a start that fails with the new settings is rolled back to the previous ones, running', async () => {
  const ctx = buildContext()
  const { resource } = seed(ctx, { state: 'running', config: { settings: { shared_buffers: '256MB' } } })
  await withServer(ctx, async (baseUrl) => {
    const res = await call(baseUrl, 'POST', `/v1/resources/${resource.id}/settings`, { set: { shared_buffers: '8GB' } })
    assert.equal(res.status, 400, JSON.stringify(res.body))
    assert.match(res.body.error.message, /previous ones were restored and it is running again/)
    const after = ctx.store.getResource(resource.id) as PostgresResource
    assert.deepEqual(after.config.settings, { shared_buffers: '256MB' })
    assert.equal(after.state, 'running')
    assert.deepEqual(ctx.runtime._specs.get('hobby-blog-primary')?.command, ['postgres', '-c', 'shared_buffers=256MB'])
  })
})

test('a database whose activity guard cannot answer is refused before anything stops', async () => {
  const ctx = buildContext(async () => 'unreachable')
  const { resource } = seed(ctx, { state: 'running' })
  await withServer(ctx, async (baseUrl) => {
    const res = await call(baseUrl, 'POST', `/v1/resources/${resource.id}/settings`, { set: { jit: 'off' } })
    assert.equal(res.status, 409)
    assert.deepEqual(ctx.ops, [])
    assert.equal((ctx.store.getResource(resource.id) as PostgresResource).config.settings, undefined)
  })
})

test('applyPostgresSettings waits out an active database and refuses if it stays active', async () => {
  const ctx = buildContext()
  const { project, resource } = seed(ctx, { state: 'running' })
  let asks = 0
  await assert.rejects(
    applyPostgresSettings(ctx, project, resource, {
      set: { jit: 'off' },
      quiesce: { attempts: 3, waitMs: 1, sleepFor: async () => {}, guard: async () => (asks++, 'active') },
    }),
    (err: unknown) => err instanceof HobbyError && err.code === 'conflict' && /still active/.test(err.message)
  )
  assert.equal(asks, 3)
  assert.deepEqual(ctx.ops, [])
  // The hold was released: a second change on the same project is not refused as "in progress".
  const ok = await applyPostgresSettings(ctx, project, resource, { set: { jit: 'off' }, quiesce: { guard: async () => 'idle' } })
  assert.equal(ok.applied, 'restarted')
  ctx.store.close()
})

test('POST settings refuses a released project and a malformed body', async () => {
  const ctx = buildContext()
  const { project, resource } = seed(ctx, { state: 'sleeping' })
  await withServer(ctx, async (baseUrl) => {
    assert.equal((await call(baseUrl, 'POST', `/v1/resources/${resource.id}/settings`, {})).status, 400)
    assert.equal((await call(baseUrl, 'POST', `/v1/resources/${resource.id}/settings`, { set: 'jit=off' })).status, 400)
    assert.equal((await call(baseUrl, 'POST', `/v1/resources/${resource.id}/settings`, { set: { jit: 'off' }, allowPause: 'yes' })).status, 400)
    ctx.store.setProjectReleased(project.id, new Date())
    const released = await call(baseUrl, 'POST', `/v1/resources/${resource.id}/settings`, { set: { jit: 'off' } })
    assert.equal(released.status, 409)
    assert.match(released.body.error.hint, /command:/)
  })
})

test('POST extensions add of pg_stat_statements is refused until it is preloaded, then goes ahead', async () => {
  const ctx = buildContext()
  const { resource } = seed(ctx, { state: 'sleeping' })
  await withServer(ctx, async (baseUrl) => {
    const refused = await call(baseUrl, 'POST', `/v1/resources/${resource.id}/extensions`, { add: ['pg_stat_statements'] })
    assert.equal(refused.status, 400)
    assert.match(refused.body.error.hint, /hobby pg config set blog\/primary shared_preload_libraries=pg_stat_statements/)
    assert.deepEqual(ctx.ops, [], 'refused before any wake')

    await call(baseUrl, 'POST', `/v1/resources/${resource.id}/settings`, { set: { shared_preload_libraries: 'pg_stat_statements' } })
    const added = await call(baseUrl, 'POST', `/v1/resources/${resource.id}/extensions`, { add: ['pg_stat_statements'] })
    assert.equal(added.status, 200, JSON.stringify(added.body))
    assert.deepEqual(added.body.extensions.needsPreload, [])

    // Unsetting the preload is allowed, and says which extension it breaks.
    ctx.store.setResourceState(resource.id, 'sleeping')
    const unset = await call(baseUrl, 'POST', `/v1/resources/${resource.id}/settings`, { unset: ['shared_preload_libraries'] })
    assert.deepEqual(unset.body.needsPreload, [{ extension: 'pg_stat_statements', library: 'pg_stat_statements', allowed: true }])
  })
})

test('eject renders the same server arguments as the compose command, and none without settings', async () => {
  const ctx = buildContext()
  seed(ctx, { state: 'sleeping', config: { settings: { shared_preload_libraries: 'pg_stat_statements', work_mem: '16MB' } } })
  await withServer(ctx, async (baseUrl) => {
    const res = await call(baseUrl, 'POST', '/v1/projects/blog/eject')
    assert.equal(res.status, 200, JSON.stringify(res.body))
    const compose: string = res.body.compose
    assert.ok(
      compose.includes('    command: ["postgres", "-c", "shared_preload_libraries=pg_stat_statements", "-c", "work_mem=16MB"]'),
      compose
    )
  })
  const bare = buildContext()
  seed(bare, { state: 'sleeping' })
  await withServer(bare, async (baseUrl) => {
    const res = await call(baseUrl, 'POST', '/v1/projects/blog/eject')
    assert.equal(res.body.compose.includes('command:'), false)
  })
})
