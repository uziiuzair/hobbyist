// M6's actual acceptance criterion, at the daemon level: a kind the daemon
// has never heard of before can be registered, and every control path in the
// daemon (start, stop, destroy, hibernation, the wire boundary) acts on it
// without a single line naming it.
//
// The handler here is a stub with no container behind it, which is the whole
// point: none of this needs Docker, Postgres, or a real network. If any of
// these tests ever requires a real runtime to pass, a dispatch site has
// quietly started reaching past the registry.

import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  createFakeRuntime,
  createKindRegistry,
  openStore,
  resolvePaths,
  type AppConfig,
  type HobbyConfig,
  type KindContext,
  type PostgresConfig,
  type QueueConfig,
  type Resource,
  type ResourceKindHandler,
  type Store,
  type WorkerConfig,
  type WorkerManifest,
} from '@hobby.sh/core'
import { postgresKindHandler } from '@hobby.sh/pg'
import { ActivityTracker } from '@hobby.sh/proxy'
import { createProxyDeps, type DaemonContext } from '../src/index.js'
import { startHibernator } from '../src/daemon/hibernator.js'
import { toWireResource } from '../src/daemon/wire.js'

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
    wakeTimeoutMs: 150,
    readinessPollMs: 20,
    queuePort: 0,
    caddyEnabled: false,
    caddyAdminPort: 2019,
    caddyStudioHost: null,
    ...overrides,
  }
}

// A stand-in for the `app` handler M8 will write. It records calls and
// touches nothing.
function stubAppHandler(): ResourceKindHandler & { calls: string[] } {
  const calls: string[] = []
  return {
    kind: 'app',
    calls,
    async start(_ctx: KindContext, resource: Resource): Promise<void> {
      calls.push(`start:${resource.name}`)
      _ctx.store.setResourceState(resource.id, 'running')
    },
    async stop(_ctx: KindContext, resource: Resource): Promise<void> {
      calls.push(`stop:${resource.name}`)
      _ctx.store.setResourceState(resource.id, 'sleeping')
    },
    async destroy(_ctx: KindContext, resource: Resource): Promise<void> {
      calls.push(`destroy:${resource.name}`)
      _ctx.store.deleteResource(resource.id)
    },
    async probe(_ctx: KindContext, resource: Resource): Promise<boolean> {
      calls.push(`probe:${resource.name}`)
      return true
    },
  }
}

function buildContext(
  handler: ResourceKindHandler,
  activity: ActivityTracker = new ActivityTracker()
): DaemonContext {
  const store: Store = openStore(':memory:')
  const paths = resolvePaths({ HOBBY_HOME: join(tmpdir(), `hobby-kind-test-${randomUUID()}`) })
  return {
    store,
    runtime: createFakeRuntime(),
    paths,
    config: testConfig(),
    activity,
    kinds: createKindRegistry([postgresKindHandler, handler]),
  }
}

function sampleAppConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    image: 'hobby/blog-web:1',
    containerName: `hobby-blog-web-${randomUUID()}`,
    hostPort: 15500,
    containerPort: 3000,
    hostname: 'web.blog.localhost',
    source: null,
    env: { STRIPE_SECRET_KEY: 'sk_live_do_not_leak', PUBLIC_URL: 'https://example.com' },
    databaseResourceId: null,
    ...overrides,
  }
}

// Split out from sampleWorkerConfig so a test that only wants to change
// `vars` can do so without spreading a `WorkerManifest | null` field, which
// widens every property to optional under TypeScript's spread rules and
// defeats the point of a typed factory.
function sampleWorkerManifest(overrides: Partial<WorkerManifest> = {}): WorkerManifest {
  return {
    source: { path: '/src/api', manifest: 'wrangler.toml' },
    compatibilityDate: '2026-08-01',
    compatibilityFlags: [],
    vars: { API_KEY: 'sk-live-secret' },
    kvNamespaces: [],
    r2Buckets: [],
    d1Databases: [],
    queues: { producers: [], consumers: [] },
    durableObjects: [],
    ...overrides,
  }
}

// Mirrors sampleAppConfig / samplePostgresConfig above: a full, valid
// WorkerConfig with a deployed manifest, so tests that only care about one
// field can override it and leave the rest alone.
function sampleWorkerConfig(overrides: Partial<WorkerConfig> = {}): WorkerConfig {
  return {
    image: 'hobby/workerd:1',
    containerName: `hobby-blog-api-${randomUUID()}`,
    hostPort: 15600,
    containerPort: 8787,
    controlPort: 15601,
    queueToken: 'test-queue-token',
    hostname: 'api.blog.localhost',
    durableObjectUniqueKeyModifier: 'stable-modifier',
    databaseResourceId: null,
    manifest: sampleWorkerManifest(),
    ...overrides,
  }
}

function samplePostgresConfig(overrides: Partial<PostgresConfig> = {}): PostgresConfig {
  return {
    image: 'postgres:18-alpine',
    containerName: `hobby-blog-primary-${randomUUID()}`,
    hostPort: 25555,
    dataDir: '/home/user/.hobby/projects/blog/primary/pgdata',
    superuser: 'postgres',
    password: 'a'.repeat(32),
    database: 'blog',
    ...overrides,
  }
}

function sampleQueueConfig(overrides: Partial<QueueConfig> = {}): QueueConfig {
  return {
    // Unused by a queue, present only because every existing call site that
    // reads them expects them on any resource. See the comment on
    // ResourceConfigBase and on QueueConfig itself in core's types.ts.
    image: '',
    containerName: '',
    hostPort: 0,
    retentionSeconds: 345600,
    consumerResourceId: null,
    maxBatchSize: 5,
    maxBatchTimeoutSeconds: 1,
    maxRetries: 2,
    retryDelaySeconds: 0,
    deadLetterQueue: null,
    ...overrides,
  }
}

// Drives startHibernator's loop one tick at a time, copied in shape from
// hibernator.test.ts's own controller. A `sleepFor` that resolves
// immediately would spin the loop for as long as the test lives, which is
// millions of iterations, not a handful.
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

test('hibernation sleeps a kind it has never heard of, through the registry alone', async () => {
  const handler = stubAppHandler()
  // The tracker gets the same fake clock the hibernator reads, so idle time
  // is a number this test controls rather than whatever wall clock the
  // machine happens to have.
  const clock = { nowMs: 1_000_000 }
  const activity = new ActivityTracker(() => clock.nowMs)
  const ctx = buildContext(handler, activity)
  const project = ctx.store.createProject({ name: 'blog', sleepAfterSeconds: 60 })
  const resource = ctx.store.createResource({
    projectId: project.id,
    kind: 'app',
    name: 'web',
    config: sampleAppConfig(),
  })
  ctx.store.setResourceState(resource.id, 'running')

  // An idle clock the tick can actually read. touch() is what every wake
  // path already calls (see PgDeps.activity), so this is the same state a
  // real running app would be in.
  activity.touch(resource.id)
  clock.nowMs += 120_000

  const { sleepFor, step } = createStepController()
  const hibernator = startHibernator(ctx, { intervalMs: 1, now: () => clock.nowMs, sleepFor })
  try {
    await step()
    assert.deepEqual(handler.calls, ['stop:web'], 'the app handler should have been asked to stop its resource')
    assert.equal(ctx.store.getResource(resource.id)?.state, 'sleeping')
  } finally {
    await hibernator.stop()
  }
})

// The pre-sleep guard is optional, and a kind that declares none must read as
// 'idle' rather than 'unreachable'. If that default ever flipped, no app or
// worker would ever sleep and the wedge would silently stop applying to
// everything Phase 2 adds.
test('a kind with no guard is still allowed to sleep', async () => {
  const handler = stubAppHandler()
  assert.equal(handler.guard, undefined, 'this stub deliberately declares no guard')
  const clock = { nowMs: 500 }
  const activity = new ActivityTracker(() => clock.nowMs)
  const ctx = buildContext(handler, activity)
  const project = ctx.store.createProject({ name: 'blog', sleepAfterSeconds: 1 })
  const resource = ctx.store.createResource({
    projectId: project.id,
    kind: 'app',
    name: 'web',
    config: sampleAppConfig(),
  })
  ctx.store.setResourceState(resource.id, 'running')

  activity.touch(resource.id)
  clock.nowMs += 10_000

  const { sleepFor, step } = createStepController()
  const hibernator = startHibernator(ctx, { intervalMs: 1, now: () => clock.nowMs, sleepFor })
  try {
    await step()
    assert.deepEqual(handler.calls, ['stop:web'])
  } finally {
    await hibernator.stop()
  }
})

// Port 5432 speaks one protocol. Deploying an app into a project must not
// make psql against that project's database ambiguous, which is exactly what
// would have happened before resolve filtered by kind.
test('the postgres proxy ignores non-postgres resources when resolving a project', async () => {
  const ctx = buildContext(stubAppHandler())
  const project = ctx.store.createProject({ name: 'blog', sleepAfterSeconds: null })
  const pg = ctx.store.createResource({
    projectId: project.id,
    kind: 'postgres',
    name: 'primary',
    config: samplePostgresConfig(),
  })
  ctx.store.createResource({
    projectId: project.id,
    kind: 'app',
    name: 'web',
    config: sampleAppConfig(),
  })

  const deps = createProxyDeps(ctx)
  const target = await deps.resolve('blog')

  assert.ok(target !== null, 'a project holding one database and one app still resolves')
  assert.equal(target.resourceId, pg.id)
  assert.equal(target.database, 'blog')
})

test('a project with two databases is still ambiguous, apps notwithstanding', async () => {
  const ctx = buildContext(stubAppHandler())
  const project = ctx.store.createProject({ name: 'blog', sleepAfterSeconds: null })
  for (const name of ['primary', 'analytics']) {
    ctx.store.createResource({
      projectId: project.id,
      kind: 'postgres',
      name,
      config: samplePostgresConfig(),
    })
  }

  const deps = createProxyDeps(ctx)
  await assert.rejects(() => deps.resolve('blog'), /more than one postgres resource/)
})

// The wire boundary is where a payload stops being internal state. Phase 1
// had one secret to strip; an app's env and a worker's vars hold whatever
// the user put in them, which in practice is third-party API keys, and this
// payload reaches --json output, shell history and CI logs.
test('an app env value never crosses the wire boundary', async () => {
  const ctx = buildContext(stubAppHandler())
  const project = ctx.store.createProject({ name: 'blog', sleepAfterSeconds: null })
  const resource = ctx.store.createResource({
    projectId: project.id,
    kind: 'app',
    name: 'web',
    config: sampleAppConfig(),
  })

  const wire = await toWireResource(ctx, resource)
  const serialized = JSON.stringify(wire)

  assert.equal(serialized.includes('sk_live_do_not_leak'), false, 'a secret in env must not reach the wire')
  assert.equal(serialized.includes('https://example.com'), false, 'every env value is redacted, not a guessed subset')
  // The KEYS survive, so a caller can still see which variables are set.
  assert.match(serialized, /STRIPE_SECRET_KEY/)
  assert.match(serialized, /PUBLIC_URL/)
})

test('a worker vars value never crosses the wire boundary', async () => {
  const ctx = buildContext(stubAppHandler())
  const project = ctx.store.createProject({ name: 'blog', sleepAfterSeconds: null })
  const config: WorkerConfig = {
    image: 'hobby/workerd:1',
    containerName: 'hobby-blog-api',
    hostPort: 15600,
    controlPort: 15601,
    queueToken: 'test-queue-token',
    containerPort: 8787,
    hostname: 'api.blog.localhost',
    durableObjectUniqueKeyModifier: 'stable-modifier',
    databaseResourceId: null,
    manifest: {
      source: { path: '/src/api', manifest: 'wrangler.toml' },
      compatibilityDate: '2026-08-01',
      compatibilityFlags: [],
      vars: { OPENAI_API_KEY: 'sk-do-not-leak' },
      kvNamespaces: [],
      r2Buckets: [],
      d1Databases: [],
      queues: { producers: [], consumers: [] },
      durableObjects: [],
    },
  }
  const resource = ctx.store.createResource({
    projectId: project.id,
    kind: 'worker',
    name: 'api',
    config,
  })

  const wire = await toWireResource(ctx, resource)
  const serialized = JSON.stringify(wire)

  assert.equal(serialized.includes('sk-do-not-leak'), false)
  assert.match(serialized, /OPENAI_API_KEY/)
})

// A queue config holds no user-supplied secret: no password, no env, no
// vars. Before redactConfig gave 'queue' its own branch, an unhandled kind
// fell through into the worker branch and called redactValues on a
// QueueConfig's missing `vars` field, which threw a TypeError the moment any
// route listed or fetched a queue resource (Object.keys(undefined) throws).
// This asserts the fix: the call does not throw, and every field survives
// unredacted, because none of them is a secret.
test('a queue config crosses the wire boundary unredacted, and toWireResource does not throw', async () => {
  const ctx = buildContext(stubAppHandler())
  const project = ctx.store.createProject({ name: 'blog', sleepAfterSeconds: null })
  const resource = ctx.store.createResource({
    projectId: project.id,
    kind: 'queue',
    name: 'events',
    config: sampleQueueConfig({ deadLetterQueue: 'events-dlq', maxBatchSize: 7 }),
  })

  const wire = await toWireResource(ctx, resource)
  const serialized = JSON.stringify(wire)

  assert.match(serialized, /"deadLetterQueue":"events-dlq"/)
  assert.match(serialized, /"maxBatchSize":7/)
  assert.match(serialized, /"retentionSeconds":345600/)
})

// `vars` moved inside `manifest` when the worker manifest split landed
// (packages/core/src/types.ts's WorkerConfig). redactConfig
// (packages/cli/src/daemon/wire.ts) had to follow it one level deeper. This
// asserts the exact nested position rather than just "the secret is gone
// somewhere", because a `return { ...worker }` fallback would also make the
// secret vanish from `vars` (it would just still be sitting there, unredacted).
test('a worker var is redacted in its nested position', async () => {
  const ctx = buildContext(stubAppHandler())
  const project = ctx.store.createProject({ name: 'blog', sleepAfterSeconds: null })
  const resource = ctx.store.createResource({
    projectId: project.id,
    kind: 'worker',
    name: 'api',
    config: sampleWorkerConfig({ manifest: sampleWorkerManifest({ vars: { API_KEY: 'sk-live-secret' } }) }),
  })

  const wire = await toWireResource(ctx, resource)

  assert.equal(wire.kind === 'worker' ? wire.config.manifest?.vars['API_KEY'] : undefined, '<redacted>')
})

// Separate from the nested-position test above on purpose: that test only
// proves `vars.API_KEY` itself got overwritten. It would still pass if a
// second, unredacted copy of the secret sat in some other field of the wire
// payload. Asserting against the whole serialised payload is the assertion
// that keeps catching a leak the next time this field moves.
test('a worker secret does not appear anywhere in the serialised wire payload', async () => {
  const ctx = buildContext(stubAppHandler())
  const project = ctx.store.createProject({ name: 'blog', sleepAfterSeconds: null })
  const resource = ctx.store.createResource({
    projectId: project.id,
    kind: 'worker',
    name: 'api',
    config: sampleWorkerConfig({ manifest: sampleWorkerManifest({ vars: { API_KEY: 'sk-live-secret' } }) }),
  })

  const wire = await toWireResource(ctx, resource)

  assert.ok(!JSON.stringify(wire).includes('sk-live-secret'))
})

// A worker whose code has never been deployed has `manifest: null`
// (WorkerConfig.manifest, packages/core/src/types.ts). redactConfig must
// pass that through as null rather than throw on `worker.manifest.vars` or
// fabricate an empty manifest object that was never actually deployed.
test('a worker with no manifest survives the wire round trip', async () => {
  const ctx = buildContext(stubAppHandler())
  const project = ctx.store.createProject({ name: 'blog', sleepAfterSeconds: null })
  const resource = ctx.store.createResource({
    projectId: project.id,
    kind: 'worker',
    name: 'api',
    config: sampleWorkerConfig({ image: null, manifest: null }),
  })

  const wire = await toWireResource(ctx, resource)

  assert.equal(wire.kind === 'worker' ? wire.config.manifest : undefined, null)
})

// redactConfig's app and worker branches sit next to each other
// (packages/cli/src/daemon/wire.ts), and the worker branch was the one
// rewritten to reach into `manifest`. This guards that the neighbouring app
// branch, which still redacts `env` at the top level (AppConfig.env,
// packages/core/src/types.ts), was not disturbed by that edit.
test('an app env value is still redacted after the manifest edit', async () => {
  const ctx = buildContext(stubAppHandler())
  const project = ctx.store.createProject({ name: 'blog', sleepAfterSeconds: null })
  const resource = ctx.store.createResource({
    projectId: project.id,
    kind: 'app',
    name: 'web',
    config: sampleAppConfig({ env: { STRIPE_SECRET_KEY: 'sk_live_still_redacted' } }),
  })

  const wire = await toWireResource(ctx, resource)

  assert.equal(wire.kind === 'app' ? wire.config.env['STRIPE_SECRET_KEY'] : undefined, '<redacted>')
  assert.ok(!JSON.stringify(wire).includes('sk_live_still_redacted'))
})

// Size is a database question. Asking it of an app must not reach for a
// Postgres connection that cannot exist.
test('size is null for a non-postgres resource, with no query attempted', async () => {
  const ctx = buildContext(stubAppHandler())
  const project = ctx.store.createProject({ name: 'blog', sleepAfterSeconds: null })
  const resource = ctx.store.createResource({
    projectId: project.id,
    kind: 'app',
    name: 'web',
    config: sampleAppConfig(),
  })
  ctx.store.setResourceState(resource.id, 'running')

  const wire = await toWireResource(ctx, ctx.store.getResource(resource.id) as Resource)
  assert.equal(wire.sizeBytes, null)
})

// allocatePort used to read config.hostPort off every row unconditionally.
// A kind without one would have added `undefined` to the taken set, and the
// next allocation would have handed out a port already in use, with no error
// anywhere.
test('allocatePort ignores a config that carries no host port', () => {
  const ctx = buildContext(stubAppHandler())
  const project = ctx.store.createProject({ name: 'blog', sleepAfterSeconds: null })
  ctx.store.createResource({
    projectId: project.id,
    kind: 'postgres',
    name: 'primary',
    config: samplePostgresConfig({ hostPort: 15432 }),
  })
  // A row whose config genuinely has no hostPort. No kind looks like this
  // today, which is why this is written by hand rather than through a
  // handler: the guard exists so that adding one later cannot silently
  // double-allocate.
  ctx.store.createResource({
    projectId: project.id,
    kind: 'app',
    name: 'portless',
    config: { image: 'x', containerName: 'y' } as unknown as AppConfig,
  })

  assert.equal(ctx.store.allocatePort(15432, 15434), 15433)
})
