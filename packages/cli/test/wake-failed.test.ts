// Issue #10 end to end, daemon side: the real wake-on-connect proxy
// (startPgProxy), the real ProxyDeps the daemon hands it (createProxyDeps),
// the real startPostgres behind the postgres kind handler, the real
// reconcile and the real daemon API. The only fakes are the ones every
// daemon test uses: an in-memory store and a fake runtime, here one whose
// container start or stop can be made to fail on demand. No Docker.
//
// What this pins down: a resource whose wake fails is started a bounded
// number of times no matter how many clients connect, every one of those
// clients gets a real ErrorResponse, well inside the 3 second ceiling, and
// `hobby wake` (POST /v1/resources/:id/start) or a daemon restart is the way
// back. And, just as important, what it must not do: refuse a resource only
// because the store labels it `failed`, which reconcile does for every
// container an unclean reboot left stopped.

import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import net from 'node:net'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  createFakeRuntime,
  openStore,
  resolvePaths,
  type ComputeRuntime,
  type HobbyConfig,
  type PostgresConfig,
} from '@hobby.sh/core'
import { ActivityTracker, buildStartupPacket, startPgProxy } from '@hobby.sh/proxy'
import { createDefaultKindRegistry, isWakeRefused } from '../src/daemon/context.js'
import { createApp, createProxyDeps, reconcile, type DaemonContext } from '../src/index.js'

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
    wakeTimeoutMs: 2000,
    readinessPollMs: 20,
    queuePort: 0,
    caddyEnabled: false,
    caddyAdminPort: 2019,
    caddyStudioHost: null,
    project: null,
  }
}

function samplePostgresConfig(): PostgresConfig {
  return {
    image: 'postgres:18-alpine',
    containerName: `hobby-blog-primary-${randomUUID()}`,
    dataDir: '/home/user/.hobby/projects/blog/primary/pgdata',
    hostPort: 25559,
    superuser: 'postgres',
    password: 'secret',
    database: 'blog',
  }
}

// A runtime whose container start throws while `broken` is set, and whose
// stop throws while `stopBroken` is set, counting every start it is asked
// for, which is the number the issue is about.
function breakableRuntime(): {
  runtime: ComputeRuntime
  startCalls: () => number
  fix: () => void
  breakStop: () => void
} {
  const base = createFakeRuntime()
  let calls = 0
  let broken = true
  let stopBroken = false
  const runtime: ComputeRuntime = {
    ...base,
    async start(name: string): Promise<void> {
      calls++
      if (broken) {
        throw new Error('container exited immediately: exec format error')
      }
      await base.start(name)
    },
    async stop(name: string, opts: { timeoutSec: number }): Promise<void> {
      if (stopBroken) {
        throw new Error('docker stop timed out')
      }
      await base.stop(name, opts)
    },
  }
  return {
    runtime,
    startCalls: () => calls,
    fix: () => (broken = false),
    breakStop: () => (stopBroken = true),
  }
}

function buildContext(runtime: ComputeRuntime, store = openStore(':memory:')): DaemonContext {
  return {
    store,
    runtime,
    paths: resolvePaths({ HOBBY_HOME: join(tmpdir(), `hobby-wake-failed-test-${randomUUID()}`) }),
    config: testConfig(),
    activity: new ActivityTracker(),
    kinds: createDefaultKindRegistry(),
    probeFactory: () => async () => true,
  }
}

// A stand-in for the Postgres inside the container once it is up: answers
// any startup packet with AuthenticationOk, BackendKeyData, ReadyForQuery.
async function startServingUpstream(): Promise<{ port: number; close: () => Promise<void> }> {
  const sockets: net.Socket[] = []
  const server = net.createServer((socket) => {
    sockets.push(socket)
    socket.on('error', () => {})
    socket.once('data', () => {
      const auth = Buffer.alloc(9)
      auth.write('R', 0, 'ascii')
      auth.writeInt32BE(8, 1)
      auth.writeInt32BE(0, 5)
      const key = Buffer.alloc(13)
      key.write('K', 0, 'ascii')
      key.writeInt32BE(12, 1)
      key.writeInt32BE(1, 5)
      key.writeInt32BE(2, 9)
      const ready = Buffer.from([0x5a, 0, 0, 0, 5, 0x49])
      socket.write(Buffer.concat([auth, key, ready]))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  return {
    port: (server.address() as AddressInfo).port,
    close: () => {
      for (const socket of sockets) socket.destroy()
      return new Promise((resolve) => server.close(() => resolve()))
    },
  }
}

// Connects, sends a startup packet, and resolves with the first `count`
// bytes the proxy sent back.
function connectAndReadBytes(port: number, database: string, count: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: '127.0.0.1', port })
    let buffer = Buffer.alloc(0)
    socket.once('connect', () => socket.write(buildStartupPacket({ user: 'postgres', database })))
    socket.on('data', (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk])
      if (buffer.length >= count) {
        socket.destroy()
        resolve(buffer)
      }
    })
    socket.on('close', () => resolve(buffer))
    socket.on('error', reject)
  })
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

function extractField(buf: Buffer, field: string): string | null {
  const index = buf.indexOf(Buffer.from(`\0${field}`, 'ascii'))
  if (index === -1) return null
  const end = buf.indexOf(0, index + 2)
  if (end === -1) return null
  return buf.toString('utf8', index + 2, end)
}

// Connects, sends a startup packet for `database`, and resolves with every
// byte the proxy sent before closing.
function connectAndRead(port: number, database: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: '127.0.0.1', port })
    const chunks: Buffer[] = []
    socket.once('connect', () => socket.write(buildStartupPacket({ user: 'postgres', database })))
    socket.on('data', (chunk: Buffer) => chunks.push(chunk))
    socket.on('close', () => resolve(Buffer.concat(chunks)))
    socket.on('error', reject)
  })
}

test('issue #10: a resource whose start always fails is started a bounded number of times, however many clients connect', async () => {
  const { runtime, startCalls } = breakableRuntime()
  const ctx = buildContext(runtime)
  const project = ctx.store.createProject({ name: 'blog', sleepAfterSeconds: 300 })
  const resource = ctx.store.createResource({ projectId: project.id, kind: 'postgres', name: 'primary', config: samplePostgresConfig() })
  ctx.store.setResourceState(resource.id, 'sleeping')

  const proxy = await startPgProxy({ port: 0, deps: createProxyDeps(ctx), wakeTimeoutMs: ctx.config.wakeTimeoutMs })
  try {
    // Two at once: the first burst, which is where de-duplication and the
    // failure itself happen.
    const started = Date.now()
    const burst = await Promise.all([connectAndRead(proxy.port, 'blog'), connectAndRead(proxy.port, 'blog')])
    const burstMs = Date.now() - started
    assert.ok(burstMs < 3000, `the first burst took ${burstMs}ms, past the 3 second ceiling`)
    for (const response of burst) {
      assert.equal(response[0], 0x45, 'a real ErrorResponse, not a dropped socket')
      assert.equal(extractField(response, 'C'), '57P03')
    }
    // The client whose wake ran the failing start is told what failed. A
    // client that reached the front door after the wake had already failed
    // is refused there, and told how to retry: the reason itself is not
    // stored anywhere the proxy could read, which is why that message points
    // at `hobby logs` instead.
    const messages = burst.map((response) => extractField(response, 'M') ?? '')
    assert.ok(
      messages.some((message) => /exec format error/.test(message)),
      `no client was told the actual failure: ${JSON.stringify(messages)}`
    )
    assert.equal(ctx.store.getResource(resource.id)?.state, 'failed')
    assert.equal(isWakeRefused(ctx, resource.id), true)
    assert.equal(startCalls(), 1)

    // Then the retrying ORM or the uptime check: connection after
    // connection. Before the fix every one of these was another container
    // start.
    for (let i = 0; i < 5; i++) {
      const before = Date.now()
      const response = await connectAndRead(proxy.port, 'blog')
      assert.ok(Date.now() - before < 1000, 'a failed resource is answered immediately, not after a wake')
      assert.equal(response[0], 0x45)
      assert.match(extractField(response, 'M') ?? '', /hobby wake/)
    }
    assert.equal(startCalls(), 1, 'six more connections, zero more container starts')
  } finally {
    await proxy.close()
    ctx.store.close()
  }
})

test('issue #10: an explicit start through the daemon API clears the refusal, and the next implicit wake proceeds', async () => {
  const { runtime, startCalls, fix } = breakableRuntime()
  const ctx = buildContext(runtime)
  const project = ctx.store.createProject({ name: 'blog', sleepAfterSeconds: 300 })
  const resource = ctx.store.createResource({ projectId: project.id, kind: 'postgres', name: 'primary', config: samplePostgresConfig() })
  await runtime.ensureCreated({ name: resource.config.containerName, image: 'postgres:18-alpine', env: {}, ports: [], binds: [] })
  ctx.store.setResourceState(resource.id, 'sleeping')

  const deps = createProxyDeps(ctx)
  await assert.rejects(deps.wake(resource.id))
  assert.equal(deps.isWakeRefused?.(resource.id), true)
  await assert.rejects(deps.wake(resource.id))
  assert.equal(startCalls(), 1, 'the implicit wake is refused once a wake has failed')

  // Someone looked and fixed it. `hobby wake`, the MCP wake tool and
  // Studio's start button all land on this route.
  fix()
  await withApi(ctx, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/v1/resources/${resource.id}/start`, { method: 'POST' })
    assert.equal(res.status, 200)
    const body = (await res.json()) as { resource: { state: string } }
    assert.equal(body.resource.state, 'running')
  })
  assert.equal(startCalls(), 2, 'the explicit start is not refused')
  assert.equal(deps.isWakeRefused?.(resource.id), false, 'the explicit start cleared the refusal')

  // And the resource is back on the ordinary sleep and wake cycle: once it
  // sleeps again, a connection wakes it as it always did.
  ctx.store.setResourceState(resource.id, 'sleeping')
  await deps.wake(resource.id)
  assert.equal(startCalls(), 3)
  assert.equal(ctx.store.getResource(resource.id)?.state, 'running')
  ctx.store.close()
})

// The regression that matters most. An unclean host reboot leaves every
// container that was running stopped, and reconcile's correctedState labels
// each of those `failed`. Postgres runs crash recovery on start and they are
// perfectly wakeable, so the first connection must wake one exactly as it
// did before issue #10, not be refused because of the label.
test('issue #10: a resource reconcile labelled failed after an unclean reboot still wakes on the first proxy connection', async () => {
  const { runtime, startCalls, fix } = breakableRuntime()
  fix()
  const upstream = await startServingUpstream()
  const ctx = buildContext(runtime)
  const project = ctx.store.createProject({ name: 'blog', sleepAfterSeconds: 300 })
  const resource = ctx.store.createResource({
    projectId: project.id,
    kind: 'postgres',
    name: 'primary',
    config: { ...samplePostgresConfig(), hostPort: upstream.port },
  })
  // Recorded running, container present but stopped: the reboot shape.
  await runtime.ensureCreated({ name: resource.config.containerName, image: 'postgres:18-alpine', env: {}, ports: [], binds: [] })
  ctx.store.setResourceState(resource.id, 'running')
  await reconcile(ctx)
  assert.equal(ctx.store.getResource(resource.id)?.state, 'failed', 'reconcile labels it failed')
  assert.equal(isWakeRefused(ctx, resource.id), false, 'but nothing has refused it')

  const proxy = await startPgProxy({ port: 0, deps: createProxyDeps(ctx), wakeTimeoutMs: ctx.config.wakeTimeoutMs })
  try {
    const handshake = await connectAndReadBytes(proxy.port, 'blog', 9 + 13 + 6)
    assert.equal(handshake[0], 0x52, `expected AuthenticationOk, got ${JSON.stringify(handshake.toString('latin1'))}`)
    assert.equal(startCalls(), 1, 'the first connection woke it')
    assert.equal(ctx.store.getResource(resource.id)?.state, 'running')
  } finally {
    await proxy.close()
    await upstream.close()
    ctx.store.close()
  }
})

// A daemon restart is a fresh DaemonContext over the same store. The refusal
// lives in memory, so it does not survive: the resource is still labelled
// `failed`, and it gets exactly one new attempt.
test('issue #10: a daemon restart starts with no refusals, allowing one new attempt', async () => {
  const { runtime, startCalls } = breakableRuntime()
  const store = openStore(':memory:')
  const before = buildContext(runtime, store)
  const project = store.createProject({ name: 'blog', sleepAfterSeconds: 300 })
  const resource = store.createResource({ projectId: project.id, kind: 'postgres', name: 'primary', config: samplePostgresConfig() })
  store.setResourceState(resource.id, 'sleeping')

  await assert.rejects(createProxyDeps(before).wake(resource.id))
  await assert.rejects(createProxyDeps(before).wake(resource.id))
  assert.equal(startCalls(), 1)

  const after = buildContext(runtime, store)
  assert.equal(isWakeRefused(after, resource.id), false)
  assert.equal(store.getResource(resource.id)?.state, 'failed')
  await assert.rejects(createProxyDeps(after).wake(resource.id))
  assert.equal(startCalls(), 2, 'one fresh attempt after the restart')
  await assert.rejects(createProxyDeps(after).wake(resource.id))
  assert.equal(startCalls(), 2, 'and then refused again')
  store.close()
})

// `failed` written by anything other than a wake says nothing about whether
// the next start works. A failed stop is the case the daemon API can drive
// here; a failed app or worker deploy writes `failed` from deployApp /
// deployWorker, which never pass through buildWake either, and a row set
// straight to `failed` stands in for it.
test('issue #10: a failed stop, or failed written outside a wake, does not refuse the next wake', async () => {
  const { runtime, startCalls, fix, breakStop } = breakableRuntime()
  fix()
  const ctx = buildContext(runtime)
  const project = ctx.store.createProject({ name: 'blog', sleepAfterSeconds: 300 })
  const stopped = ctx.store.createResource({ projectId: project.id, kind: 'postgres', name: 'primary', config: samplePostgresConfig() })
  await runtime.ensureCreated({ name: stopped.config.containerName, image: 'postgres:18-alpine', env: {}, ports: [], binds: [] })
  ctx.store.setResourceState(stopped.id, 'running')

  breakStop()
  await withApi(ctx, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/v1/resources/${stopped.id}/stop`, { method: 'POST' })
    assert.notEqual(res.status, 200)
  })
  assert.equal(ctx.store.getResource(stopped.id)?.state, 'failed')
  assert.equal(isWakeRefused(ctx, stopped.id), false, 'a failed stop is not a failed wake')

  const deps = createProxyDeps(ctx)
  await deps.wake(stopped.id)
  assert.equal(startCalls(), 1)
  assert.equal(ctx.store.getResource(stopped.id)?.state, 'running')

  const labelled = ctx.store.createResource({ projectId: project.id, kind: 'postgres', name: 'other', config: samplePostgresConfig() })
  await runtime.ensureCreated({ name: labelled.config.containerName, image: 'postgres:18-alpine', env: {}, ports: [], binds: [] })
  ctx.store.setResourceState(labelled.id, 'failed')
  assert.equal(isWakeRefused(ctx, labelled.id), false)
  await deps.wake(labelled.id)
  assert.equal(startCalls(), 2)
  assert.equal(ctx.store.getResource(labelled.id)?.state, 'running')
  ctx.store.close()
})
