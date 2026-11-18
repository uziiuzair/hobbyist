// GET/POST /v1/resources/:id/extensions and `extensions` on a postgres
// create, against the fake runtime with PgDeps.extensions playing a
// Postgres that ships some extensions and not others.

import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createFakeRuntime, HobbyError, openStore, resolvePaths, type HobbyConfig, type PostgresConfig } from '@hobby.sh/core'
import type { ExtensionOps, InstalledExtension } from '@hobby.sh/pg'
import { ActivityTracker } from '@hobby.sh/proxy'
import { createDefaultKindRegistry } from '../src/daemon/context.js'
import { createApp, type DaemonContext } from '../src/index.js'

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

interface FakeExtensions extends ExtensionOps {
  applied: string[][]
  listed: number
  installed: InstalledExtension[]
}

function fakeExtensions(shipped: string[]): FakeExtensions {
  const ops: FakeExtensions = {
    applied: [],
    listed: 0,
    installed: [{ name: 'plpgsql', version: '1.0' }],
    async apply(config: PostgresConfig, names: string[]) {
      ops.applied.push(names)
      const missing = names.filter((name) => !shipped.includes(name))
      if (missing.length > 0) {
        throw new HobbyError('usage', `the image ${config.image} does not ship the extension ${missing.join(', ')}`, 'issues/2')
      }
      for (const name of names) {
        if (!ops.installed.some((ext) => ext.name === name)) ops.installed.push({ name, version: '1.0' })
      }
      return [...ops.installed]
    },
    async list() {
      ops.listed++
      return [...ops.installed]
    },
  }
  return ops
}

function buildContext(shipped: string[]): DaemonContext & { extensions: FakeExtensions } {
  const store = openStore(':memory:')
  const paths = resolvePaths({ HOBBY_HOME: join(tmpdir(), `hobby-ext-test-${randomUUID()}`) })
  return {
    store,
    runtime: createFakeRuntime(),
    paths,
    config: testConfig(),
    activity: new ActivityTracker(),
    kinds: createDefaultKindRegistry(),
    probeFactory: () => async () => true,
    extensions: fakeExtensions(shipped),
  }
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

async function createDb(baseUrl: string, extensions?: unknown): Promise<{ status: number; body: any }> {
  await call(baseUrl, 'POST', '/v1/projects', { name: 'blog' })
  return await call(baseUrl, 'POST', '/v1/projects/blog/resources', {
    kind: 'postgres',
    name: 'primary',
    ...(extensions === undefined ? {} : { extensions }),
  })
}

test('POST resources with extensions declares them, applies them on first boot, and shows them on the wire', async () => {
  const ctx = buildContext(['pg_trgm'])
  await withServer(ctx, async (baseUrl) => {
    const res = await createDb(baseUrl, ['pg_trgm'])
    assert.equal(res.status, 201)
    assert.equal(res.body.resource.state, 'sleeping')
    assert.deepEqual(res.body.resource.config.extensions, ['pg_trgm'])
    assert.equal('password' in res.body.resource.config, false)
    assert.deepEqual(ctx.extensions.applied, [['pg_trgm']])
  })
})

test('POST resources with an extension the image does not ship is refused and leaves no resource behind', async () => {
  const ctx = buildContext(['pg_trgm'])
  await withServer(ctx, async (baseUrl) => {
    const res = await createDb(baseUrl, ['vector'])
    assert.equal(res.status, 400)
    assert.equal(res.body.error.code, 'usage')
    assert.match(res.body.error.message, /postgres:18-alpine/)
    const project = await call(baseUrl, 'GET', '/v1/projects/blog')
    assert.deepEqual(project.body.resources, [])
  })
})

test('POST resources with a malformed extension name is a usage error before anything is created', async () => {
  const ctx = buildContext([])
  await withServer(ctx, async (baseUrl) => {
    const res = await createDb(baseUrl, ['x; drop table t'])
    assert.equal(res.status, 400)
    assert.equal(ctx.extensions.applied.length, 0)
    const project = await call(baseUrl, 'GET', '/v1/projects/blog')
    assert.deepEqual(project.body.resources, [])
  })
})

test('GET extensions wakes a sleeping database, reads installed with versions, and reports missing', async () => {
  const ctx = buildContext(['pg_trgm'])
  await withServer(ctx, async (baseUrl) => {
    const id = (await createDb(baseUrl, ['pg_trgm'])).body.resource.id
    // Someone ran DROP EXTENSION by hand.
    ctx.extensions.installed = ctx.extensions.installed.filter((ext) => ext.name !== 'pg_trgm')
    const res = await call(baseUrl, 'GET', `/v1/resources/${id}/extensions`)
    assert.equal(res.status, 200)
    assert.deepEqual(res.body.extensions, {
      declared: ['pg_trgm'],
      installed: [{ name: 'plpgsql', version: '1.0' }],
      missing: ['pg_trgm'],
      needsPreload: [],
    })
    assert.equal(ctx.store.getResource(id)?.state, 'running')
    assert.notEqual(ctx.activity.idleSeconds(id), null)
  })
})

test('POST extensions add re-applies the whole declared list and persists it only after it succeeded', async () => {
  const ctx = buildContext(['pg_trgm', 'hstore'])
  await withServer(ctx, async (baseUrl) => {
    const id = (await createDb(baseUrl, ['pg_trgm'])).body.resource.id
    const ok = await call(baseUrl, 'POST', `/v1/resources/${id}/extensions`, { add: ['hstore'] })
    assert.equal(ok.status, 200)
    assert.deepEqual(ok.body.extensions.declared, ['pg_trgm', 'hstore'])
    assert.deepEqual(ctx.extensions.applied.at(-1), ['pg_trgm', 'hstore'])
    assert.deepEqual(ok.body.extensions.missing, [])

    const refused = await call(baseUrl, 'POST', `/v1/resources/${id}/extensions`, { add: ['vector'] })
    assert.equal(refused.status, 400)
    assert.match(refused.body.error.message, /vector/)
    const stored = ctx.store.getResource(id)
    assert.deepEqual((stored?.config as PostgresConfig).extensions, ['pg_trgm', 'hstore'])
  })
})

test('POST extensions remove only undeclares, never applies anything, and wakes nothing', async () => {
  const ctx = buildContext(['pg_trgm'])
  await withServer(ctx, async (baseUrl) => {
    const id = (await createDb(baseUrl, ['pg_trgm'])).body.resource.id
    const appliedBefore = ctx.extensions.applied.length
    const res = await call(baseUrl, 'POST', `/v1/resources/${id}/extensions`, { remove: ['pg_trgm'] })
    assert.equal(res.status, 200)
    assert.deepEqual(res.body.extensions, { declared: [], installed: null, missing: null, needsPreload: [] })
    assert.deepEqual(res.body.removed, ['pg_trgm'])
    assert.equal(ctx.extensions.applied.length, appliedBefore)
    assert.equal(ctx.extensions.listed, 0)
    assert.equal(ctx.store.getResource(id)?.state, 'sleeping')
  })
})

test('POST extensions with nothing to change, or the same name added and removed, is a usage error', async () => {
  const ctx = buildContext(['pg_trgm'])
  await withServer(ctx, async (baseUrl) => {
    const id = (await createDb(baseUrl)).body.resource.id
    assert.equal((await call(baseUrl, 'POST', `/v1/resources/${id}/extensions`, {})).status, 400)
    const both = await call(baseUrl, 'POST', `/v1/resources/${id}/extensions`, { add: ['pg_trgm'], remove: ['pg_trgm'] })
    assert.equal(both.status, 400)
  })
})
