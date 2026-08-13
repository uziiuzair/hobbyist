// The daemon-side half of a container's env.MY_QUEUE.send(): what a
// container reaches when it POSTs to the enqueue listener. Fixture shapes
// (testConfig, sampleWorkerConfig, sampleQueueConfig) are copied from
// queue-kind.test.ts rather than imported, for the same reason that file
// gives for its own copies: this file must not depend on, or edit, one a
// concurrent session might be touching, and a fixture copy is cheap while a
// shared import is a standing coupling.

import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  createFakeRuntime,
  openStore,
  resolvePaths,
  type ComputeRuntime,
  type HobbyConfig,
  type QueueConfig,
  type Store,
  type WorkerConfig,
} from '@hobby.sh/core'
import { depth, openQueueDb, queueDbPath } from '@hobby.sh/queue'
import { ActivityTracker } from '@hobby.sh/proxy'
import { createDefaultKindRegistry, type DaemonContext } from '../src/daemon/context.js'
import { startQueueEndpoint, type QueueEndpointHandle } from '../src/daemon/queue-endpoint.js'

function testConfig(overrides: Partial<HobbyConfig> = {}): HobbyConfig {
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
    ...overrides,
  }
}

function buildContext(runtime: ComputeRuntime = createFakeRuntime()): DaemonContext {
  const store: Store = openStore(':memory:')
  const paths = resolvePaths({ HOBBY_HOME: join(tmpdir(), `hobby-queue-endpoint-test-${randomUUID()}`) })
  return { store, runtime, paths, config: testConfig(), activity: new ActivityTracker(), kinds: createDefaultKindRegistry() }
}

function sampleQueueConfig(overrides: Partial<QueueConfig> = {}): QueueConfig {
  return {
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

function sampleWorkerConfig(overrides: Partial<WorkerConfig> = {}): WorkerConfig {
  return {
    image: 'hobby/workerd:1',
    containerName: `hobby-worker-${randomUUID()}`,
    hostPort: 15602,
    controlPort: 15603,
    queueToken: randomUUID(),
    containerPort: 8787,
    hostname: 'api.blog.localhost',
    source: { path: '/src/api', manifest: 'wrangler.toml' },
    compatibilityDate: '2026-08-01',
    compatibilityFlags: [],
    vars: {},
    kvNamespaces: [],
    r2Buckets: [],
    d1Databases: [],
    queues: { producers: [{ queue: 'events', binding: 'EVENTS' }], consumers: [] },
    durableObjects: [],
    durableObjectUniqueKeyModifier: 'stable-modifier',
    databaseResourceId: null,
    ...overrides,
  }
}

// Two projects, each with its own queue, and one worker resource in the
// first project whose token authenticates every request in these tests.
// "other" exists purely so the cross-project isolation test has a queue
// that genuinely exists somewhere, just never in the caller's own project.
function buildFixture(): {
  ctx: DaemonContext
  workerToken: string
  workerResourceId: string
  blogProjectName: string
  otherProjectName: string
} {
  const ctx = buildContext()
  const blog = ctx.store.createProject({ name: 'blog', sleepAfterSeconds: null })
  const other = ctx.store.createProject({ name: 'other', sleepAfterSeconds: null })

  const workerToken = randomUUID()
  const worker = ctx.store.createResource({
    projectId: blog.id,
    kind: 'worker',
    name: 'api',
    config: sampleWorkerConfig({ queueToken: workerToken }),
  })

  ctx.store.createResource({
    projectId: blog.id,
    kind: 'queue',
    name: 'events',
    config: sampleQueueConfig(),
  })
  ctx.store.createResource({
    projectId: other.id,
    kind: 'queue',
    name: 'jobs',
    config: sampleQueueConfig(),
  })

  return { ctx, workerToken, workerResourceId: worker.id, blogProjectName: blog.name, otherProjectName: other.name }
}

async function withEndpoint(
  fixture: ReturnType<typeof buildFixture>,
  run: (base: string, handle: QueueEndpointHandle) => Promise<void>
): Promise<void> {
  const tokenIndex = new Map([[fixture.workerToken, fixture.workerResourceId]])
  const handle = await startQueueEndpoint(fixture.ctx, {
    port: 0,
    hosts: ['127.0.0.1'],
    tokenFor: (token) => tokenIndex.get(token) ?? null,
  })
  try {
    await run(`http://127.0.0.1:${handle.port}`, handle)
  } finally {
    await handle.stop()
    fixture.ctx.store.close()
  }
}

function eventsDepth(fixture: ReturnType<typeof buildFixture>): number {
  const db = openQueueDb(queueDbPath(fixture.ctx.paths, fixture.blogProjectName, 'events'))
  try {
    return depth(db)
  } finally {
    db.close()
  }
}

function jobsDepth(fixture: ReturnType<typeof buildFixture>): number {
  const db = openQueueDb(queueDbPath(fixture.ctx.paths, fixture.otherProjectName, 'jobs'))
  try {
    return depth(db)
  } finally {
    db.close()
  }
}

test('no authorization header returns 401, and nothing is enqueued', async () => {
  const fixture = buildFixture()
  await withEndpoint(fixture, async (base) => {
    const res = await fetch(`${base}/enqueue`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ queue: 'events', messages: [{ body: 'hi', contentType: 'text' }] }),
    })
    assert.equal(res.status, 401)
    assert.equal(eventsDepth(fixture), 0)
  })
})

test('a wrong token returns 401, and nothing is enqueued', async () => {
  const fixture = buildFixture()
  await withEndpoint(fixture, async (base) => {
    const res = await fetch(`${base}/enqueue`, {
      method: 'POST',
      headers: { authorization: 'Bearer not-the-real-token', 'content-type': 'application/json' },
      body: JSON.stringify({ queue: 'events', messages: [{ body: 'hi', contentType: 'text' }] }),
    })
    assert.equal(res.status, 401)
    assert.equal(eventsDepth(fixture), 0)
  })
})

test('a valid token naming a queue that does not exist in that resource project returns 404', async () => {
  const fixture = buildFixture()
  await withEndpoint(fixture, async (base) => {
    const res = await fetch(`${base}/enqueue`, {
      method: 'POST',
      headers: { authorization: `Bearer ${fixture.workerToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ queue: 'does-not-exist', messages: [{ body: 'hi', contentType: 'text' }] }),
    })
    assert.equal(res.status, 404)
  })
})

// The most important test in the file: a worker's token must never let it
// enqueue into a queue that happens to live in a different project, even
// when it names that queue correctly. ctx.store.getResourceByName is scoped
// to the authenticated resource's OWN project, which is what this pins.
test('a valid token naming a queue in a different project returns 404 and does not enqueue', async () => {
  const fixture = buildFixture()
  await withEndpoint(fixture, async (base) => {
    const res = await fetch(`${base}/enqueue`, {
      method: 'POST',
      headers: { authorization: `Bearer ${fixture.workerToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ queue: 'jobs', messages: [{ body: 'hi', contentType: 'text' }] }),
    })
    assert.equal(res.status, 404)
    assert.equal(jobsDepth(fixture), 0)
  })
})

test('a valid request returns 200, ids match the message count, and depth rises', async () => {
  const fixture = buildFixture()
  await withEndpoint(fixture, async (base) => {
    assert.equal(eventsDepth(fixture), 0)
    const res = await fetch(`${base}/enqueue`, {
      method: 'POST',
      headers: { authorization: `Bearer ${fixture.workerToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        queue: 'events',
        messages: [
          { body: 'one', contentType: 'text' },
          { body: 'two', contentType: 'text' },
          { body: JSON.stringify({ n: 3 }), contentType: 'json', delaySeconds: 5 },
        ],
      }),
    })
    assert.equal(res.status, 200)
    const parsed = (await res.json()) as { ids: string[] }
    assert.equal(parsed.ids.length, 3)
    assert.equal(new Set(parsed.ids).size, 3, 'ids must be distinct')
    assert.equal(eventsDepth(fixture), 3)
  })
})

test('a message body over 128000 bytes returns 400 and the depth does not move', async () => {
  const fixture = buildFixture()
  await withEndpoint(fixture, async (base) => {
    const oversized = 'x'.repeat(128001)
    const res = await fetch(`${base}/enqueue`, {
      method: 'POST',
      headers: { authorization: `Bearer ${fixture.workerToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ queue: 'events', messages: [{ body: oversized, contentType: 'text' }] }),
    })
    assert.equal(res.status, 400)
    assert.equal(eventsDepth(fixture), 0)
  })
})

test('any method other than POST, or any path other than /enqueue, returns 404', async () => {
  const fixture = buildFixture()
  await withEndpoint(fixture, async (base) => {
    const authHeaders = { authorization: `Bearer ${fixture.workerToken}` }

    const getEnqueue = await fetch(`${base}/enqueue`, { method: 'GET', headers: authHeaders })
    assert.equal(getEnqueue.status, 404)

    const putEnqueue = await fetch(`${base}/enqueue`, { method: 'PUT', headers: authHeaders })
    assert.equal(putEnqueue.status, 404)

    const wrongPath = await fetch(`${base}/v1/resources`, { method: 'POST', headers: authHeaders })
    assert.equal(wrongPath.status, 404)

    const root = await fetch(`${base}/`, { method: 'POST', headers: authHeaders })
    assert.equal(root.status, 404)
  })
})

test('the token never appears in any response body', async () => {
  const fixture = buildFixture()
  await withEndpoint(fixture, async (base) => {
    const responses = await Promise.all([
      fetch(`${base}/enqueue`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ queue: 'events', messages: [] }),
      }),
      fetch(`${base}/enqueue`, {
        method: 'POST',
        headers: { authorization: 'Bearer wrong-token', 'content-type': 'application/json' },
        body: JSON.stringify({ queue: 'events', messages: [] }),
      }),
      fetch(`${base}/enqueue`, {
        method: 'POST',
        headers: { authorization: `Bearer ${fixture.workerToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({ queue: 'events', messages: [{ body: 'hi', contentType: 'text' }] }),
      }),
      fetch(`${base}/nope`, { method: 'POST' }),
    ])

    for (const res of responses) {
      const text = await res.text()
      assert.equal(text.includes(fixture.workerToken), false, `response leaked the token: ${text}`)
    }
  })
})

// Not one of the eight required cases, but the reason opts.hosts exists at
// all: docs/decisions/0013 accepted a second bind on Linux specifically
// because a container cannot reach a loopback-only listener there. A real
// multi-address bind (127.0.0.1 plus a second 127.0.0.0/8 alias, which needs
// no Docker and no Linux-specific bridge networking to exercise) was tried
// here and rejected by this sandbox's own network namespace with
// EADDRNOTAVAIL: binding anything other than 127.0.0.1 is not available in
// this execution environment, which is itself worth recording rather than
// silently working around. What IS verified: opts.hosts accepting more than
// one entry runs the same multi-bind loop regardless of whether every
// address turns out to be bindable, and a bind failure after the first
// server is already listening does not leak that socket (see
// startQueueEndpoint's own try/catch, added after this test caught it
// hanging the whole suite). See the task report for the rollback fix and
// this limitation, matching the same "not verified on real hardware"
// honesty the research doc already carries for the Linux gateway bind
// itself.
test('a bind failure for a later host closes every socket already opened, and does not hang', async () => {
  const fixture = buildFixture()
  const tokenIndex = new Map([[fixture.workerToken, fixture.workerResourceId]])

  await assert.rejects(
    startQueueEndpoint(fixture.ctx, {
      port: 0,
      // 127.0.0.2 is unbindable in this sandbox (verified: node's http
      // server reports EADDRNOTAVAIL), which is exactly the "a later host
      // fails" case the rollback in startQueueEndpoint exists for. The
      // first bind to 127.0.0.1 must succeed and then be closed again
      // rather than left dangling.
      hosts: ['127.0.0.1', '127.0.0.2'],
      tokenFor: (token) => tokenIndex.get(token) ?? null,
    })
  )

  fixture.ctx.store.close()
})
