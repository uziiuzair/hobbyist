// Which queues the queue tick is handed each tick.
//
// tick.ts (packages/queue/src/tick.ts) is tested against a fake list with no
// store in the loop at all. What is tested here is the join to the store,
// mirroring alarm-namespaces.test.ts's own split for durableObjectNamespaces:
// specifically the exclusion this task's brief calls out as one of four
// constraints that fail silently if missed, a queue whose consumer worker has
// no deployed code must be excluded from the list, never woken.

import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import {
  createFakeRuntime,
  openStore,
  resolvePaths,
  type HobbyConfig,
  type QueueConfig,
  type Store,
  type WorkerConfig,
  type WorkerManifest,
} from '@hobby.sh/core'
import { ActivityTracker } from '@hobby.sh/proxy'
import { drainableQueues, queueDeliverFn, queueStateOf } from '../src/daemon/queues.js'
import { createDefaultKindRegistry, type DaemonContext } from '../src/daemon/context.js'

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

function buildContext(): DaemonContext {
  const home = join(tmpdir(), `hobby-queues-join-${randomUUID()}`)
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

// Split from workerConfig so a test that only wants to change `queues` does
// not have to spread a `WorkerManifest | null` field, which TypeScript widens
// to all-optional and which would then no longer satisfy WorkerManifest.
function workerManifest(overrides: Partial<WorkerManifest> = {}): WorkerManifest {
  return {
    source: { path: '/code/api', manifest: 'wrangler.toml' },
    compatibilityDate: '2026-08-01',
    compatibilityFlags: [],
    vars: {},
    kvNamespaces: [],
    r2Buckets: [],
    d1Databases: [],
    queues: {
      producers: [],
      consumers: [
        {
          queue: 'jobs',
          maxBatchSize: null,
          maxBatchTimeoutSeconds: null,
          maxRetries: null,
          retryDelaySeconds: null,
          deadLetterQueue: null,
        },
      ],
    },
    durableObjects: [],
    ...overrides,
  }
}

function workerConfig(overrides: Partial<WorkerConfig> = {}): WorkerConfig {
  return {
    image: 'hobby/api-worker:1',
    containerName: 'hobby-chat-api',
    hostPort: 35433,
    controlPort: 35434,
    queueToken: 'test-queue-token',
    containerPort: 8787,
    hostname: 'api.chat.localhost',
    durableObjectUniqueKeyModifier: 'unused-here',
    databaseResourceId: null,
    manifest: workerManifest(),
    ...overrides,
  }
}

function queueConfig(overrides: Partial<QueueConfig> = {}): QueueConfig {
  return {
    image: '',
    containerName: '',
    hostPort: 0,
    retentionSeconds: 345_600,
    consumerResourceId: null,
    maxBatchSize: 5,
    maxBatchTimeoutSeconds: 1,
    maxRetries: 2,
    retryDelaySeconds: 0,
    deadLetterQueue: null,
    ...overrides,
  }
}

test('a queue bound to a worker with a real consumer binding is drainable', () => {
  const ctx = buildContext()
  try {
    const project = ctx.store.createProject({ name: 'chat', sleepAfterSeconds: 300 })
    const worker = ctx.store.createResource({
      projectId: project.id,
      kind: 'worker',
      name: 'api',
      config: workerConfig(),
    })
    ctx.store.createResource({
      projectId: project.id,
      kind: 'queue',
      name: 'jobs',
      config: queueConfig({ consumerResourceId: worker.id }),
    })

    const queues = drainableQueues(ctx)
    assert.equal(queues.length, 1)
    assert.equal(queues[0]?.consumerResourceId, worker.id)
    assert.equal(queues[0]?.queueName, 'jobs')
  } finally {
    ctx.store.close()
  }
})

test('a queue with no consumer configured is excluded: it still accepts sends, but nothing drains it', () => {
  const ctx = buildContext()
  try {
    const project = ctx.store.createProject({ name: 'chat', sleepAfterSeconds: 300 })
    ctx.store.createResource({
      projectId: project.id,
      kind: 'queue',
      name: 'jobs',
      config: queueConfig({ consumerResourceId: null }),
    })

    assert.deepEqual(drainableQueues(ctx), [])
  } finally {
    ctx.store.close()
  }
})

// Constraint 2 of this task's brief: a consumer whose worker has no deployed
// code must be skipped, not woken, because waking a worker with no code
// starts a container that immediately exits and the daemon records that as a
// crash loop. Keyed on WorkerConfig.manifest.queues.consumers being empty:
// deployed code that binds no consumer. hasNoDeployedCode (queues.ts) reads
// the other signal, manifest === null, in the same breath.
test('a worker with no queue consumer bindings at all is excluded, its queue kept but not drained', () => {
  const ctx = buildContext()
  try {
    const project = ctx.store.createProject({ name: 'chat', sleepAfterSeconds: 300 })
    const worker = ctx.store.createResource({
      projectId: project.id,
      kind: 'worker',
      name: 'api',
      config: workerConfig({ manifest: workerManifest({ queues: { producers: [], consumers: [] } }) }),
    })
    ctx.store.createResource({
      projectId: project.id,
      kind: 'queue',
      name: 'jobs',
      config: queueConfig({ consumerResourceId: worker.id }),
    })

    assert.deepEqual(drainableQueues(ctx), [])
  } finally {
    ctx.store.close()
  }
})

// The other half of constraint 2: WorkerConfig.manifest is WorkerManifest |
// null on the branch this task merges with, and this checks it structurally
// (`'manifest' in config && config.manifest === null`) so it is correct
// whether or not the field exists on the type here yet. Simulated with a raw
// cast, since WorkerConfig does not declare the field on this branch.
test('a worker whose config carries manifest: null (the future branch shape) is excluded too', () => {
  const ctx = buildContext()
  try {
    const project = ctx.store.createProject({ name: 'chat', sleepAfterSeconds: 300 })
    const configWithManifest = { ...workerConfig(), manifest: null } as unknown as WorkerConfig
    const worker = ctx.store.createResource({
      projectId: project.id,
      kind: 'worker',
      name: 'api',
      config: configWithManifest,
    })
    ctx.store.createResource({
      projectId: project.id,
      kind: 'queue',
      name: 'jobs',
      config: queueConfig({ consumerResourceId: worker.id }),
    })

    assert.deepEqual(drainableQueues(ctx), [])
  } finally {
    ctx.store.close()
  }
})

test('a queue in a released project is excluded', () => {
  const ctx = buildContext()
  try {
    const project = ctx.store.createProject({ name: 'chat', sleepAfterSeconds: 300 })
    const worker = ctx.store.createResource({
      projectId: project.id,
      kind: 'worker',
      name: 'api',
      config: workerConfig(),
    })
    ctx.store.createResource({
      projectId: project.id,
      kind: 'queue',
      name: 'jobs',
      config: queueConfig({ consumerResourceId: worker.id }),
    })
    ctx.store.setProjectReleased(project.id, new Date())

    assert.deepEqual(drainableQueues(ctx), [])
  } finally {
    ctx.store.close()
  }
})

test('queueStateOf reads the store, and treats a vanished resource as failed rather than sleeping', () => {
  const ctx = buildContext()
  try {
    const project = ctx.store.createProject({ name: 'chat', sleepAfterSeconds: 300 })
    const worker = ctx.store.createResource({
      projectId: project.id,
      kind: 'worker',
      name: 'api',
      config: workerConfig(),
    })
    ctx.store.setResourceState(worker.id, 'running')

    const stateOf = queueStateOf(ctx)
    assert.equal(stateOf(worker.id), 'running')
    // 'failed', not 'sleeping': 'sleeping' would make the tick call wake() on
    // an id the store no longer has a row for.
    assert.equal(stateOf('no-such-resource'), 'failed')
  } finally {
    ctx.store.close()
  }
})

test('queueDeliverFn never reaches the network for a consumer that no longer resolves to a worker', async () => {
  const ctx = buildContext()
  try {
    const deliver = queueDeliverFn(ctx)
    const result = await deliver('no-such-resource', { leaseId: 'l', messages: [], backlogCount: 0, backlogBytes: 0, oldestMessageTimestampMs: null }, 'jobs')
    assert.equal(result.outcome, 'exception')
    assert.equal(result.retryBatch.retry, false)
  } finally {
    ctx.store.close()
  }
})
