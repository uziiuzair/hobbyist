// Phase A2: the proxy as its own process, outliving the daemon
// (docs/proxy/specs/2026-11-18-proxy-outlives-the-daemon.md).
//
// Most of these run the proxy host (packages/cli/src/proxyd/host.ts) in this
// process and play the daemon with adoptOrStartProxy against a fake daemon
// side, which is the whole cross-process contract minus the fork. One spawns
// the real bin/hobby-proxy.js as a child process. The backend is a fake
// Postgres that answers a startup with AuthenticationOk and ReadyForQuery and
// then echoes, so a session is "open" when bytes round-trip through it.

import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  createFakeRuntime,
  openStore,
  resolvePaths,
  type HobbyConfig,
  type KindRegistry,
  type PostgresConfig,
  type Resource,
  type ResourceKindHandler,
  type Store,
} from '@hobby.sh/core'
import { ActivityTracker, buildStartupPacket } from '@hobby.sh/proxy'
import {
  adoptOrStartProxy,
  cmdDaemonStop,
  createDefaultKindRegistry,
  dialProxy,
  isAlive,
  resourcesToStopOnRestart,
  startDaemon,
  startProxyHost,
  type DaemonContext,
  type ProxydConfig,
  type ProxyHost,
  type ProxyLinkDaemonSide,
} from '../src/index.js'

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function eventually(check: () => boolean, what: string, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await sleep(10)
  }
}

// Short: unix socket paths are capped near 104 bytes on macOS.
function tempHome(): string {
  return mkdtempSync(join(tmpdir(), 'hpx-'))
}

function backendMessage(type: string, body: Buffer): Buffer {
  const header = Buffer.alloc(5)
  header.write(type, 0, 'ascii')
  header.writeInt32BE(body.length + 4, 1)
  return Buffer.concat([header, body])
}

const AUTH_OK = backendMessage('R', Buffer.from([0, 0, 0, 0]))
const READY = backendMessage('Z', Buffer.from('I', 'ascii'))

async function startEchoBackend(): Promise<{ port: number; close(): Promise<void> }> {
  const sockets = new Set<net.Socket>()
  const server = net.createServer((socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    socket.on('error', () => {})
    socket.once('data', () => {
      socket.write(Buffer.concat([AUTH_OK, READY]))
      socket.on('data', (chunk) => socket.write(chunk))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  return {
    port,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy()
        server.close(() => resolve())
      }),
  }
}

function pgConfig(name: string, hostPort: number): PostgresConfig {
  return {
    image: 'postgres:18-alpine',
    containerName: `hobby-${name}-primary-${randomUUID()}`,
    dataDir: `/nowhere/${name}`,
    hostPort,
    superuser: 'postgres',
    password: 'secret',
    database: name,
  }
}

// A state.db the way the daemon writes it, holding project `name` with one
// postgres in `state`, routed to `hostPort`.
function seedStore(store: Store, name: string, hostPort: number, state: 'running' | 'sleeping', sleepAfterSeconds: number | null = 300): Resource {
  const project = store.createProject({ name, sleepAfterSeconds })
  const resource = store.createResource({ projectId: project.id, kind: 'postgres', name: 'primary', config: pgConfig(name, hostPort) })
  store.setResourceState(resource.id, state)
  return resource
}

function proxyConfig(home: string, wakeTimeoutMs = 2000): ProxydConfig {
  return {
    socketPath: join(home, 'proxy.sock'),
    statePath: join(home, 'state.db'),
    port: 0,
    hosts: ['127.0.0.1'],
    wakeTimeoutMs,
    tls: null,
  }
}

// A session through the proxy: connect, send a startup for `database`, and
// wait for the backend's ReadyForQuery. `roundTrip` then proves it is open.
async function openSession(port: number, database: string): Promise<{ socket: net.Socket; roundTrip(text: string): Promise<string>; first: Buffer }> {
  const socket = net.createConnection({ host: '127.0.0.1', port })
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', resolve)
    socket.once('error', reject)
  })
  socket.write(buildStartupPacket({ user: 'bob', database }))
  const first = await new Promise<Buffer>((resolve, reject) => {
    let buffer = Buffer.alloc(0)
    const onData = (chunk: Buffer): void => {
      buffer = Buffer.concat([buffer, chunk])
      if (buffer[0] === 0x45 /* E */ || buffer.includes(READY)) {
        socket.off('data', onData)
        resolve(buffer)
      }
    }
    socket.on('data', onData)
    socket.once('close', () => resolve(buffer))
    socket.once('error', reject)
  })
  return {
    socket,
    first,
    roundTrip: (text) =>
      new Promise<string>((resolve, reject) => {
        socket.once('data', (chunk: Buffer) => resolve(chunk.toString()))
        socket.once('error', reject)
        socket.write(text)
      }),
  }
}

function fakeDaemon(wake: (resourceId: string) => Promise<void> = async () => {}): ProxyLinkDaemonSide & { activity: ActivityTracker; wakes: string[] } {
  const wakes: string[] = []
  return {
    activity: new ActivityTracker(),
    wakes,
    wake: async (resourceId) => {
      wakes.push(resourceId)
      await wake(resourceId)
    },
    refusalRetryAt: () => null,
  }
}

const noSpawn = (): Promise<number | null> => {
  throw new Error('this test expects the running proxy to be adopted, not a new one spawned')
}

test('an open session survives its daemon going away and a new daemon adopting the proxy', async () => {
  const home = tempHome()
  const backend = await startEchoBackend()
  const store = openStore(join(home, 'state.db'))
  const resource = seedStore(store, 'blog', backend.port, 'running')
  const config = proxyConfig(home)
  const host = await startProxyHost(config, { fingerprint: 'same', log: () => {} })
  try {
    const first = fakeDaemon()
    const link1 = await adoptOrStartProxy({ config, logPath: join(home, 'p.log'), daemon: first, fingerprint: 'same', spawn: noSpawn, log: () => {} })
    assert.equal(link1.adopted, true)

    const session = await openSession(host.port, 'blog')
    assert.ok(session.first.includes(READY))
    assert.equal(await session.roundTrip('one'), 'one')
    await eventually(() => first.activity.count(resource.id) === 1, 'the first daemon to count the session')

    // The daemon exits (a restart): the link closes, the proxy stays.
    link1.detach()
    await link1.closed
    await eventually(() => !host.linked(), 'the proxy to notice the daemon left')
    assert.equal(await session.roundTrip('two'), 'two', 'the session still carries bytes with no daemon')
    assert.equal(first.activity.count(resource.id), 0, 'a departed link no longer holds anything awake')

    // The next daemon adopts it and learns about the session from the hello.
    const second = fakeDaemon()
    const link2 = await adoptOrStartProxy({ config, logPath: join(home, 'p.log'), daemon: second, fingerprint: 'same', spawn: noSpawn, log: () => {} })
    assert.equal(link2.adopted, true)
    assert.equal(second.activity.count(resource.id), 1)
    assert.equal(await session.roundTrip('three'), 'three')

    session.socket.end()
    await eventually(() => second.activity.count(resource.id) === 0, 'the close to reach the new daemon')
    assert.notEqual(second.activity.idleSeconds(resource.id), null, 'the idle clock starts when the session closes')

    await link2.stopProxy()
    await host.stopped
  } finally {
    await host.stop()
    store.close()
    await backend.close()
  }
})

test('a probe (hobby init) reads the hello without displacing the linked daemon', async () => {
  const home = tempHome()
  const store = openStore(join(home, 'state.db'))
  const config = proxyConfig(home)
  const host = await startProxyHost(config, { fingerprint: 'same', log: () => {} })
  try {
    const link = await adoptOrStartProxy({ config, logPath: join(home, 'p.log'), daemon: fakeDaemon(), fingerprint: 'same', spawn: noSpawn, log: () => {} })
    const probe = await dialProxy(config.socketPath)
    assert.equal(probe?.hello.pid, process.pid)
    probe?.socket.destroy()
    await sleep(50)
    assert.equal(host.linked(), true, 'the daemon is still the linked one')
    await link.stopProxy()
  } finally {
    await host.stop()
    store.close()
  }
})

test('with no daemon at all, a running database is still routed from state.db, and an unknown one refused', async () => {
  const home = tempHome()
  const backend = await startEchoBackend()
  const store = openStore(join(home, 'state.db'))
  seedStore(store, 'blog', backend.port, 'running')
  const host = await startProxyHost(proxyConfig(home), { fingerprint: 'x', log: () => {} })
  try {
    assert.equal(host.linked(), false)
    const session = await openSession(host.port, 'blog')
    assert.ok(session.first.includes(READY))
    assert.equal(await session.roundTrip('hi'), 'hi')
    session.socket.destroy()

    // A project created after the proxy opened state.db is seen too: the
    // read-only handle reads the daemon's later writes through the WAL.
    const backend2 = await startEchoBackend()
    seedStore(store, 'shop', backend2.port, 'running')
    const shop = await openSession(host.port, 'shop')
    assert.ok(shop.first.includes(READY))
    shop.socket.destroy()
    await backend2.close()

    const unknown = await openSession(host.port, 'nope')
    assert.equal(unknown.first[0], 0x45)
    assert.ok(unknown.first.toString().includes('3D000'))
  } finally {
    await host.stop()
    store.close()
    await backend.close()
  }
})

test('a wake with no daemon waits for one; a leaving daemon passes it on to the next', async () => {
  const home = tempHome()
  const backend = await startEchoBackend()
  const store = openStore(join(home, 'state.db'))
  const resource = seedStore(store, 'blog', backend.port, 'sleeping')
  const config = proxyConfig(home, 3000)
  const host = await startProxyHost(config, { fingerprint: 'same', log: () => {} })
  try {
    // A daemon that is shutting down is linked when the connection arrives.
    const leaving = fakeDaemon(async () => {
      throw new Error('a leaving daemon must not wake anything')
    })
    const link1 = await adoptOrStartProxy({ config, logPath: join(home, 'p.log'), daemon: leaving, fingerprint: 'same', spawn: noSpawn, log: () => {} })
    link1.beginLeaving()

    const started = Date.now()
    const pending = openSession(host.port, 'blog')
    await sleep(150)
    link1.detach()
    await link1.closed
    await sleep(250)

    // The next daemon arrives and performs the wake: the engine acts.
    const next = fakeDaemon(async () => {
      store.setResourceState(resource.id, 'running')
    })
    const link2 = await adoptOrStartProxy({ config, logPath: join(home, 'p.log'), daemon: next, fingerprint: 'same', spawn: noSpawn, log: () => {} })

    const session = await pending
    assert.ok(session.first.includes(READY), 'the held connection is served once the new daemon wakes the database')
    assert.ok(Date.now() - started >= 400, 'it waited for the daemon rather than failing')
    assert.deepEqual(leaving.wakes, [])
    assert.deepEqual(next.wakes, [resource.id])
    assert.equal(await session.roundTrip('awake'), 'awake')
    session.socket.destroy()
    await link2.stopProxy()
  } finally {
    await host.stop()
    store.close()
    await backend.close()
  }
})

test('a wake no daemon answers within the wake timeout says the daemon is not running', async () => {
  const home = tempHome()
  const store = openStore(join(home, 'state.db'))
  seedStore(store, 'blog', 1, 'sleeping')
  const host = await startProxyHost(proxyConfig(home, 400), { fingerprint: 'x', log: () => {} })
  try {
    const session = await openSession(host.port, 'blog')
    const text = session.first.toString()
    assert.equal(session.first[0], 0x45)
    assert.ok(text.includes('57P03'), text)
    assert.ok(text.includes('daemon is not running'), text)
  } finally {
    await host.stop()
    store.close()
  }
})

test('a failed wake reports its refusal, and the proxy refuses at once until it runs out', async () => {
  const home = tempHome()
  const store = openStore(join(home, 'state.db'))
  const resource = seedStore(store, 'blog', 1, 'sleeping')
  const config = proxyConfig(home)
  const host = await startProxyHost(config, { fingerprint: 'same', log: () => {} })
  try {
    const daemon = fakeDaemon(async () => {
      throw new Error('docker start failed')
    })
    daemon.refusalRetryAt = () => Date.now() + 60_000
    const link = await adoptOrStartProxy({ config, logPath: join(home, 'p.log'), daemon, fingerprint: 'same', spawn: noSpawn, log: () => {} })
    const failed = await openSession(host.port, 'blog')
    assert.ok(failed.first.toString().includes('docker start failed'))
    const refused = await openSession(host.port, 'blog')
    assert.ok(refused.first.toString().includes('last wake failed'))
    assert.deepEqual(daemon.wakes, [resource.id], 'the refused connection never asked the daemon')
    await link.stopProxy()
  } finally {
    await host.stop()
    store.close()
  }
})

test('a proxy running other code is stopped and replaced, and the log says sessions end', async () => {
  const home = tempHome()
  const store = openStore(join(home, 'state.db'))
  const config = proxyConfig(home)
  const old = await startProxyHost(config, { fingerprint: 'old', log: () => {} })
  let replacement: ProxyHost | null = null
  const lines: string[] = []
  try {
    const link = await adoptOrStartProxy({
      config,
      logPath: join(home, 'p.log'),
      daemon: fakeDaemon(),
      fingerprint: 'new',
      log: (line) => lines.push(line),
      spawn: (c) => {
        void startProxyHost(c, { fingerprint: 'new', log: () => {} }).then((h) => {
          replacement = h
        })
        return new Promise(() => {})
      },
    })
    await old.stopped
    assert.equal(link.adopted, false)
    assert.ok(lines.some((line) => line.includes('its code changed') && line.includes('ends 0 open sessions')), lines.join('\n'))
    await link.stopProxy()
  } finally {
    await old.stop()
    await (replacement as ProxyHost | null)?.stop()
    store.close()
  }
})

test('the real proxy process: spawned, a session outlives the link, adopted again, stopped', async () => {
  const home = tempHome()
  const backend = await startEchoBackend()
  const store = openStore(join(home, 'state.db'))
  const resource = seedStore(store, 'blog', backend.port, 'running')
  const config = proxyConfig(home)
  const logPath = join(home, 'proxy.log')
  let pid = 0
  try {
    const first = fakeDaemon()
    const link1 = await adoptOrStartProxy({ config, logPath, daemon: first, log: () => {} })
    pid = link1.pid
    assert.equal(link1.adopted, false)
    assert.notEqual(pid, process.pid)

    const session = await openSession(link1.port, 'blog')
    assert.equal(await session.roundTrip('a'), 'a')
    link1.detach()
    await link1.closed
    assert.equal(await session.roundTrip('b'), 'b')

    const second = fakeDaemon()
    const link2 = await adoptOrStartProxy({ config, logPath, daemon: second, spawn: noSpawn, log: () => {} })
    assert.equal(link2.adopted, true, 'same code on disk, same settings: adopted')
    assert.equal(link2.pid, pid)
    assert.equal(second.activity.count(resource.id), 1)

    const ended = new Promise<void>((resolve) => session.socket.once('close', () => resolve()))
    await link2.stopProxy()
    assert.equal(isAlive(pid), false, 'the proxy process exited')
    await ended
  } finally {
    if (pid !== 0 && isAlive(pid)) process.kill(pid, 'SIGKILL')
    store.close()
    await backend.close()
  }
})

test('hobby daemon stop with no daemon running stops a proxy left behind', async () => {
  const home = tempHome()
  const store = openStore(join(home, 'state.db'))
  const host = await startProxyHost(proxyConfig(home), { fingerprint: 'x', log: () => {} })
  const out: string[] = []
  try {
    const io = { out: (line: string) => out.push(line), err: () => {}, env: {}, cwd: home } as never
    const code = await cmdDaemonStop(io, resolvePaths({ HOBBY_HOME: home }), { lockPath: join(home, 'no-lock') })
    assert.equal(code, 0)
    await host.stopped
    assert.ok(out[0]?.includes('stopped the proxy'), out.join('\n'))
  } finally {
    await host.stop()
    store.close()
  }
})

// --- Through startDaemon ----------------------------------------------------

function testConfig(): HobbyConfig {
  return {
    image: 'postgres:18-alpine',
    proxyPort: 0,
    proxyHost: '127.0.0.1',
    proxyTls: null,
    studioPort: 8443,
    apiPort: 0,
    httpPort: 0,
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

function recordingKinds(stopped: string[]): KindRegistry {
  const real = createDefaultKindRegistry()
  return {
    has: (kind) => real.has(kind),
    kinds: () => real.kinds(),
    get: (kind) =>
      ({
        ...real.get(kind),
        stop: async (_ctx: unknown, resource: Resource) => {
          stopped.push(resource.id)
        },
      }) as ResourceKindHandler,
  }
}

test('resourcesToStopOnRestart keeps a sleepable resource that has a session open', () => {
  const store = openStore(':memory:')
  const ctx: DaemonContext = {
    store,
    runtime: createFakeRuntime(),
    paths: resolvePaths({ HOBBY_HOME: tempHome() }),
    config: testConfig(),
    activity: new ActivityTracker(),
    kinds: createDefaultKindRegistry(),
  }
  try {
    const busy = seedStore(store, 'busy', 1, 'running')
    const idle = seedStore(store, 'idle', 2, 'running')
    seedStore(store, 'pinned', 3, 'running', null)
    ctx.activity.open(busy.id)
    assert.deepEqual(
      resourcesToStopOnRestart(ctx).map((r) => r.id),
      [idle.id]
    )
  } finally {
    store.close()
  }
})

test('startDaemon with a proxy process: a restart keeps the proxy and the busy database, a full stop ends both', async () => {
  const home = tempHome()
  const backend = await startEchoBackend()
  const stopped: string[] = []
  const paths = resolvePaths({ HOBBY_HOME: home })
  const store = openStore(paths.statePath)
  const busy = seedStore(store, 'blog', backend.port, 'running')
  const idle = seedStore(store, 'shop', 1, 'running')
  const hosts: ProxyHost[] = []
  const proxyProcess = {
    fingerprint: 'same',
    spawn: (config: ProxydConfig): Promise<number | null> => {
      void startProxyHost(config, { fingerprint: 'same', log: () => {} }).then((h) => hosts.push(h))
      return new Promise(() => {})
    },
  }
  const ctx = (): DaemonContext => ({
    store,
    runtime: createFakeRuntime(),
    paths,
    config: testConfig(),
    activity: new ActivityTracker(),
    kinds: recordingKinds(stopped),
  })
  try {
    const ctx1 = ctx()
    const daemon1 = await startDaemon(ctx1, { socketPath: join(home, 'd.sock'), apiPort: null, proxyProcess })
    assert.equal(hosts.length, 1)
    const session = await openSession(hosts[0]!.port, 'blog')
    assert.equal(await session.roundTrip('x'), 'x')
    await eventually(() => ctx1.activity.count(busy.id) === 1, 'the daemon to count the session')

    await daemon1.close('restart')
    assert.deepEqual(stopped, [idle.id], 'only the idle sleepable database is stopped on a restart')
    assert.equal(await session.roundTrip('y'), 'y', 'the session outlived the daemon')

    const ctx2 = ctx()
    const daemon2 = await startDaemon(ctx2, { socketPath: join(home, 'd.sock'), apiPort: null, proxyProcess })
    assert.equal(hosts.length, 1, 'the running proxy was adopted, not replaced')
    assert.equal(ctx2.activity.count(busy.id), 1)

    const ended = new Promise<void>((resolve) => session.socket.once('close', () => resolve()))
    await daemon2.close('stop')
    await hosts[0]!.stopped
    session.socket.destroy()
    await ended
    assert.ok(stopped.includes(busy.id), 'a full stop stops the busy database too')
  } finally {
    for (const host of hosts) await host.stop()
    store.close()
    await backend.close()
  }
})
