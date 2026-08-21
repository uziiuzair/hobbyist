// The worker kind's composed guard: durableObjectAlarmGuard (@hobby.sh/do)
// and queueDeliveryGuard (@hobby.sh/queue), OR'd for 'active', OR'd for
// 'unreachable', and only 'idle' when both agree. Each half already has its
// own unit tests (packages/do/test/guard.test.ts, and packages/queue's own
// broker/tick tests exercising hasOutstandingLease); what is untested
// anywhere else is the composition itself; 'unreachable' beating 'active'
// specifically, since that is the direction core's own rule
// (packages/core/src/kinds.ts: "a guard that could not answer must never be
// read as permission to stop") is easiest to get backwards.

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { openDatabase, openStore, resolvePaths, type HobbyConfig, type Paths, type Store, type WorkerResource } from '@hobby.sh/core'
import { DEFAULT_CONSUMER_OPTIONS, enqueue, leaseBatch, openQueueDb, queueDbPath } from '@hobby.sh/queue'
import { workerKindHandler } from '../src/kind.js'
import { uniqueKeyFor, type WorkerDeps } from '../src/worker.js'

const NOW = 1786375171389

function testConfig(): HobbyConfig {
  return {
    image: 'postgres:18-alpine',
    proxyPort: 5432,
    studioPort: 8443,
    apiPort: 7432,
    httpPort: 7433,
    domain: 'localhost',
    sleepAfterSeconds: 300,
    wakeTimeoutMs: 100,
    readinessPollMs: 10,
    queuePort: 0,
    caddyEnabled: false,
    caddyAdminPort: 2019,
    caddyStudioHost: null,
  }
}

function buildDeps(): { deps: WorkerDeps; paths: Paths; store: Store } {
  const home = mkdtempSync(join(tmpdir(), 'hobby-worker-guard-'))
  const paths = resolvePaths({ HOBBY_HOME: home })
  const store = openStore(':memory:')
  const deps: WorkerDeps = {
    store,
    runtime: null as never,
    paths,
    config: testConfig(),
    now: () => NOW,
  }
  return { deps, paths, store }
}

function makeWorker(store: Store, paths: Paths): WorkerResource {
  const project = store.createProject({ name: 'chat', sleepAfterSeconds: 300 })
  const resource = store.createResource({
    projectId: project.id,
    kind: 'worker',
    name: 'api',
    config: {
      image: 'hobby/api-worker:1',
      containerName: 'hobby-chat-api',
      hostPort: 35433,
      controlPort: 35434,
      queueToken: 'test-token',
      containerPort: 8787,
      hostname: 'api.chat.localhost',
      durableObjectUniqueKeyModifier: 'unused-here',
      databaseResourceId: null,
      manifest: {
        source: { path: '/code/api', manifest: 'wrangler.toml' },
        compatibilityDate: '2026-08-01',
        compatibilityFlags: [],
        vars: {},
        kvNamespaces: [],
        r2Buckets: [],
        d1Databases: [],
        queues: { producers: [], consumers: [] },
        durableObjects: [],
      },
    },
  })
  // paths.resourcePath needs the project directory to exist for some parts;
  // queueDbPath and namespaceDirs both create what they need themselves.
  mkdirSync(paths.resourcePath('chat', 'api', 'do'), { recursive: true })
  return resource as WorkerResource
}

// Writes a namespace directory with one object whose alarm is already due,
// the minimal shape durableObjectAlarmGuard's own nextAlarmAtMs reads.
// Mirrors packages/do/test/fixtures.ts's makeNamespace, which is test-only
// and not part of @hobby.sh/do's public surface, so it is not reusable
// directly from a sibling package's test.
function writeDueAlarm(doRoot: string, resource: WorkerResource, className: string, alarmAtMs: number): void {
  const namespaceDir = join(doRoot, uniqueKeyFor(resource.id, className))
  mkdirSync(namespaceDir, { recursive: true })
  const db = openDatabase(join(namespaceDir, 'metadata.sqlite'))
  try {
    db.exec(
      'CREATE TABLE IF NOT EXISTS _cf_ALARM (actor_id TEXT PRIMARY KEY, scheduled_time INTEGER, actor_name TEXT) WITHOUT ROWID;'
    )
    db.prepare(
      `INSERT INTO _cf_ALARM (actor_id, scheduled_time, actor_name) VALUES (?, ${alarmAtMs}000000, ?)`
    ).run('a'.repeat(64), null)
  } finally {
    db.close()
  }
}

// Creates a queue resource consumed by this worker, with one message under
// an active, unexpired lease, so queueDeliveryGuard reads 'active'.
function leaseAMessage(store: Store, paths: Paths, worker: WorkerResource): void {
  const project = store.getProject(worker.projectId)
  assert.ok(project !== null)
  store.createResource({
    projectId: worker.projectId,
    kind: 'queue',
    name: 'jobs',
    config: {
      image: '',
      containerName: '',
      hostPort: 0,
      retentionSeconds: 345_600,
      consumerResourceId: worker.id,
      maxBatchSize: 5,
      maxBatchTimeoutSeconds: 1,
      maxRetries: 2,
      retryDelaySeconds: 0,
      deadLetterQueue: null,
    },
  })
  const db = openQueueDb(queueDbPath(paths, project.name, 'jobs'))
  try {
    enqueue(db, [{ body: '{}', contentType: 'json' }], NOW)
    leaseBatch(db, DEFAULT_CONSUMER_OPTIONS, NOW)
  } finally {
    db.close()
  }
}

test('a worker with no durable objects and no queue consumers is idle', async () => {
  const { deps, paths, store } = buildDeps()
  try {
    const worker = makeWorker(store, paths)
    assert.equal(await workerKindHandler.guard?.(deps, worker), 'idle')
  } finally {
    store.close()
  }
})

test('an unexpired queue lease makes the composed guard active, with no alarm involved', async () => {
  const { deps, paths, store } = buildDeps()
  try {
    const worker = makeWorker(store, paths)
    leaseAMessage(store, paths, worker)
    assert.equal(await workerKindHandler.guard?.(deps, worker), 'active')
  } finally {
    store.close()
  }
})

test('a due durable object alarm makes the composed guard active, with no queue involved', async () => {
  const { deps, paths, store } = buildDeps()
  try {
    const worker = makeWorker(store, paths)
    writeDueAlarm(paths.resourcePath('chat', 'api', 'do'), worker, 'Room', NOW)
    assert.equal(await workerKindHandler.guard?.(deps, worker), 'active')
  } finally {
    store.close()
  }
})

// The direction that is easiest to get backwards: 'unreachable' must win
// over an 'active' the other half reports, never be downgraded by it, and
// never be read as 'idle'.
test('unreachable beats active: a guard that could not fully answer is never read as permission to sleep', async () => {
  const { deps, paths, store } = buildDeps()
  try {
    const worker = makeWorker(store, paths)
    leaseAMessage(store, paths, worker) // queue half: active
    // Alarm half: unreachable. A metadata.sqlite with the wrong schema is
    // what assertAlarmSchema (packages/do/src/alarms.ts) throws on, which
    // durableObjectAlarmGuard turns into 'unreachable'.
    const namespaceDir = join(paths.resourcePath('chat', 'api', 'do'), uniqueKeyFor(worker.id, 'Room'))
    mkdirSync(namespaceDir, { recursive: true })
    const db = openDatabase(join(namespaceDir, 'metadata.sqlite'))
    db.exec('CREATE TABLE wrong (id TEXT PRIMARY KEY)')
    db.close()

    assert.equal(await workerKindHandler.guard?.(deps, worker), 'unreachable')
  } finally {
    store.close()
  }
})
