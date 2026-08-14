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
  type WorkerConfig,
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

  const workerCfg: WorkerConfig = {
    image: 'hobby/blog-api-worker:1754870400',
    containerName: 'hobby-blog-api',
    hostPort: 35433,
    controlPort: 35434,
    queueToken: 'test-queue-token',
    containerPort: 8787,
    hostname: 'api.blog.localhost',
    durableObjectUniqueKeyModifier: 'stable-id',
    databaseResourceId: db.id,
    manifest: {
      source: { path: '/home/user/code/blog-api', manifest: 'wrangler.toml' },
      compatibilityDate: '2026-08-01',
      compatibilityFlags: [],
      vars: { GREETING: 'hello' },
      kvNamespaces: [],
      r2Buckets: [],
      d1Databases: [],
      queues: { producers: [], consumers: [] },
      durableObjects: [{ binding: 'COUNTER', className: 'Counter' }],
    },
  }
  ctx.store.createResource({ projectId: project.id, kind: 'worker', name: 'api', config: workerCfg })

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

// ADR 0007: a kind that cannot be ejected does not ship. A worker's storage is
// two bind mounts, and a stack that comes up with an empty durable object
// directory has lost its data as surely as a postgres pointed at an empty
// PGDATA.
test('eject renders a worker with both of its storage mounts', async () => {
  const ctx = buildContext()
  seed(ctx)
  await withServer(ctx, async (baseUrl) => {
    const { compose, caddyfile, notEjectable } = await eject(baseUrl)
    assert.match(compose, /^ {2}api:$/m)
    assert.match(compose, /image: hobby\/blog-api-worker:1754870400/)
    assert.match(compose, /- "\/.*\/projects\/blog\/api\/state:\/hobby\/state"/)
    assert.match(compose, /- "\/.*\/projects\/blog\/api\/do:\/hobby\/do"/)
    assert.match(compose, /- "127\.0\.0\.1:35433:8787"/)
    // Every registered kind can leave.
    assert.deepEqual(notEjectable, [])
    // And every hostname is routed, not just the app's.
    assert.match(caddyfile, /^api\.blog\.localhost \{$/m)
    assert.match(caddyfile, /reverse_proxy 127\.0\.0\.1:35433/)
  })
})

test('an ejected worker reaches its database by compose service name too', async () => {
  const ctx = buildContext()
  seed(ctx)
  await withServer(ctx, async (baseUrl) => {
    const { compose } = await eject(baseUrl)
    // The manifest is JSON inside a YAML scalar, so assert on the substring
    // rather than trying to parse it back out.
    assert.match(compose, /postgres:\/\/postgres:the-real-password@primary:5432\/blog/)
    assert.equal(compose.includes('@hobby-blog-primary:5432'), false)
  })
})

// The worker's Dockerfile is generated by hobby and lives under hobby's own
// home directory. Pointing an ejected stack at it would make the file depend
// on hobby still being installed, which is the opposite of ejecting.
test('an ejected worker carries an image, never a build context', async () => {
  const ctx = buildContext()
  seed(ctx)
  await withServer(ctx, async (baseUrl) => {
    const { compose } = await eject(baseUrl)
    const workerBlock = compose.slice(compose.indexOf('  api:'))
    assert.equal(workerBlock.includes('build:'), false)
  })
})

// An app with `config.image: null`, exactly the shape createAppResource's
// no-source path leaves behind (packages/app/src/app.ts:204) for an app
// created from Studio or MCP with no code yet. Its skip is a distinct code
// path from a worker's (the app loop never calls buildRunnerManifest), so it
// earns its own test rather than trusting the worker case to generalise. A
// postgres sits alongside it so this project has something ejectable: an
// undeployed app on its own, with nothing else in the project, is exactly
// the refusal case covered separately below, and this test is about the skip
// report, not the refusal.
test('an undeployed app is skipped, with a reason naming it, and routed nowhere', async () => {
  const ctx = buildContext()
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
  ctx.store.createResource({ projectId: project.id, kind: 'postgres', name: 'primary', config: pgConfig })
  const appCfg: AppConfig = {
    image: null,
    containerName: 'hobby-blog-site',
    hostPort: 25555,
    containerPort: 3000,
    hostname: 'site.blog.localhost',
    source: null,
    env: {},
    databaseResourceId: null,
  }
  const app = ctx.store.createResource({ projectId: project.id, kind: 'app', name: 'site', config: appCfg })
  ctx.store.setResourceState(app.id, 'undeployed')

  await withServer(ctx, async (baseUrl) => {
    const { compose, caddyfile, notEjectable } = await eject(baseUrl)
    assert.equal(compose.includes('site:'), false)
    assert.match(notEjectable.join('\n'), /site: never deployed, so there is no image to run/)
    // ADR 0009: an ejected app that no longer serves is not an ejected app.
    // A hostname with no compose service behind it is exactly that, so Caddy
    // must not route to it even though the hostname itself was allocated at
    // creation and is not null.
    assert.equal(caddyfile.includes('site.blog.localhost'), false)
  })
})

// A worker with `config.image: null` and `config.manifest: null`, exactly the
// shape createWorkerResource's no-source path leaves behind
// (packages/worker/src/worker.ts:311-323) and never advances past, because no
// deploy has ever run for it. Built directly through the store rather than
// through createWorkerResource, because the eject route only ever reads rows,
// never the creation path, and a hand-built row is what proves the fix reads
// state honestly rather than one lucky construction path.
function seedUndeployedWorker(ctx: DaemonContext, projectName: string): { dbName: string; workerName: string } {
  const project = ctx.store.createProject({ name: projectName, sleepAfterSeconds: 300 })

  const pgConfig: PostgresConfig = {
    image: 'postgres:18-alpine',
    containerName: `hobby-${projectName}-primary`,
    hostPort: 15432,
    dataDir: `/home/user/.hobby/projects/${projectName}/primary/pgdata`,
    superuser: 'postgres',
    password: 'the-real-password',
    database: projectName,
  }
  ctx.store.createResource({ projectId: project.id, kind: 'postgres', name: 'primary', config: pgConfig })

  const workerCfg: WorkerConfig = {
    image: null,
    containerName: `hobby-${projectName}-sidecar`,
    hostPort: 35555,
    containerPort: 8787,
    hostname: `sidecar.${projectName}.localhost`,
    durableObjectUniqueKeyModifier: 'stable-id',
    databaseResourceId: null,
    manifest: null,
  }
  const worker = ctx.store.createResource({ projectId: project.id, kind: 'worker', name: 'sidecar', config: workerCfg })
  ctx.store.setResourceState(worker.id, 'undeployed')

  return { dbName: 'primary', workerName: 'sidecar' }
}

// The regression test for the actual defect: before this task, calling
// buildRunnerManifest unguarded on this worker's null manifest
// (packages/worker/src/worker.ts:124) threw out of renderCompose, and
// ejectRoute had no try/catch around it, so a single undeployed worker
// aborted the eject for the whole project, taking a perfectly healthy
// postgres down with it. That is the one promise `hobby eject` exists to
// keep (CLAUDE.md's "you can always leave", priority one of three), so this
// proves the mixed case explicitly rather than trusting the isolated case
// above to generalise.
test('a project with a deployed postgres and an undeployed worker ejects successfully, postgres intact', async () => {
  const ctx = buildContext()
  const { dbName, workerName } = seedUndeployedWorker(ctx, 'blog')
  await withServer(ctx, async (baseUrl) => {
    // eject()'s own assert.equal(res.status, 200) carries the critical
    // assertion: this call did not throw or 500. A prior version of this bug
    // turned one undeployed worker into a failed eject for the whole
    // project. seedUndeployedWorker always names its project 'blog', which
    // is exactly what eject() is hardcoded to, so the helper fits and no
    // cast is needed to read the response.
    const { compose, notEjectable } = await eject(baseUrl)

    // The postgres service is present and fully, correctly rendered, exactly
    // as it would be with no worker in the project at all. Includes the data
    // directory mount, the single most important line in the block: it is
    // where the user's actual data lives, and the whole point of this test
    // is proving the healthy half survives an undeployed sibling untouched.
    assert.match(compose, new RegExp(`^ {2}${dbName}:$`, 'm'))
    assert.match(compose, /image: postgres:18-alpine/)
    assert.match(compose, /POSTGRES_USER: postgres/)
    assert.match(compose, /POSTGRES_PASSWORD: the-real-password/)
    assert.match(compose, /POSTGRES_DB: blog/)
    assert.match(compose, /- "127\.0\.0\.1:15432:5432"/)
    assert.match(compose, /- "\/home\/user\/\.hobby\/projects\/blog\/primary\/pgdata:\/var\/lib\/postgresql"/)

    // The undeployed worker is absent, not merely broken.
    assert.equal(compose.includes(`  ${workerName}:`), false)

    // And named, with the reason, in the skip report.
    assert.match(notEjectable.join('\n'), new RegExp(`${workerName}: never deployed, so there is no image to run`))
  })
})

// The regression test for defect 1: `image: ${cfg.image}` is a template
// literal, and a template literal stringifies `null` with no compile error,
// which is why nothing caught it before this task. Asserted against the
// rendered text itself, not the data structure that produced it, because
// that stringification is exactly the failure mode: a data-level check would
// not have caught it either.
test('the emitted compose file never contains the literal string null in an image position', async () => {
  const ctx = buildContext()
  seedUndeployedWorker(ctx, 'blog')
  await withServer(ctx, async (baseUrl) => {
    const { compose } = await eject(baseUrl)
    assert.doesNotMatch(compose, /image:\s*null/)
  })
})

// What happens when every resource in a project is undeployed: eject REFUSES
// rather than returning a compose file docker cannot even parse. Verified
// against real docker compose, not assumed: `printf 'services:\n' >
// empty-compose.yml && docker compose -f empty-compose.yml config` fails with
// "services must be a mapping". Handing that file back with a 200 would tell
// the departing user their eject worked when the result cannot start, which
// fails CLAUDE.md's "you can always leave" worse than refusing plainly. Uses
// a raw fetch rather than the eject() helper: eject() is hardcoded to project
// 'blog' and asserts status 200, and this test needs a different project
// name and a non-2xx status, so the helper does not fit here (the routes.ts
// idiom this mirrors for asserting a HobbyError body, e.g.
// packages/cli/test/routes.test.ts:181, already casts the same way).
test('a project holding only undeployed resources refuses to eject, naming what was skipped', async () => {
  const ctx = buildContext()
  const project = ctx.store.createProject({ name: 'empty-shell', sleepAfterSeconds: 300 })
  const workerCfg: WorkerConfig = {
    image: null,
    containerName: 'hobby-empty-shell-sidecar',
    hostPort: 35556,
    containerPort: 8787,
    hostname: 'sidecar.empty-shell.localhost',
    durableObjectUniqueKeyModifier: 'stable-id',
    databaseResourceId: null,
    manifest: null,
  }
  const worker = ctx.store.createResource({ projectId: project.id, kind: 'worker', name: 'sidecar', config: workerCfg })
  ctx.store.setResourceState(worker.id, 'undeployed')

  await withServer(ctx, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/v1/projects/empty-shell/eject`, { method: 'POST' })
    assert.equal(res.status, 400)
    const body = (await res.json()) as { error: { code: string; message: string } }
    assert.equal(body.error.code, 'usage')
    assert.match(body.error.message, /sidecar: never deployed, so there is no image to run/)
  })
})

// The other shape the same refusal must cover: a project with no resources
// at all, not merely all-skipped ones. Distinct code path through the same
// guard (postgresResources.length + deployedApps.length +
// deployedWorkers.length === 0 with an empty skippedReasons list), and it
// earns its own test because the message is meant to read differently: "come
// back once something has deployed" is the wrong thing to tell someone who
// has never created a resource at all.
test('a project with no resources at all refuses to eject, saying there is nothing there', async () => {
  const ctx = buildContext()
  ctx.store.createProject({ name: 'freshly-made', sleepAfterSeconds: 300 })

  await withServer(ctx, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/v1/projects/freshly-made/eject`, { method: 'POST' })
    assert.equal(res.status, 400)
    const body = (await res.json()) as { error: { code: string; message: string } }
    assert.equal(body.error.code, 'usage')
    assert.match(body.error.message, /freshly-made has no resources yet, so there is nothing to eject/)
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
