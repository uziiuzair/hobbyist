// `hobby eject` once a project holds compute as well as a database. ADR 0007
// is explicit that a kind which cannot be ejected does not ship, so this is
// the test that says an app can leave.
//
// The subtle assertion is the DATABASE_URL rewrite. Inside hobby, an app
// reaches its database at `hobby-blog-primary`. Inside the emitted compose
// stack that host does not exist, and the same string would hand a departing
// user an app that starts and then cannot reach its data, which is worse than
// not emitting it at all because it looks like it worked.

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
  type AppConfig,
  type HobbyConfig,
  type PostgresConfig,
  type Store,
} from '@hobby.sh/core'
import { ActivityTracker } from '@hobby.sh/proxy'
import { createApp, type DaemonContext } from '../src/index.js'
import { createDefaultKindRegistry } from '../src/daemon/context.js'

function testConfig(): HobbyConfig {
  return {
    image: 'postgres:18-alpine',
    proxyPort: 5432,
    studioPort: 8443,
    apiPort: 7432,
    httpPort: 7433,
    domain: 'localhost',
    sleepAfterSeconds: 300,
    wakeTimeoutMs: 150,
    readinessPollMs: 20,
  }
}

function buildContext(): DaemonContext {
  const store: Store = openStore(':memory:')
  return {
    store,
    runtime: createFakeRuntime(),
    paths: resolvePaths({ HOBBY_HOME: join(tmpdir(), `hobby-eject-test-${randomUUID()}`) }),
    config: testConfig(),
    activity: new ActivityTracker(),
    kinds: createDefaultKindRegistry(),
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

function seed(ctx: DaemonContext): { dbName: string; appName: string } {
  const project = ctx.store.createProject({ name: 'blog', sleepAfterSeconds: 300 })

  const pgConfig: PostgresConfig = {
    image: 'postgres:18-alpine',
    containerName: 'hobby-blog-primary',
    hostPort: 15432,
    dataDir: '/home/user/.hobby/projects/blog/primary/pgdata',
    superuser: 'postgres',
    password: 'the-real-password',
    database: 'blog',
  }
  const db = ctx.store.createResource({ projectId: project.id, kind: 'postgres', name: 'primary', config: pgConfig })

  const appCfg: AppConfig = {
    image: 'hobby/blog-web:1754870400',
    containerName: 'hobby-blog-web',
    hostPort: 25433,
    containerPort: 3000,
    hostname: 'web.blog.localhost',
    source: { path: '/home/user/code/blog', dockerfile: 'Dockerfile' },
    env: { NODE_ENV: 'production' },
    databaseResourceId: db.id,
  }
  ctx.store.createResource({ projectId: project.id, kind: 'app', name: 'web', config: appCfg })

  return { dbName: 'primary', appName: 'web' }
}

async function eject(baseUrl: string): Promise<{ compose: string; caddyfile: string; notEjectable: string[] }> {
  const res = await fetch(`${baseUrl}/v1/projects/blog/eject`, { method: 'POST' })
  assert.equal(res.status, 200)
  return (await res.json()) as { compose: string; caddyfile: string; notEjectable: string[] }
}

test('eject renders an app service alongside the database', async () => {
  const ctx = buildContext()
  seed(ctx)
  await withServer(ctx, async (baseUrl) => {
    const { compose } = await eject(baseUrl)
    assert.match(compose, /^ {2}primary:$/m)
    assert.match(compose, /^ {2}web:$/m)
    assert.match(compose, /image: hobby\/blog-web:1754870400/)
    // Both image and build, so the stack starts from the image already on
    // disk and can still be rebuilt from the same Dockerfile.
    assert.match(compose, /build:\n {6}context: \/home\/user\/code\/blog\n {6}dockerfile: Dockerfile/)
    assert.match(compose, /PORT: "3000"/)
    assert.match(compose, /NODE_ENV: "production"/)
  })
})

test('the ejected app reaches its database by compose service name, not by the hobby container name', async () => {
  const ctx = buildContext()
  seed(ctx)
  await withServer(ctx, async (baseUrl) => {
    const { compose } = await eject(baseUrl)
    assert.match(compose, /DATABASE_URL: postgres:\/\/postgres:the-real-password@primary:5432\/blog/)
    assert.equal(
      compose.includes('@hobby-blog-primary:5432'),
      false,
      'the hobby container name does not exist inside the emitted stack'
    )
  })
})

test('an ejected app publishes on loopback, exactly as hobby did', async () => {
  const ctx = buildContext()
  seed(ctx)
  await withServer(ctx, async (baseUrl) => {
    const { compose } = await eject(baseUrl)
    assert.match(compose, /- "127\.0\.0\.1:25433:3000"/)
  })
})

// ADR 0009: a compose file with no routing is a running container, not a
// working site.
test('eject emits a Caddyfile routing each app hostname to its published port', async () => {
  const ctx = buildContext()
  seed(ctx)
  await withServer(ctx, async (baseUrl) => {
    const { caddyfile } = await eject(baseUrl)
    assert.match(caddyfile, /^web\.blog\.localhost \{$/m)
    assert.match(caddyfile, /reverse_proxy 127\.0\.0\.1:25433/)
  })
})

test('a project with nothing to route emits no Caddyfile at all', async () => {
  const ctx = buildContext()
  const project = ctx.store.createProject({ name: 'blog', sleepAfterSeconds: 300 })
  ctx.store.createResource({
    projectId: project.id,
    kind: 'postgres',
    name: 'primary',
    config: {
      image: 'postgres:18-alpine',
      containerName: 'hobby-blog-primary',
      hostPort: 15432,
      dataDir: '/tmp/pgdata',
      superuser: 'postgres',
      password: 'p',
      database: 'blog',
    },
  })

  await withServer(ctx, async (baseUrl) => {
    const { caddyfile, notEjectable } = await eject(baseUrl)
    assert.equal(caddyfile, '')
    assert.deepEqual(notEjectable, [])
  })
})
