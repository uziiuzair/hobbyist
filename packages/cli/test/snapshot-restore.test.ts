// The rewrites restore has to make, one test each. Every one of these is a
// silent failure in production: the restore succeeds and the copy quietly
// shares something with the original.

import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { existsSync, rmSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import {
  createFakeRuntime,
  HobbyError,
  openStore,
  resolvePaths,
  type AppConfig,
  type HobbyConfig,
  type PostgresConfig,
  type ResourceId,
  type Store,
  type WorkerConfig,
} from '@hobby.sh/core'
import { ActivityTracker } from '@hobby.sh/proxy'
import { createDefaultKindRegistry, type DaemonContext } from '../src/daemon/context.js'
import { restoreSnapshot, takeSnapshot } from '../src/daemon/snapshots.js'

const homes: string[] = []
after(() => {
  for (const home of homes) {
    rmSync(home, { recursive: true, force: true })
  }
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
    // 0 means "do not bind". The snapshots tests never enqueue, and this
    // branch predates queuePort becoming required, so the field arrives here
    // by way of the merge rather than because these tests want a broker.
    queuePort: 0,
    caddyEnabled: false,
    caddyAdminPort: 2019,
    caddyStudioHost: null,
    project: null,
  }
}

function buildContext(): DaemonContext {
  const home = join(tmpdir(), `hobby-restore-${randomUUID()}`)
  homes.push(home)
  const store: Store = openStore(':memory:')
  return {
    store,
    runtime: createFakeRuntime(),
    paths: resolvePaths({ HOBBY_HOME: home }),
    config: testConfig(),
    activity: new ActivityTracker(),
    kinds: createDefaultKindRegistry(),
  }
}

function postgresConfig(paths: DaemonContext['paths'], project: string, name: string): PostgresConfig {
  return {
    image: 'postgres:18-alpine',
    containerName: `hobby-${project}-${name}`,
    hostPort: 15432,
    dataDir: paths.resourcePath(project, name, 'pgdata'),
    superuser: 'postgres',
    password: 'secret',
    database: 'app',
  }
}

function appConfig(project: string, name: string, databaseResourceId: ResourceId): AppConfig {
  return {
    image: `hobby-${project}-${name}:latest`,
    containerName: `hobby-${project}-${name}`,
    hostPort: 25500,
    containerPort: 8080,
    hostname: `${name}.${project}.localhost`,
    source: null,
    env: {},
    databaseResourceId,
  }
}

function workerConfig(project: string, name: string, resourceId: string): WorkerConfig {
  return {
    image: `hobby-${project}-${name}:latest`,
    containerName: `hobby-${project}-${name}`,
    hostPort: 18080,
    containerPort: 8080,
    controlPort: 18081,
    queueToken: 'token-from-the-original',
    hostname: `${name}.${project}.localhost`,
    databaseResourceId: null,
    durableObjectUniqueKeyModifier: resourceId,
    manifest: {
      source: { path: '/tmp/does-not-matter', manifest: 'wrangler.toml' },
      compatibilityDate: '2026-08-01',
      compatibilityFlags: [],
      vars: {},
      kvNamespaces: [],
      r2Buckets: [],
      d1Databases: [],
      durableObjects: [{ binding: 'COUNTER', className: 'Counter' }],
      queues: { producers: [], consumers: [] },
    },
  }
}

test('restore rewrites ports, container name and data directory', async () => {
  const ctx = buildContext()
  const project = ctx.store.createProject({ name: 'blog', sleepAfterSeconds: null })
  const original = ctx.store.createResource({
    projectId: project.id,
    kind: 'postgres',
    name: 'primary',
    config: postgresConfig(ctx.paths, 'blog', 'primary'),
  })
  await mkdir(ctx.paths.resourcePath('blog', 'primary', 'pgdata'), { recursive: true })
  await writeFile(join(ctx.paths.resourcePath('blog', 'primary', 'pgdata'), 'PG_VERSION'), '18\n', 'utf8')

  const taken = await takeSnapshot(ctx, 'blog', { now: () => Date.UTC(2026, 7, 16, 9, 0, 0), suffix: () => 'aaaaaa' })
  const restored = await restoreSnapshot(ctx, taken.snapshotId, { as: 'blog-copy' })

  const config = restored.resources[0]?.config
  assert.ok(config !== undefined && 'dataDir' in config)
  assert.equal(config.dataDir, ctx.paths.resourcePath('blog-copy', 'primary', 'pgdata'))
  assert.notEqual(config.containerName, 'hobby-blog-primary')
  assert.notEqual(config.hostPort, 15432)
  // The password is the one thing that must NOT change: the cloned data
  // directory expects it.
  assert.equal(config.password, 'secret')
  // And the original is untouched.
  const untouched = ctx.store.getResource(original.id)?.config
  assert.ok(untouched !== undefined && 'dataDir' in untouched)
  assert.equal(untouched.dataDir, ctx.paths.resourcePath('blog', 'primary', 'pgdata'))
})

// Found on real Docker, invisible here until this test: the first version
// recorded a restored postgres's row and never created its container, so
// every wake died with "No such container", while the fake runtime (whose
// start() will start a container it has never heard of) reported success.
// So this asks the fake what it was asked to create, not whether a row
// exists, and checks the container is the one the row describes.
test('restore into a new project creates each postgres container, stopped, on the cloned data and a postgres port', async () => {
  const ctx = buildContext()
  const runtime = createFakeRuntime()
  ctx.runtime = runtime
  const project = ctx.store.createProject({ name: 'blog', sleepAfterSeconds: null })
  ctx.store.createResource({
    projectId: project.id,
    kind: 'postgres',
    name: 'primary',
    config: postgresConfig(ctx.paths, 'blog', 'primary'),
  })
  await mkdir(ctx.paths.resourcePath('blog', 'primary', 'pgdata'), { recursive: true })

  const taken = await takeSnapshot(ctx, 'blog', { now: () => Date.UTC(2026, 7, 16, 9, 0, 0), suffix: () => 'aaaaaa' })
  const restored = await restoreSnapshot(ctx, taken.snapshotId, { as: 'blog-copy' })

  const resource = restored.resources[0]
  assert.ok(resource !== undefined && resource.kind === 'postgres')
  assert.equal(resource.state, 'sleeping')

  const spec = runtime._specs.get('hobby-blog-copy-primary')
  assert.ok(spec !== undefined, 'the restored postgres has no container')
  assert.equal(resource.config.containerName, 'hobby-blog-copy-primary')
  assert.deepEqual(spec.binds.map((bind) => bind.host), [ctx.paths.resourcePath('blog-copy', 'primary', 'pgdata')])
  assert.deepEqual(spec.ports.map((port) => port.host), [resource.config.hostPort])
  assert.equal(spec.network, restored.project.networkName)
  assert.ok(runtime._networks.has(restored.project.networkName))
  // Created, and left stopped: sleeping is how every new postgres rests.
  assert.equal(runtime._state.get('hobby-blog-copy-primary')?.running, false)
  // pg's own range (PORT_RANGE_FROM/TO, packages/pg/src/postgres.ts), not
  // the 15000 an earlier version handed out from a range of its own.
  assert.ok(resource.config.hostPort >= 15432 && resource.config.hostPort <= 25432, `port ${resource.config.hostPort}`)
  // The password lives inside the cloned cluster and must not change.
  assert.equal(spec.env['POSTGRES_PASSWORD'], 'secret')
})

test('restore carries the bytes', async () => {
  const ctx = buildContext()
  const project = ctx.store.createProject({ name: 'blog', sleepAfterSeconds: null })
  ctx.store.createResource({
    projectId: project.id,
    kind: 'postgres',
    name: 'primary',
    config: postgresConfig(ctx.paths, 'blog', 'primary'),
  })
  await mkdir(ctx.paths.resourcePath('blog', 'primary', 'pgdata'), { recursive: true })
  await writeFile(join(ctx.paths.resourcePath('blog', 'primary', 'pgdata'), 'PG_VERSION'), '18\n', 'utf8')

  const taken = await takeSnapshot(ctx, 'blog', { now: () => Date.UTC(2026, 7, 16, 9, 0, 0), suffix: () => 'aaaaaa' })
  await restoreSnapshot(ctx, taken.snapshotId, { as: 'blog-copy' })

  assert.equal(
    await readFile(join(ctx.paths.resourcePath('blog-copy', 'primary', 'pgdata'), 'PG_VERSION'), 'utf8'),
    '18\n'
  )
})

// Inverted from its first version, which asserted a rename to the new id.
// That rename kept the directory and orphaned every object file inside it
// (issue #175): workerd derives the per-object file name from the unique key
// too, so the only restore that keeps objects is one that keeps the key.
test('restore keeps Durable Object storage under the original unique key', async () => {
  const ctx = buildContext()
  const project = ctx.store.createProject({ name: 'blog', sleepAfterSeconds: null })
  const placeholder = ctx.store.createResource({
    projectId: project.id,
    kind: 'worker',
    name: 'api',
    config: workerConfig('blog', 'api', 'placeholder'),
  })
  ctx.store.updateResourceConfig(placeholder.id, workerConfig('blog', 'api', placeholder.id))

  const oldKey = `${placeholder.id}-Counter`
  await mkdir(join(ctx.paths.resourcePath('blog', 'api', 'do'), oldKey), { recursive: true })
  await writeFile(join(ctx.paths.resourcePath('blog', 'api', 'do'), oldKey, 'obj.sqlite'), 'state', 'utf8')
  // Miniflare's own bookkeeping sits beside the objects and is not one.
  await writeFile(join(ctx.paths.resourcePath('blog', 'api', 'do'), oldKey, 'metadata.sqlite'), 'meta', 'utf8')

  const taken = await takeSnapshot(ctx, 'blog', { now: () => Date.UTC(2026, 7, 16, 9, 0, 0), suffix: () => 'aaaaaa' })
  const restored = await restoreSnapshot(ctx, taken.snapshotId, { as: 'blog-copy' })

  const newId = restored.resources[0]?.id
  assert.ok(newId !== undefined)
  assert.notEqual(newId, placeholder.id)
  const restoredDo = ctx.paths.resourcePath('blog-copy', 'api', 'do')
  assert.equal(await readFile(join(restoredDo, oldKey, 'obj.sqlite'), 'utf8'), 'state')
  assert.equal(await readFile(join(restoredDo, oldKey, 'metadata.sqlite'), 'utf8'), 'meta')
  assert.equal(existsSync(join(restoredDo, `${newId}-Counter`)), false, 'nothing is renamed to the new id')
})

test('restore regenerates the queue token and re-derives the hostname', async () => {
  const ctx = buildContext()
  const project = ctx.store.createProject({ name: 'blog', sleepAfterSeconds: null })
  const worker = ctx.store.createResource({
    projectId: project.id,
    kind: 'worker',
    name: 'api',
    config: workerConfig('blog', 'api', 'placeholder'),
  })
  ctx.store.updateResourceConfig(worker.id, workerConfig('blog', 'api', worker.id))
  // One addressed object, stored where workerd puts it: under the unique key
  // directory, in a file named after the object id that the key feeds into.
  const namespaceDir = join(ctx.paths.resourcePath('blog', 'api', 'do'), `${worker.id}-Counter`)
  await mkdir(namespaceDir, { recursive: true })
  await writeFile(join(namespaceDir, 'b90dbd3f00000000000000000000000000000000000000000000000000000000.sqlite'), 'state', 'utf8')

  const taken = await takeSnapshot(ctx, 'blog', { now: () => Date.UTC(2026, 7, 16, 9, 0, 0), suffix: () => 'aaaaaa' })
  const restored = await restoreSnapshot(ctx, taken.snapshotId, { as: 'blog-copy' })

  const config = restored.resources[0]?.config
  assert.ok(config !== undefined && 'queueToken' in config)
  assert.notEqual(config.queueToken, 'token-from-the-original')
  assert.equal(config.hostname, 'api.blog-copy.localhost')
  // Issue #175: the key the restored worker will ask workerd for must be the
  // key the files on disk were written under. A new modifier plus a renamed
  // directory kept the directory and orphaned every object file inside it.
  assert.equal(config.durableObjectUniqueKeyModifier, worker.id, 'the unique key modifier is the original, not the new id')
  assert.notEqual(config.durableObjectUniqueKeyModifier, restored.resources[0]?.id)
  const restoredObject = join(
    ctx.paths.resourcePath('blog-copy', 'api', 'do'),
    `${worker.id}-Counter`,
    'b90dbd3f00000000000000000000000000000000000000000000000000000000.sqlite'
  )
  assert.equal(await readFile(restoredObject, 'utf8'), 'state', 'the object file is where the kept key points')
  // Both ports from the worker's own range (WORKER_PORT_RANGE,
  // packages/worker/src/worker.ts), and distinct.
  for (const port of [config.hostPort, config.controlPort]) {
    assert.ok(port >= 35433 && port <= 45432, `port ${port}`)
  }
  assert.notEqual(config.hostPort, config.controlPort)
})

test('restore rebinds an app to the restored database, not the original', async () => {
  // Issue #176: the restored app's DATABASE_URL named the source project's
  // container, so a "non-destructive" restore wrote into the original.
  const ctx = buildContext()
  const project = ctx.store.createProject({ name: 'blog', sleepAfterSeconds: null })
  // The app is listed before the database on purpose: the remap must not
  // depend on manifest order.
  const app = ctx.store.createResource({
    projectId: project.id,
    kind: 'app',
    name: 'web',
    config: appConfig('blog', 'web', 'placeholder' as ResourceId),
  })
  const primary = ctx.store.createResource({
    projectId: project.id,
    kind: 'postgres',
    name: 'primary',
    config: postgresConfig(ctx.paths, 'blog', 'primary'),
  })
  ctx.store.updateResourceConfig(app.id, appConfig('blog', 'web', primary.id))
  await mkdir(ctx.paths.resourcePath('blog', 'primary', 'pgdata'), { recursive: true })

  const taken = await takeSnapshot(ctx, 'blog', { now: () => Date.UTC(2026, 7, 16, 9, 0, 0), suffix: () => 'aaaaaa' })
  const restored = await restoreSnapshot(ctx, taken.snapshotId, { as: 'blog-copy' })

  const restoredDb = restored.resources.find((r) => r.kind === 'postgres')
  const restoredApp = restored.resources.find((r) => r.kind === 'app')
  assert.ok(restoredDb !== undefined && restoredApp !== undefined && 'databaseResourceId' in restoredApp.config)
  assert.equal(restoredApp.config.databaseResourceId, restoredDb.id)
  assert.notEqual(restoredApp.config.databaseResourceId, primary.id)
})

test('restore refuses a leftover directory at the target path with a conflict, not an internal error', async () => {
  // Issue #178: what rm left under projects/<name> made cloneTree throw a
  // plain Error, which reached the CLI as "internal error".
  const ctx = buildContext()
  const project = ctx.store.createProject({ name: 'blog', sleepAfterSeconds: null })
  ctx.store.createResource({
    projectId: project.id,
    kind: 'postgres',
    name: 'primary',
    config: postgresConfig(ctx.paths, 'blog', 'primary'),
  })
  await mkdir(ctx.paths.resourcePath('blog', 'primary', 'pgdata'), { recursive: true })
  await mkdir(ctx.paths.resourcePath('leftover', 'primary', 'pgdata'), { recursive: true })

  const taken = await takeSnapshot(ctx, 'blog', { now: () => Date.UTC(2026, 7, 16, 9, 0, 0), suffix: () => 'aaaaaa' })

  await assert.rejects(restoreSnapshot(ctx, taken.snapshotId, { as: 'leftover' }), (err: unknown) => {
    assert.ok(err instanceof HobbyError)
    assert.equal(err.code, 'conflict')
    assert.match(err.message, /leftover already exists, but no project named leftover does/)
    return true
  })
})

test('restore refuses a name that is already taken', async () => {
  const ctx = buildContext()
  const project = ctx.store.createProject({ name: 'blog', sleepAfterSeconds: null })
  ctx.store.createResource({
    projectId: project.id,
    kind: 'postgres',
    name: 'primary',
    config: postgresConfig(ctx.paths, 'blog', 'primary'),
  })
  await mkdir(ctx.paths.resourcePath('blog', 'primary', 'pgdata'), { recursive: true })
  ctx.store.createProject({ name: 'taken', sleepAfterSeconds: null })

  const taken = await takeSnapshot(ctx, 'blog', { now: () => Date.UTC(2026, 7, 16, 9, 0, 0), suffix: () => 'aaaaaa' })

  await assert.rejects(restoreSnapshot(ctx, taken.snapshotId, { as: 'taken' }), /already/)
})
