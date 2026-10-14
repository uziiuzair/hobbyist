// An app or worker bound to a sibling postgres (AppConfig.databaseResourceId,
// WorkerConfig.databaseResourceId) reaches it directly by container name on
// the project network, never through the wake proxy (databaseUrlFor in
// packages/app/src/app.ts, hyperdriveUrl in packages/worker/src/worker.ts).
// So the proxy can neither wake that database for the app nor see the app's
// pool as activity, and the daemon has to keep the pair together itself:
// waking the app wakes its database first, and the hibernator never sleeps a
// database out from under an awake app.
//
// Real kind handlers (startPostgres, startApp, startWorker), the real wake
// function and the real hibernator tick, against an in-memory store and a
// fake runtime that records the order containers were started in. No Docker.

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
  type ComputeRuntime,
  type HobbyConfig,
  type PostgresConfig,
  type ResourceState,
  type WorkerConfig,
} from '@hobby.sh/core'
import type { ActivityGuardResult } from '@hobby.sh/pg'
import { ActivityTracker } from '@hobby.sh/proxy'
import { createApp, startHibernator, type DaemonContext } from '../src/index.js'
import { createDefaultKindRegistry, getOrCreateWake, isWakeRefused } from '../src/daemon/context.js'

function testConfig(): HobbyConfig {
  return {
    image: 'postgres:18-alpine',
    proxyPort: 5432,
    proxyHost: '127.0.0.1',
    studioPort: 8443,
    apiPort: 7432,
    httpPort: 7433,
    domain: 'localhost',
    sleepAfterSeconds: 300,
    wakeTimeoutMs: 500,
    readinessPollMs: 10,
    queuePort: 0,
    caddyEnabled: false,
    caddyAdminPort: 2019,
    caddyStudioHost: null,
    proxyTls: null,
    project: null,
  }
}

// A runtime that records every container start, in order, and throws for
// any container name in `broken`.
function recordingRuntime(): { runtime: ComputeRuntime; starts: string[]; broken: Set<string> } {
  const base = createFakeRuntime()
  const starts: string[] = []
  const broken = new Set<string>()
  const runtime: ComputeRuntime = {
    ...base,
    async start(name: string): Promise<void> {
      starts.push(name)
      if (broken.has(name)) {
        throw new Error('container exited immediately: exec format error')
      }
      await base.start(name)
    },
  }
  return { runtime, starts, broken }
}

// The app and worker readiness seams are not DaemonContext fields: each kind
// reads its own namespaced one off the context it is handed structurally
// (AppDeps.appProbeFactory, WorkerDeps.workerProbeFactory), so they are
// added alongside rather than declared.
type TestContext = DaemonContext & {
  appProbeFactory: (config: AppConfig) => () => Promise<boolean>
  workerProbeFactory: (config: WorkerConfig) => () => Promise<boolean>
}

function buildContext(runtime: ComputeRuntime, activity = new ActivityTracker()): TestContext {
  return {
    store: openStore(':memory:'),
    runtime,
    paths: resolvePaths({ HOBBY_HOME: join(tmpdir(), `hobby-bound-db-test-${randomUUID()}`) }),
    config: testConfig(),
    activity,
    kinds: createDefaultKindRegistry(),
    probeFactory: () => async () => true,
    appProbeFactory: () => async () => true,
    workerProbeFactory: () => async () => true,
  }
}

function postgresConfig(): PostgresConfig {
  return {
    image: 'postgres:18-alpine',
    containerName: `hobby-blog-primary-${randomUUID()}`,
    dataDir: '/home/user/.hobby/projects/blog/primary/pgdata',
    hostPort: 25570,
    superuser: 'postgres',
    password: 'secret',
    database: 'blog',
  }
}

function appConfig(databaseResourceId: string | null): AppConfig {
  return {
    image: 'hobby/blog-web:1',
    containerName: `hobby-blog-web-${randomUUID()}`,
    hostPort: 25571,
    containerPort: 3000,
    hostname: 'web.blog.localhost',
    source: null,
    env: {},
    databaseResourceId,
  }
}

function workerConfig(databaseResourceId: string | null): WorkerConfig {
  return {
    image: 'hobby/workerd:1',
    containerName: `hobby-blog-api-${randomUUID()}`,
    hostPort: 35571,
    containerPort: 8787,
    controlPort: 35572,
    queueToken: 'test-queue-token',
    hostname: 'api.blog.localhost',
    durableObjectUniqueKeyModifier: 'stable-modifier',
    databaseResourceId,
    manifest: {
      source: { path: '/src/api', manifest: 'wrangler.toml' },
      compatibilityDate: '2026-08-01',
      compatibilityFlags: [],
      vars: {},
      kvNamespaces: [],
      r2Buckets: [],
      d1Databases: [],
      queues: { producers: [], consumers: [] },
      durableObjects: [],
    },
  }
}

// A project holding a database and an app bound to it, both in the given
// states. Returns ids and container names.
function boundPair(
  ctx: DaemonContext,
  opts: { db: ResourceState; app: ResourceState; sleepAfterSeconds?: number | null; kind?: 'app' | 'worker' }
): { projectId: string; dbId: string; dbContainer: string; appId: string; appContainer: string } {
  const project = ctx.store.createProject({ name: 'blog', sleepAfterSeconds: opts.sleepAfterSeconds === undefined ? 120 : opts.sleepAfterSeconds })
  const db = ctx.store.createResource({ projectId: project.id, kind: 'postgres', name: 'primary', config: postgresConfig() })
  ctx.store.setResourceState(db.id, opts.db)
  const app =
    opts.kind === 'worker'
      ? ctx.store.createResource({ projectId: project.id, kind: 'worker', name: 'api', config: workerConfig(db.id) })
      : ctx.store.createResource({ projectId: project.id, kind: 'app', name: 'web', config: appConfig(db.id) })
  ctx.store.setResourceState(app.id, opts.app)
  return {
    projectId: project.id,
    dbId: db.id,
    dbContainer: db.config.containerName,
    appId: app.id,
    appContainer: app.config.containerName,
  }
}

async function withApi(ctx: DaemonContext, fn: (baseUrl: string) => Promise<void>): Promise<void> {
  const server = createServer(createApp(ctx))
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  try {
    await fn(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)
  } finally {
    const closed = new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())))
    server.closeAllConnections()
    await closed
  }
}

// ---------------------------------------------------------------------------
// Wake: the app's database comes up first.
// ---------------------------------------------------------------------------

test('waking an app whose bound database is asleep wakes the database first, then the app', async () => {
  const { runtime, starts } = recordingRuntime()
  const ctx = buildContext(runtime)
  const pair = boundPair(ctx, { db: 'sleeping', app: 'sleeping' })

  await getOrCreateWake(ctx)(pair.appId)

  assert.deepEqual(starts, [pair.dbContainer, pair.appContainer], 'the database must be started, and ready, before the app')
  assert.equal(ctx.store.getResource(pair.dbId)?.state, 'running')
  assert.equal(ctx.store.getResource(pair.appId)?.state, 'running')
  ctx.store.close()
})

test('waking an app whose bound database is already running does not start the database again', async () => {
  const { runtime, starts } = recordingRuntime()
  const ctx = buildContext(runtime)
  const pair = boundPair(ctx, { db: 'running', app: 'sleeping' })

  await getOrCreateWake(ctx)(pair.appId)

  assert.deepEqual(starts, [pair.appContainer])
  assert.equal(ctx.store.getResource(pair.dbId)?.state, 'running')
  ctx.store.close()
})

test('a database that fails to wake fails the app wake with an error naming the database, and the app is not started', async () => {
  const { runtime, starts, broken } = recordingRuntime()
  const ctx = buildContext(runtime)
  const pair = boundPair(ctx, { db: 'sleeping', app: 'sleeping' })
  broken.add(pair.dbContainer)

  await assert.rejects(getOrCreateWake(ctx)(pair.appId), (err: unknown) => {
    assert.match((err as Error).message, /blog\/primary/, 'the error must name the database, not just the app')
    return true
  })
  assert.deepEqual(starts, [pair.dbContainer], 'the app container must never be started against a database that is down')
  assert.notEqual(ctx.store.getResource(pair.appId)?.state, 'running')
  // The failure is the database's, and its backoff is recorded against the
  // database alone: once `hobby wake` fixes the database, the app must not be
  // left refused for a failure that was never its own.
  assert.equal(isWakeRefused(ctx, pair.dbId), true)
  assert.equal(isWakeRefused(ctx, pair.appId), false)
  ctx.store.close()
})

test('an app with no bound database wakes exactly as before', async () => {
  const { runtime, starts } = recordingRuntime()
  const ctx = buildContext(runtime)
  const project = ctx.store.createProject({ name: 'blog', sleepAfterSeconds: 120 })
  const db = ctx.store.createResource({ projectId: project.id, kind: 'postgres', name: 'primary', config: postgresConfig() })
  ctx.store.setResourceState(db.id, 'sleeping')
  const app = ctx.store.createResource({ projectId: project.id, kind: 'app', name: 'web', config: appConfig(null) })
  ctx.store.setResourceState(app.id, 'sleeping')

  await getOrCreateWake(ctx)(app.id)

  assert.deepEqual(starts, [app.config.containerName])
  assert.equal(ctx.store.getResource(db.id)?.state, 'sleeping', 'an unbound sibling database is left asleep')
  ctx.store.close()
})

test('waking a worker whose bound database is asleep wakes the database first', async () => {
  const { runtime, starts } = recordingRuntime()
  const ctx = buildContext(runtime)
  const pair = boundPair(ctx, { db: 'sleeping', app: 'sleeping', kind: 'worker' })

  await getOrCreateWake(ctx)(pair.appId)

  assert.deepEqual(starts, [pair.dbContainer, pair.appContainer])
  assert.equal(ctx.store.getResource(pair.dbId)?.state, 'running')
  assert.equal(ctx.store.getResource(pair.appId)?.state, 'running')
  ctx.store.close()
})

test('an explicit start of an app (`hobby wake`) wakes its bound database first', async () => {
  const { runtime, starts } = recordingRuntime()
  const ctx = buildContext(runtime)
  const pair = boundPair(ctx, { db: 'sleeping', app: 'sleeping' })

  await withApi(ctx, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/v1/resources/${pair.appId}/start`, { method: 'POST' })
    assert.equal(res.status, 200)
  })

  assert.deepEqual(starts, [pair.dbContainer, pair.appContainer])
  assert.equal(ctx.store.getResource(pair.dbId)?.state, 'running')
  ctx.store.close()
})

test('an explicit start of an app whose database fails names the database', async () => {
  const { runtime, starts, broken } = recordingRuntime()
  const ctx = buildContext(runtime)
  const pair = boundPair(ctx, { db: 'sleeping', app: 'sleeping' })
  broken.add(pair.dbContainer)

  await withApi(ctx, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/v1/resources/${pair.appId}/start`, { method: 'POST' })
    assert.notEqual(res.status, 200)
    const body = (await res.json()) as { error: { message: string } }
    assert.match(body.error.message, /blog\/primary/)
  })
  assert.deepEqual(starts, [pair.dbContainer])
  ctx.store.close()
})

// ---------------------------------------------------------------------------
// Sleep: the hibernator leaves a database alone while its app is awake.
// ---------------------------------------------------------------------------

// Same single-step controller as hibernator.test.ts: each step() runs exactly
// one tick and resolves once it has finished.
function createStepController(): { sleepFor: (ms: number) => Promise<void>; step: () => Promise<void> } {
  let pendingRelease: (() => void) | null = null
  let onNextWait: (() => void) | null = null
  function sleepFor(): Promise<void> {
    return new Promise<void>((resolve) => {
      pendingRelease = resolve
      const notify = onNextWait
      onNextWait = null
      notify?.()
    })
  }
  function step(): Promise<void> {
    return new Promise<void>((resolveStep) => {
      onNextWait = resolveStep
      const release = pendingRelease
      pendingRelease = null
      release?.()
    })
  }
  return { sleepFor, step }
}

// A database that has been idle past its threshold by every measure the
// hibernator already had: no proxy connection, idle clock past
// sleepAfterSeconds, and a guard reporting no active query (which is exactly
// what an app's idle pool looks like from pg_stat_activity).
function idleDatabaseSetup(appState: ResourceState, kind: 'app' | 'worker' = 'app') {
  const clock = { nowMs: 1_000_000 }
  const activity = new ActivityTracker(() => clock.nowMs)
  const ctx = buildContext(createFakeRuntime(), activity)
  const pair = boundPair(ctx, { db: 'running', app: appState, kind })
  activity.close(activity.open(pair.dbId))
  clock.nowMs += 130_000
  let guardCalls = 0
  const guard = async (): Promise<ActivityGuardResult> => {
    guardCalls++
    return 'idle'
  }
  return { clock, ctx, pair, guard, guardCalls: () => guardCalls }
}

for (const appState of ['running', 'starting'] as const) {
  test(`hibernator: a database with a bound app that is ${appState} is not put to sleep`, async () => {
    const { clock, ctx, pair, guard } = idleDatabaseSetup(appState)
    const { sleepFor, step } = createStepController()
    const hibernator = startHibernator(ctx, { intervalMs: 1, now: () => clock.nowMs, sleepFor, checkActiveQuery: guard })
    try {
      await step()
      assert.equal(ctx.store.getResource(pair.dbId)?.state, 'running', 'the app holds a direct pool the proxy never sees')
    } finally {
      await hibernator.stop()
      ctx.store.close()
    }
  })
}

test('hibernator: a database with a bound worker that is running is not put to sleep', async () => {
  const { clock, ctx, pair, guard } = idleDatabaseSetup('running', 'worker')
  const { sleepFor, step } = createStepController()
  const hibernator = startHibernator(ctx, { intervalMs: 1, now: () => clock.nowMs, sleepFor, checkActiveQuery: guard })
  try {
    await step()
    assert.equal(ctx.store.getResource(pair.dbId)?.state, 'running')
  } finally {
    await hibernator.stop()
    ctx.store.close()
  }
})

test('hibernator: once the bound app is asleep, the database sleeps on its own idle rules', async () => {
  const { clock, ctx, pair, guard } = idleDatabaseSetup('running')
  const { sleepFor, step } = createStepController()
  const hibernator = startHibernator(ctx, { intervalMs: 1, now: () => clock.nowMs, sleepFor, checkActiveQuery: guard })
  try {
    await step()
    assert.equal(ctx.store.getResource(pair.dbId)?.state, 'running')

    ctx.store.setResourceState(pair.appId, 'sleeping')
    await step()
    assert.equal(ctx.store.getResource(pair.dbId)?.state, 'sleeping')
  } finally {
    await hibernator.stop()
    ctx.store.close()
  }
})

test('hibernator: a database with no dependents sleeps exactly as before', async () => {
  const clock = { nowMs: 1_000_000 }
  const activity = new ActivityTracker(() => clock.nowMs)
  const ctx = buildContext(createFakeRuntime(), activity)
  const project = ctx.store.createProject({ name: 'blog', sleepAfterSeconds: 120 })
  const db = ctx.store.createResource({ projectId: project.id, kind: 'postgres', name: 'primary', config: postgresConfig() })
  ctx.store.setResourceState(db.id, 'running')
  // A running app in the same project that is NOT bound to this database
  // must not hold it awake.
  const app = ctx.store.createResource({ projectId: project.id, kind: 'app', name: 'web', config: appConfig(null) })
  ctx.store.setResourceState(app.id, 'running')
  activity.close(activity.open(db.id))
  clock.nowMs += 130_000

  const { sleepFor, step } = createStepController()
  const hibernator = startHibernator(ctx, {
    intervalMs: 1,
    now: () => clock.nowMs,
    sleepFor,
    checkActiveQuery: async () => 'idle',
  })
  try {
    await step()
    assert.equal(ctx.store.getResource(db.id)?.state, 'sleeping')
  } finally {
    await hibernator.stop()
    ctx.store.close()
  }
})

test('hibernator: an app that starts waking while the guard is in flight still keeps its database awake', async () => {
  const clock = { nowMs: 1_000_000 }
  const activity = new ActivityTracker(() => clock.nowMs)
  const ctx = buildContext(createFakeRuntime(), activity)
  const pair = boundPair(ctx, { db: 'running', app: 'sleeping' })
  activity.close(activity.open(pair.dbId))
  clock.nowMs += 130_000

  // The guard is the one await between deciding and stopping. An app wake
  // landing there (which, after this fix, finds its database running and
  // goes straight to starting the app) must abort the sleep.
  const guard = async (): Promise<ActivityGuardResult> => {
    ctx.store.setResourceState(pair.appId, 'starting')
    return 'idle'
  }
  const { sleepFor, step } = createStepController()
  const hibernator = startHibernator(ctx, { intervalMs: 1, now: () => clock.nowMs, sleepFor, checkActiveQuery: guard })
  try {
    await step()
    assert.equal(ctx.store.getResource(pair.dbId)?.state, 'running')
  } finally {
    await hibernator.stop()
    ctx.store.close()
  }
})
