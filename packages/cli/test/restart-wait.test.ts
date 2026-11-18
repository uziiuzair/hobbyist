// Phase A3 (2026-11-18): a new connection that arrives while the daemon is
// restarting an awake database on purpose waits for it instead of being
// refused. End to end on the daemon side: the real wake-on-connect proxy
// (startPgProxy), the real ProxyDeps (createProxyDeps), the real
// applyPostgresSettings and cloneSourceAtRest, the real startPostgres and
// stopPostgres. The fakes are an in-memory store, a fake runtime whose
// stop and start take down and bring back a stand-in Postgres on the
// resource's host port (so a dial in between is really refused), and gates
// that let the test connect at an exact point in the restart. No Docker.

import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
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
  type PostgresResource,
  type Project,
} from '@hobby.sh/core'
import { ActivityTracker, buildStartupPacket, startPgProxy } from '@hobby.sh/proxy'
import { createDefaultKindRegistry, holdProjectAsleep } from '../src/daemon/context.js'
import { cloneSourceAtRest } from '../src/daemon/branch.js'
import { applyPostgresSettings } from '../src/daemon/pg-settings.js'
import { createProxyDeps, type DaemonContext } from '../src/index.js'

const WAKE_TIMEOUT_MS = 2000

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
    wakeTimeoutMs: WAKE_TIMEOUT_MS,
    readinessPollMs: 20,
    queuePort: 0,
    caddyEnabled: false,
    caddyAdminPort: 2019,
    caddyStudioHost: null,
    project: null,
  }
}

// A stand-in for Postgres once it is up: answers any startup packet with
// AuthenticationOk, BackendKeyData, ReadyForQuery.
async function serve(port: number): Promise<{ port: number; close: () => Promise<void> }> {
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
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', () => resolve()))
  return {
    port: (server.address() as AddressInfo).port,
    close: () => {
      for (const socket of sockets) socket.destroy()
      return new Promise((resolve) => server.close(() => resolve()))
    },
  }
}

interface Gate {
  // Resolves when the runtime call reaches the gate.
  reached: Promise<void>
  open: () => void
}

function gate(): Gate & { wait: () => Promise<void> } {
  let reach: () => void = () => {}
  let open: () => void = () => {}
  const reached = new Promise<void>((resolve) => (reach = resolve))
  const opened = new Promise<void>((resolve) => (open = resolve))
  return {
    reached,
    open,
    wait: async () => {
      reach()
      await opened
    },
  }
}

// A runtime whose stop takes the stand-in Postgres off the port and whose
// start puts it back, each optionally paused at a gate. `failStarts` makes
// every start throw, the way a container that will not boot does.
function restartingRuntime(port: number): {
  runtime: ComputeRuntime
  starts: () => number
  stopGate: (g: ReturnType<typeof gate> | null) => void
  startGate: (g: ReturnType<typeof gate> | null) => void
  failStarts: () => void
  up: () => Promise<void>
  down: () => Promise<void>
} {
  const base = createFakeRuntime()
  let upstream: { close: () => Promise<void> } | null = null
  let stopAt: ReturnType<typeof gate> | null = null
  let startAt: ReturnType<typeof gate> | null = null
  let failing = false
  let starts = 0
  const up = async (): Promise<void> => {
    if (upstream === null) upstream = await serve(port)
  }
  const down = async (): Promise<void> => {
    const current = upstream
    upstream = null
    await current?.close()
  }
  const runtime: ComputeRuntime = {
    ...base,
    async stop(name, opts) {
      await down()
      await base.stop(name, opts)
      await stopAt?.wait()
    },
    async start(name) {
      starts++
      await startAt?.wait()
      if (failing) {
        throw new Error('container exited immediately: invalid value for parameter "max_connections"')
      }
      await base.start(name)
      await up()
    },
  }
  return {
    runtime,
    starts: () => starts,
    stopGate: (g) => (stopAt = g),
    startGate: (g) => (startAt = g),
    failStarts: () => (failing = true),
    up,
    down,
  }
}

async function freePort(): Promise<number> {
  const s = await serve(0)
  await s.close()
  return s.port
}

async function setup(): Promise<{
  ctx: DaemonContext
  project: Project
  resource: PostgresResource
  rt: ReturnType<typeof restartingRuntime>
  proxyPort: number
  close: () => Promise<void>
}> {
  const port = await freePort()
  const rt = restartingRuntime(port)
  const ctx: DaemonContext = {
    store: openStore(':memory:'),
    runtime: rt.runtime,
    paths: resolvePaths({ HOBBY_HOME: join(tmpdir(), `hobby-restart-wait-${randomUUID()}`) }),
    config: testConfig(),
    activity: new ActivityTracker(),
    kinds: createDefaultKindRegistry(),
    probeFactory: () => async () => true,
  }
  const project = ctx.store.createProject({ name: 'blog', sleepAfterSeconds: 300 })
  const config: PostgresConfig = {
    image: 'postgres:18-alpine',
    containerName: `hobby-blog-primary-${randomUUID()}`,
    dataDir: ctx.paths.resourcePath('blog', 'primary', 'pgdata'),
    hostPort: port,
    superuser: 'postgres',
    password: 'secret',
    database: 'blog',
  }
  const created = ctx.store.createResource({ projectId: project.id, kind: 'postgres', name: 'primary', config })
  await rt.runtime.ensureCreated({ name: config.containerName, image: config.image, env: {}, ports: [], binds: [] })
  await rt.runtime.start(config.containerName)
  ctx.store.setResourceState(created.id, 'running')
  const proxy = await startPgProxy({ port: 0, deps: createProxyDeps(ctx), wakeTimeoutMs: WAKE_TIMEOUT_MS })
  return {
    ctx,
    project,
    resource: ctx.store.getResource(created.id) as PostgresResource,
    rt,
    proxyPort: proxy.port,
    close: async () => {
      await proxy.close()
      await rt.down()
      ctx.store.close()
    },
  }
}

// Connects through the proxy, sends a startup packet, and resolves with
// every byte the proxy sent before the first full message, plus when the
// answer came. `settled` is readable before it resolves.
function connect(port: number): { answer: Promise<{ bytes: Buffer; at: number }>; settled: () => boolean } {
  let done = false
  const answer = new Promise<{ bytes: Buffer; at: number }>((resolve, reject) => {
    const socket = net.createConnection({ host: '127.0.0.1', port })
    let buffer = Buffer.alloc(0)
    const finish = (): void => {
      done = true
      socket.destroy()
      resolve({ bytes: buffer, at: Date.now() })
    }
    socket.once('connect', () => socket.write(buildStartupPacket({ user: 'postgres', database: 'blog' })))
    socket.on('data', (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk])
      if (buffer.length >= 5 && buffer.length >= 1 + buffer.readInt32BE(1)) finish()
    })
    socket.on('close', finish)
    socket.on('error', reject)
  })
  return { answer, settled: () => done }
}

const idle = { guard: async () => 'idle' as const, attempts: 1, waitMs: 1, sleepFor: async () => {} }

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

test('a connection that arrives while a settings change has the container stopped waits, and is served by the new one', async () => {
  const h = await setup()
  try {
    const stopped = gate()
    h.rt.stopGate(stopped)
    const applying = applyPostgresSettings(h.ctx, h.project, h.resource, { set: { max_connections: 50 }, quiesce: idle })
    await stopped.reached
    // The port is closed and the store says stopping: before Phase A3's
    // fence this is the window a client was refused in.
    const client = connect(h.proxyPort)
    await delay(150)
    assert.equal(client.settled(), false, 'the client is held, not refused')
    stopped.open()
    const result = await applying
    assert.equal(result.applied, 'restarted')
    const { bytes } = await client.answer
    assert.equal(String.fromCharCode(bytes[0] ?? 0), 'R', `expected AuthenticationOk, got ${bytes.toString('latin1')}`)
    assert.equal(h.rt.starts(), 2, 'the setup start and the restart; the waiting client started nothing')
  } finally {
    await h.close()
  }
})

test('a connection that arrives while the restarted container is still starting waits for it too', async () => {
  const h = await setup()
  try {
    const starting = gate()
    h.rt.startGate(starting)
    const applying = applyPostgresSettings(h.ctx, h.project, h.resource, { set: { max_connections: 50 }, quiesce: idle })
    await starting.reached
    assert.equal(h.ctx.store.getResource(h.resource.id)?.state, 'starting')
    const client = connect(h.proxyPort)
    await delay(150)
    assert.equal(client.settled(), false)
    starting.open()
    await applying
    const { bytes } = await client.answer
    assert.equal(String.fromCharCode(bytes[0] ?? 0), 'R')
  } finally {
    await h.close()
  }
})

test('a connection waiting on a restart that fails gets the reason at once, not a timeout, and starts nothing itself', async () => {
  const h = await setup()
  try {
    const stopped = gate()
    h.rt.stopGate(stopped)
    h.rt.failStarts()
    const applying = applyPostgresSettings(h.ctx, h.project, h.resource, { set: { max_connections: 50 }, quiesce: idle })
    await stopped.reached
    const client = connect(h.proxyPort)
    await delay(100)
    const openedAt = Date.now()
    stopped.open()
    await assert.rejects(applying, /restoring the previous ones failed too/)
    const { bytes, at } = await client.answer
    const text = bytes.toString('latin1')
    assert.equal(String.fromCharCode(bytes[0] ?? 0), 'E', text)
    assert.match(text, /blog\/primary was restarted by a settings change, and did not come back/)
    assert.match(text, /container exited immediately/)
    assert.ok(at - openedAt < WAKE_TIMEOUT_MS / 2, `answered ${at - openedAt}ms after the restart failed`)
    // 1 setup start, 1 with the new settings, 1 rollback. None from the client.
    assert.equal(h.rt.starts(), 3)
  } finally {
    await h.close()
  }
})

test('a restart that outlasts the wake budget ends the wait with an error, inside the budget', async () => {
  const h = await setup()
  try {
    const stopped = gate()
    h.rt.stopGate(stopped)
    const applying = applyPostgresSettings(h.ctx, h.project, h.resource, { set: { max_connections: 50 }, quiesce: idle })
    await stopped.reached
    const startedAt = Date.now()
    const client = connect(h.proxyPort)
    const { bytes, at } = await client.answer
    assert.equal(String.fromCharCode(bytes[0] ?? 0), 'E')
    assert.match(bytes.toString('latin1'), /wake timed out/)
    assert.ok(at - startedAt < WAKE_TIMEOUT_MS + 500, `held ${at - startedAt}ms`)
    stopped.open()
    await applying
  } finally {
    await h.close()
  }
})

test('a branch quiescing an awake source holds new connections to the source until it is resumed', async () => {
  const h = await setup()
  try {
    const cloning = gate()
    const branching = cloneSourceAtRest(h.ctx, h.project, [h.resource], {
      destination: () => join(tmpdir(), `hobby-restart-wait-branch-${randomUUID()}`),
      label: 'branch',
      quiesce: idle,
      clone: async () => {
        await cloning.wait()
        return { mechanism: 'reflink' as const, files: 0, bytes: 0 }
      },
      now: Date.now,
    })
    await cloning.reached
    assert.equal(h.ctx.store.getResource(h.resource.id)?.state, 'sleeping')
    const client = connect(h.proxyPort)
    await delay(150)
    assert.equal(client.settled(), false, 'held, and the source was not woken mid-clone')
    assert.equal(h.ctx.store.getResource(h.resource.id)?.state, 'sleeping')
    cloning.open()
    const result = await branching
    assert.deepEqual(result.resumeFailures, [])
    const { bytes } = await client.answer
    assert.equal(String.fromCharCode(bytes[0] ?? 0), 'R')
  } finally {
    await h.close()
  }
})

test('a branch of a source that is asleep holds nothing, and a settings change waits for no operation of its own', async () => {
  const h = await setup()
  try {
    // Asleep source: no hold, so a concurrent hold on it is not refused.
    await h.ctx.kinds.get('postgres').stop(h.ctx, h.resource)
    const asleep = h.ctx.store.getResource(h.resource.id) as PostgresResource
    const cloning = gate()
    const branching = cloneSourceAtRest(h.ctx, h.project, [asleep], {
      destination: () => join(tmpdir(), `hobby-restart-wait-branch-${randomUUID()}`),
      label: 'branch',
      clone: async () => {
        await cloning.wait()
        return { mechanism: 'reflink' as const, files: 0, bytes: 0 }
      },
      now: Date.now,
    })
    await cloning.reached
    const release = holdProjectAsleep(h.ctx, h.project.id, h.project.name)
    release()
    cloning.open()
    await branching

    // A settings change applied to an asleep database takes the hold and
    // releases it without anything waking it, and its own work never waits
    // on its own fence.
    const result = await applyPostgresSettings(h.ctx, h.project, asleep, { set: { max_connections: 60 } })
    assert.equal(result.applied, 'next-start')
    assert.equal(h.ctx.store.getResource(h.resource.id)?.state, 'sleeping')
  } finally {
    await h.close()
  }
})

test('a second operation on a held project is refused naming the one in progress', async () => {
  const h = await setup()
  try {
    const stopped = gate()
    h.rt.stopGate(stopped)
    const applying = applyPostgresSettings(h.ctx, h.project, h.resource, { set: { max_connections: 50 }, quiesce: idle })
    await stopped.reached
    assert.throws(() => holdProjectAsleep(h.ctx, h.project.id, h.project.name), /a settings change of blog is already in progress/)
    stopped.open()
    await applying
  } finally {
    await h.close()
  }
})
