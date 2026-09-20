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
// back. Since the refusal became a backoff, also that the backoff runs out
// by itself: after 30 seconds, doubling to 15 minutes, the next wake is let
// through for exactly one attempt, and a success resets it. Every one of
// those tests moves an injected clock (DaemonContext.wakeClock) instead of
// sleeping. And, just as important, what it must not do: refuse a resource
// only because the store labels it `failed`, which reconcile does for every
// container an unclean reboot left stopped.

import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import net from 'node:net'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, rmSync } from 'node:fs'
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
import { createDefaultKindRegistry, getWakeRefusal, holdProjectAsleep, isWakeRefused } from '../src/daemon/context.js'
import { createApp, createProxyDeps, reconcile, type DaemonContext } from '../src/index.js'
import { run, type Io } from '../src/cli/main.js'

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
  breakAgain: () => void
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
    breakAgain: () => (broken = true),
  }
}

// A clock the test moves by hand. Starts well away from zero so that no
// arithmetic can accidentally pass by treating 0 as "no time at all".
function fakeClock(): { now: () => number; advance: (ms: number) => void; set: (ms: number) => void } {
  let current = 1_800_000_000_000
  return {
    now: () => current,
    advance: (ms: number) => (current += ms),
    set: (ms: number) => (current = ms),
  }
}

function buildContext(runtime: ComputeRuntime, store = openStore(':memory:'), clock?: () => number): DaemonContext {
  return {
    wakeClock: clock,
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
  const clock = fakeClock()
  const ctx = buildContext(runtime, openStore(':memory:'), clock.now)
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
    // is refused there, and told how to retry: the proxy's isWakeRefused
    // answers a boolean and carries neither the reason nor the retry time,
    // which is why that message points at `hobby logs` and `hobby ls`
    // instead.
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
      assert.match(extractField(response, 'M') ?? '', /retries it by itself/)
      clock.advance(5_000)
    }
    assert.equal(startCalls(), 1, 'five more connections inside the window, zero more container starts')

    // The window runs out (30 seconds after the failure, and 25 of them have
    // passed above). The same shape again, two at once and then five in a
    // row, costs exactly one more start: the pair share the one retry
    // attempt, it fails, and the five after it are inside the next window,
    // now a minute long.
    clock.advance(5_000)
    const retryBurst = await Promise.all([connectAndRead(proxy.port, 'blog'), connectAndRead(proxy.port, 'blog')])
    for (const response of retryBurst) {
      assert.equal(response[0], 0x45)
    }
    assert.equal(startCalls(), 2, 'two concurrent clients at the retry time cost one start between them')
    assert.equal(getWakeRefusal(ctx, resource.id)?.failures, 2)
    for (let i = 0; i < 5; i++) {
      const response = await connectAndRead(proxy.port, 'blog')
      assert.equal(response[0], 0x45)
      clock.advance(10_000)
    }
    assert.equal(startCalls(), 2, 'and the five after it, inside the new one minute window, cost none')
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

// The schedule itself, driven through the real wake path: after the Nth
// failure in a row the next automatic attempt is 30s * 2^(N-1) later, capped
// at 15 minutes. Each step moves the clock to exactly retryAt, which must be
// let through (the boundary is "retry time has come", not "has passed by a
// millisecond"), and one millisecond before it, which must not.
test('issue #10 backoff: the retry delay is 30s, 1m, 2m, 4m, 8m, then capped at 15m', async () => {
  const { runtime, startCalls } = breakableRuntime()
  const clock = fakeClock()
  const ctx = buildContext(runtime, openStore(':memory:'), clock.now)
  const project = ctx.store.createProject({ name: 'blog', sleepAfterSeconds: 300 })
  const resource = ctx.store.createResource({ projectId: project.id, kind: 'postgres', name: 'primary', config: samplePostgresConfig() })
  ctx.store.setResourceState(resource.id, 'sleeping')
  const deps = createProxyDeps(ctx)

  const expected = [30_000, 60_000, 120_000, 240_000, 480_000, 900_000, 900_000, 900_000]
  for (const [index, delay] of expected.entries()) {
    const failedAt = clock.now()
    await assert.rejects(deps.wake(resource.id))
    assert.equal(startCalls(), index + 1)
    const refusal = getWakeRefusal(ctx, resource.id)
    assert.equal(refusal?.failures, index + 1)
    assert.equal(refusal?.retryAt, failedAt + delay, `failure ${index + 1} should rest ${delay}ms`)

    clock.set(failedAt + delay - 1)
    assert.equal(isWakeRefused(ctx, resource.id), true, 'one millisecond early is still refused')
    await assert.rejects(deps.wake(resource.id), /not woken automatically for another 1s/)
    assert.equal(startCalls(), index + 1, 'a refused wake does not start the container')

    clock.set(failedAt + delay)
    assert.equal(isWakeRefused(ctx, resource.id), false, 'at retryAt the next wake is let through')
  }
  ctx.store.close()
})

// At the retry time the front door stops refusing, so every client arriving
// then calls wake. They must still cost one start: buildWake's in-flight map
// hands every one of them the single attempt. This is the crowd that has
// been waiting the whole window, so it is the likeliest case there is.
test('issue #10 backoff: many concurrent wakes at the retry time share one attempt', async () => {
  const { runtime, startCalls } = breakableRuntime()
  const clock = fakeClock()
  const ctx = buildContext(runtime, openStore(':memory:'), clock.now)
  const project = ctx.store.createProject({ name: 'blog', sleepAfterSeconds: 300 })
  const resource = ctx.store.createResource({ projectId: project.id, kind: 'postgres', name: 'primary', config: samplePostgresConfig() })
  ctx.store.setResourceState(resource.id, 'sleeping')
  const deps = createProxyDeps(ctx)

  await assert.rejects(deps.wake(resource.id))
  assert.equal(startCalls(), 1)
  clock.advance(30_000)
  const results = await Promise.allSettled(Array.from({ length: 10 }, () => deps.wake(resource.id)))
  for (const result of results) {
    assert.equal(result.status, 'rejected')
  }
  assert.equal(startCalls(), 2, 'ten wakes at the retry time, one start')
  assert.equal(getWakeRefusal(ctx, resource.id)?.failures, 2)
  ctx.store.close()
})

// The whole point of the backoff: the transient failure. The cause goes away
// while the resource is refused, nobody runs `hobby wake`, and the first
// wake after the retry time succeeds and wipes the record, so a later,
// unrelated failure starts again at 30 seconds rather than at 4 minutes.
test('issue #10 backoff: a transient failure recovers with no `hobby wake`, and success resets the schedule', async () => {
  const { runtime, startCalls, fix, breakAgain } = breakableRuntime()
  const clock = fakeClock()
  const ctx = buildContext(runtime, openStore(':memory:'), clock.now)
  const project = ctx.store.createProject({ name: 'blog', sleepAfterSeconds: 300 })
  const resource = ctx.store.createResource({ projectId: project.id, kind: 'postgres', name: 'primary', config: samplePostgresConfig() })
  await runtime.ensureCreated({ name: resource.config.containerName, image: 'postgres:18-alpine', env: {}, ports: [], binds: [] })
  ctx.store.setResourceState(resource.id, 'sleeping')
  const deps = createProxyDeps(ctx)

  await assert.rejects(deps.wake(resource.id))
  clock.advance(30_000)
  await assert.rejects(deps.wake(resource.id))
  clock.advance(60_000)
  await assert.rejects(deps.wake(resource.id))
  assert.equal(getWakeRefusal(ctx, resource.id)?.failures, 3)
  assert.equal(startCalls(), 3)

  // The disk was freed, Docker came back, whatever it was.
  fix()
  await assert.rejects(deps.wake(resource.id), /not woken automatically for another 2m 0s/, 'still refused until the window ends')
  clock.advance(120_000)
  await deps.wake(resource.id)
  assert.equal(startCalls(), 4)
  assert.equal(ctx.store.getResource(resource.id)?.state, 'running')
  assert.equal(getWakeRefusal(ctx, resource.id), null, 'a successful wake deletes the record')
  assert.equal(isWakeRefused(ctx, resource.id), false)

  // Much later, something breaks again. One failure, one 30 second rest.
  breakAgain()
  ctx.store.setResourceState(resource.id, 'sleeping')
  const failedAt = clock.now()
  await assert.rejects(deps.wake(resource.id))
  assert.deepEqual(
    { failures: getWakeRefusal(ctx, resource.id)?.failures, retryAt: getWakeRefusal(ctx, resource.id)?.retryAt },
    { failures: 1, retryAt: failedAt + 30_000 }
  )
  ctx.store.close()
})

// `hobby wake` resets the count as well as the window: someone looked, so a
// failure after it is the first of a new run.
test('issue #10 backoff: an explicit start clears the count as well as the window', async () => {
  const { runtime, startCalls } = breakableRuntime()
  const clock = fakeClock()
  const ctx = buildContext(runtime, openStore(':memory:'), clock.now)
  const project = ctx.store.createProject({ name: 'blog', sleepAfterSeconds: 300 })
  const resource = ctx.store.createResource({ projectId: project.id, kind: 'postgres', name: 'primary', config: samplePostgresConfig() })
  ctx.store.setResourceState(resource.id, 'sleeping')
  const deps = createProxyDeps(ctx)

  await assert.rejects(deps.wake(resource.id))
  clock.advance(30_000)
  await assert.rejects(deps.wake(resource.id))
  assert.equal(getWakeRefusal(ctx, resource.id)?.failures, 2)

  // Still broken: the explicit start itself fails, and says so to whoever
  // ran it. It is not recorded as a refusal (routes.ts, startResourceRoute).
  await withApi(ctx, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/v1/resources/${resource.id}/start`, { method: 'POST' })
    assert.notEqual(res.status, 200)
  })
  assert.equal(startCalls(), 3)
  assert.equal(getWakeRefusal(ctx, resource.id), null, 'the explicit start cleared the record')

  const failedAt = clock.now()
  await assert.rejects(deps.wake(resource.id))
  assert.equal(startCalls(), 4, 'the next automatic wake is not refused')
  assert.equal(getWakeRefusal(ctx, resource.id)?.failures, 1)
  assert.equal(getWakeRefusal(ctx, resource.id)?.retryAt, failedAt + 30_000)
  ctx.store.close()
})

// Studio's query route, the alarm mirror and a queue delivery wake through
// buildWake with no front door in the way, so the error it throws is all
// their caller sees. It has to say when the automatic retry is, how to skip
// it, and where the reason is.
test('issue #10 backoff: the refusal names the retry time, `hobby wake` and `hobby logs`', async () => {
  const { runtime } = breakableRuntime()
  const clock = fakeClock()
  const ctx = buildContext(runtime, openStore(':memory:'), clock.now)
  const project = ctx.store.createProject({ name: 'blog', sleepAfterSeconds: 300 })
  const resource = ctx.store.createResource({ projectId: project.id, kind: 'postgres', name: 'primary', config: samplePostgresConfig() })
  ctx.store.setResourceState(resource.id, 'sleeping')
  const deps = createProxyDeps(ctx)

  await assert.rejects(deps.wake(resource.id))
  clock.advance(30_000)
  await assert.rejects(deps.wake(resource.id))
  clock.advance(60_000)
  await assert.rejects(deps.wake(resource.id))
  // Third failure: a 2 minute rest. 47.5 seconds into it, 72.5 remain,
  // which reads as 1m 13s (rounded up, never down to a time already gone).
  clock.advance(47_500)
  const retryAt = getWakeRefusal(ctx, resource.id)?.retryAt ?? 0
  await assert.rejects(deps.wake(resource.id), (err: unknown) => {
    const message = (err as Error).message
    assert.equal((err as { code?: string }).code, 'wake_failed')
    assert.match(message, /failed 3 times in a row/)
    assert.match(message, /for another 1m 13s/)
    assert.ok(message.includes(new Date(retryAt).toISOString()), `the absolute retry time is missing: ${message}`)
    assert.match(message, /`hobby wake blog\/primary` to retry it now/)
    const hint = (err as { hint?: string }).hint ?? ''
    assert.match(hint, /hobby logs blog\/primary/)
    assert.match(hint, /exec format error/, 'the hint carries the last start error')
    return true
  })
  ctx.store.close()
})

// `hobby ls` end to end: the real CLI (run, packages/cli/src/cli/main.ts)
// against the real daemon API (createApp) on a unix socket, over a context
// with a refused resource in it. The human line shows the countdown and the
// error; --json carries the same record as wakeRefusal, with retryAt as an
// ISO string; a resource with no refusal says null, not nothing.
test('issue #10 backoff: `hobby ls` and --json show a refused resource and when it is retried', async () => {
  const { runtime } = breakableRuntime()
  const clock = fakeClock()
  // mkdtemp's short suffix, not a UUID: a unix socket path has a length
  // limit (104 bytes on macOS), and a UUID under macOS's tmpdir is past it.
  const home = mkdtempSync(join(tmpdir(), 'hobby-wl-'))
  const ctx = buildContext(runtime, openStore(':memory:'), clock.now)
  const project = ctx.store.createProject({ name: 'blog', sleepAfterSeconds: 300 })
  const refused = ctx.store.createResource({ projectId: project.id, kind: 'postgres', name: 'primary', config: samplePostgresConfig() })
  ctx.store.setResourceState(refused.id, 'sleeping')
  const healthy = ctx.store.createResource({ projectId: project.id, kind: 'postgres', name: 'other', config: samplePostgresConfig() })
  ctx.store.setResourceState(healthy.id, 'sleeping')
  // The CLI renders the countdown against the real clock, so for this test
  // the daemon's fake clock starts at the real time and simply never moves.
  clock.set(Date.now())
  const failedAt = clock.now()
  await assert.rejects(createProxyDeps(ctx).wake(refused.id))

  const server = createServer(createApp(ctx))
  await new Promise<void>((resolve) => server.listen(join(home, 'hobby.sock'), () => resolve()))
  try {
    const human = makeIo(home)
    assert.equal(await run(['ls'], human.io), 0)
    const line = human.out.find((l) => l.includes('primary')) ?? ''
    // 30s, or 29s if a second boundary passed since the failure; never more.
    assert.match(
      line,
      /^\s+primary {2}postgres {2}failed {2}port 25559 {2}\(wake refused, retry in (29|30)s: container exited immediately: exec format error\)$/
    )
    const other = human.out.find((l) => l.includes('other')) ?? ''
    assert.doesNotMatch(other, /wake refused|last wake failed/)

    const json = makeIo(home)
    assert.equal(await run(['ls', '--json'], json.io), 0)
    const body = JSON.parse(json.out.join('\n')) as unknown
    const resources = collectResources(body)
    const wire = resources.find((r) => r.id === refused.id)
    assert.deepEqual(wire?.wakeRefusal, {
      failures: 1,
      retryAt: new Date(failedAt + 30_000).toISOString(),
      lastError: 'container exited immediately: exec format error',
    })
    assert.equal(resources.find((r) => r.id === healthy.id)?.wakeRefusal, null)
  } finally {
    const closed = new Promise<void>((resolve) => server.close(() => resolve()))
    server.closeAllConnections()
    await closed
    ctx.store.close()
    rmSync(home, { recursive: true, force: true })
  }
})

// A kind handler may throw anything, and lastError goes out on the wire to
// every listing for up to 15 minutes. A connection string in a start error
// must not survive the trip.
test('issue #10 backoff: a credential in the start error is redacted before it reaches the wire', async () => {
  const base = createFakeRuntime()
  const runtime: ComputeRuntime = {
    ...base,
    async start(): Promise<void> {
      throw new Error('app exited: could not reach postgres://postgres:hunter2@10.0.0.5:5432/blog?password=hunter2')
    },
  }
  const clock = fakeClock()
  const ctx = buildContext(runtime, openStore(':memory:'), clock.now)
  const project = ctx.store.createProject({ name: 'blog', sleepAfterSeconds: 300 })
  const resource = ctx.store.createResource({ projectId: project.id, kind: 'postgres', name: 'primary', config: samplePostgresConfig() })
  ctx.store.setResourceState(resource.id, 'sleeping')
  await assert.rejects(createProxyDeps(ctx).wake(resource.id))

  await withApi(ctx, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/v1/projects/blog`)
    const text = await res.text()
    assert.ok(!text.includes('hunter2'), 'the password crossed the wire')
    const body = JSON.parse(text) as { resources: Array<{ wakeRefusal: { lastError: string } | null }> }
    assert.equal(
      body.resources[0]?.wakeRefusal?.lastError,
      'app exited: could not reach postgres://<redacted>@10.0.0.5:5432/blog?password=<redacted>'
    )
  })
  ctx.store.close()
})

// A wake that waited on a snapshot's fence and found the resource running
// afterwards (the snapshot's resume started it) never calls the kind handler,
// but it is as good as a successful one for the record: whatever failed
// before no longer does, and leaving the record would refuse the next wake
// after this resource sleeps again for a failure that has been fixed.
test('issue #10 backoff: a wake that finds the resource running after a snapshot fence clears the record', async () => {
  const { runtime, startCalls } = breakableRuntime()
  const clock = fakeClock()
  const ctx = buildContext(runtime, openStore(':memory:'), clock.now)
  const project = ctx.store.createProject({ name: 'blog', sleepAfterSeconds: 300 })
  const resource = ctx.store.createResource({ projectId: project.id, kind: 'postgres', name: 'primary', config: samplePostgresConfig() })
  ctx.store.setResourceState(resource.id, 'sleeping')
  const deps = createProxyDeps(ctx)

  await assert.rejects(deps.wake(resource.id))
  clock.advance(30_000)
  const release = holdProjectAsleep(ctx, project.id, project.name)
  const waking = deps.wake(resource.id)
  ctx.store.setResourceState(resource.id, 'running')
  release()
  await waking
  assert.equal(startCalls(), 1, 'the fenced wake found it running and started nothing')
  assert.equal(getWakeRefusal(ctx, resource.id), null)
  ctx.store.close()
})

function makeIo(home: string): { io: Io; out: string[] } {
  const out: string[] = []
  return {
    io: { out: (s) => out.push(s), err: () => {}, env: { HOBBY_HOME: home }, cwd: home, readLine: async () => '' },
    out,
  }
}

// `hobby ls --json` prints whatever shape the command assembled; find every
// object with an id and a kind in it rather than depending on that shape.
function collectResources(value: unknown): Array<{ id: string; wakeRefusal?: unknown }> {
  const found: Array<{ id: string; wakeRefusal?: unknown }> = []
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) {
      for (const item of v) walk(item)
      return
    }
    if (v !== null && typeof v === 'object') {
      const record = v as Record<string, unknown>
      if (typeof record['id'] === 'string' && typeof record['kind'] === 'string') {
        found.push(record as { id: string; wakeRefusal?: unknown })
      }
      for (const child of Object.values(record)) walk(child)
    }
  }
  walk(value)
  return found
}
