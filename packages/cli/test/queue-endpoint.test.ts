// The daemon-side half of a container's env.MY_QUEUE.send(): what a
// container reaches when it POSTs to the enqueue listener. Fixture shapes
// (testConfig, sampleWorkerConfig, sampleQueueConfig) are copied from
// queue-kind.test.ts rather than imported, for the same reason that file
// gives for its own copies: this file must not depend on, or edit, one a
// concurrent session might be touching, and a fixture copy is cheap while a
// shared import is a standing coupling.

import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import http from 'node:http'
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
    caddyEnabled: false,
    caddyAdminPort: 2019,
    caddyStudioHost: null,
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
    durableObjectUniqueKeyModifier: 'stable-modifier',
    databaseResourceId: null,
    manifest: {
      source: { path: '/src/api', manifest: 'wrangler.toml' },
      compatibilityDate: '2026-08-01',
      compatibilityFlags: [],
      vars: {},
      kvNamespaces: [],
      r2Buckets: [],
      d1Databases: [],
      queues: { producers: [{ queue: 'events', binding: 'EVENTS' }], consumers: [] },
      durableObjects: [],
    },
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
// because a container cannot reach a loopback-only listener there.
//
// An earlier version of this test forced the failure by asking for
// '127.0.0.2' as a second host and relying on it being unbindable. That is
// macOS sandbox behaviour, not a property of the code: on Linux, 127.0.0.2
// binds by default, because the whole of 127.0.0.0/8 is local without an
// alias. On such a platform the old test would have seen startQueueEndpoint
// RESOLVE instead of reject, `assert.rejects` would fail with "missing
// expected rejection", and the two listeners it had just opened would leak,
// because nothing closed them, which is exactly the hang this test exists to
// catch. The test that guarded the bug had become the bug.
//
// Fixed by making the collision deterministic instead of address-dependent:
// startQueueEndpoint binds every host in opts.hosts to the SAME resolved
// port (see its own header comment on the multi-bind loop), so naming
// '127.0.0.1' twice makes the second bind collide with the first server's
// own listener. EADDRINUSE is produced by every platform for that, not a
// sandbox-specific refusal, and no second real address is needed at all.
test('a bind failure for a later host closes every socket already opened, and does not hang', async () => {
  const fixture = buildFixture()
  const tokenIndex = new Map([[fixture.workerToken, fixture.workerResourceId]])

  // An explicit, pre-discovered port rather than 0: the collision needs both
  // bind attempts to target the exact same host:port, and only an explicit
  // port lets this test also verify afterward that IT is free again, which
  // a port chosen internally by startQueueEndpoint would leave unobservable
  // from out here.
  const probe = http.createServer()
  await new Promise<void>((resolve, reject) => {
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => resolve())
  })
  const address = probe.address()
  const port = typeof address === 'object' && address !== null ? address.port : null
  await new Promise<void>((resolve) => probe.close(() => resolve()))
  assert.notEqual(port, null, 'the probe server must report a real port before this test can use it')

  // Guards against a regression closing this test's own gap: if
  // startQueueEndpoint ever stopped rejecting here (the collision no longer
  // firing, say), the handle it returned must still be closed rather than
  // leaked on top of the assertion below failing.
  let leaked: QueueEndpointHandle | null = null
  try {
    await assert.rejects(
      (async () => {
        leaked = await startQueueEndpoint(fixture.ctx, {
          port: port as number,
          hosts: ['127.0.0.1', '127.0.0.1'],
          tokenFor: (token) => tokenIndex.get(token) ?? null,
        })
      })(),
      (err: unknown) => err instanceof Error && (err as NodeJS.ErrnoException).code === 'EADDRINUSE'
    )
  } finally {
    if (leaked !== null) {
      await (leaked as QueueEndpointHandle).stop()
    }
  }

  // Rejecting is only half the contract: the other half is that the first
  // server, which DID bind successfully before the second collided with it,
  // was actually closed by the rollback rather than left listening. Binding
  // the identical host:port again here succeeds only if that is true; if the
  // rollback ever regressed into leaking that first socket, this bind would
  // itself fail with EADDRINUSE and fail the test.
  const verify = http.createServer()
  await new Promise<void>((resolve, reject) => {
    verify.once('error', reject)
    verify.listen(port as number, '127.0.0.1', () => resolve())
  })
  await new Promise<void>((resolve) => verify.close(() => resolve()))

  fixture.ctx.store.close()
})
