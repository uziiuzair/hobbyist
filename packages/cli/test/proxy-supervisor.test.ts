// The daemon keeps its proxy process running (proxy-supervisor.ts), and the
// restart request that tells a requested restart from a stop
// (restart-request.ts).
//
// Every proxy here is the real bin/hobby-proxy.js spawned under node, as
// proxy-process.test.ts does once, because what is under test is a process
// dying and another taking its port. The backend is the same fake Postgres:
// AuthenticationOk and ReadyForQuery, then echo.

import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, statSync, utimesSync } from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  createFakeRuntime,
  openStore,
  resolvePaths,
  type HobbyConfig,
  type PostgresConfig,
  type Resource,
  type Store,
} from '@hobby.sh/core'
import { ActivityTracker, buildStartupPacket } from '@hobby.sh/proxy'
import {
  createDefaultKindRegistry,
  dialProxy,
  isAlive,
  onSigterm,
  RESTART_EXIT_CODE,
  restartRequestPath,
  sigtermModeFromEnv,
  SOCKET_MODE,
  startDaemon,
  superviseProxy,
  takeRestartRequest,
  writeRestartRequest,
  type DaemonContext,
  type ProxydConfig,
  type ProxyLinkDaemonSide,
} from '../src/index.js'

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function eventually(check: () => boolean, what: string, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await sleep(20)
  }
}

function tempHome(): string {
  return mkdtempSync(join(tmpdir(), 'hps-'))
}

async function freePort(): Promise<number> {
  const server = net.createServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return port
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

function seedStore(store: Store, name: string, hostPort: number, state: 'running' | 'sleeping'): Resource {
  const project = store.createProject({ name, sleepAfterSeconds: 300 })
  const resource = store.createResource({ projectId: project.id, kind: 'postgres', name: 'primary', config: pgConfig(name, hostPort) })
  store.setResourceState(resource.id, state)
  return resource
}

function proxyConfig(home: string, port: number): ProxydConfig {
  return {
    socketPath: join(home, 'proxy.sock'),
    statePath: join(home, 'state.db'),
    port,
    hosts: ['127.0.0.1'],
    wakeTimeoutMs: 3000,
    tls: null,
  }
}

async function openSession(port: number, database: string): Promise<{ socket: net.Socket; first: Buffer; roundTrip(text: string): Promise<string> }> {
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

function killQuietly(pid: number | null | undefined): void {
  if (pid === null || pid === undefined || pid === process.pid || !isAlive(pid)) return
  try {
    process.kill(pid, 'SIGKILL')
  } catch {
    // Already gone.
  }
}

test('a proxy killed while the daemon runs is respawned on the same port, with activity and wake working through it', async () => {
  const home = tempHome()
  const backend = await startEchoBackend()
  const store = openStore(join(home, 'state.db'))
  const awake = seedStore(store, 'blog', backend.port, 'running')
  const asleep = seedStore(store, 'shop', backend.port, 'sleeping')
  const config = proxyConfig(home, await freePort())
  const lines: string[] = []
  const daemon = fakeDaemon(async (resourceId) => {
    store.setResourceState(resourceId, 'running')
  })
  const pids: number[] = []
  try {
    const proxy = await superviseProxy({
      config,
      logPath: join(home, 'proxy.log'),
      daemon,
      log: (line) => lines.push(line),
      backoff: { baseMs: 50 },
    })
    const firstPid = proxy.pid()!
    pids.push(firstPid)
    assert.notEqual(firstPid, process.pid)
    assert.equal(statSync(config.socketPath).mode & 0o777, SOCKET_MODE, 'the control socket is owner-only')

    const before = await openSession(proxy.port, 'blog')
    assert.equal(await before.roundTrip('one'), 'one')
    await eventually(() => daemon.activity.count(awake.id) === 1, 'the session to be counted')

    process.kill(firstPid, 'SIGKILL')
    await eventually(() => proxy.health().state === 'up' && proxy.pid() !== firstPid && proxy.pid() !== null, 'a new proxy')
    const secondPid = proxy.pid()!
    pids.push(secondPid)
    assert.equal(isAlive(firstPid), false)
    assert.equal(proxy.port, config.port, 'the same port')
    assert.equal(daemon.activity.count(awake.id), 0, 'the dead proxy no longer holds anything awake')
    assert.equal(statSync(config.socketPath).mode & 0o777, SOCKET_MODE)
    assert.ok(lines.some((l) => l.includes('killed by SIGKILL') && l.includes('starting a new one')), lines.join('\n'))
    assert.ok(lines.some((l) => l.includes(`restarted the proxy (pid ${secondPid}`)), lines.join('\n'))
    const health = proxy.health()
    assert.equal(health.restarts, 1)
    assert.equal(health.lastLoss?.reason, 'killed by SIGKILL')

    // Connections, activity and wake all run through the new one.
    const after = await openSession(config.port, 'blog')
    assert.equal(await after.roundTrip('two'), 'two')
    await eventually(() => daemon.activity.count(awake.id) === 1, 'the new session to be counted')
    const woken = await openSession(config.port, 'shop')
    assert.ok(woken.first.includes(READY), 'a sleeping database is woken through the respawned proxy')
    assert.deepEqual(daemon.wakes, [asleep.id])
    await eventually(() => daemon.activity.count(asleep.id) === 1, 'the woken session to be counted')

    before.socket.destroy()
    after.socket.destroy()
    woken.socket.destroy()
    proxy.beginShutdown()
    await proxy.stopProxy()
    assert.equal(isAlive(secondPid), false, 'stopProxy ends the respawned proxy')
  } finally {
    for (const pid of pids) killQuietly(pid)
    store.close()
    await backend.close()
  }
})

test('a link that closes with the proxy still running is re-attached, not doubled', async () => {
  const home = tempHome()
  const store = openStore(join(home, 'state.db'))
  const config = proxyConfig(home, await freePort())
  const lines: string[] = []
  let pid: number | null = null
  try {
    const daemon = fakeDaemon()
    const proxy = await superviseProxy({ config, logPath: join(home, 'proxy.log'), daemon, log: (l) => lines.push(l), backoff: { reapGraceMs: 100 } })
    pid = proxy.pid()
    // A second daemon-side attach takes the link over, which closes ours with
    // the proxy alive: the closest a test gets to a link dropping on its own.
    const intruder = await dialProxy(config.socketPath)
    assert.ok(intruder !== null)
    intruder.socket.write(`${JSON.stringify({ t: 'attach' })}\n`)
    await eventually(() => lines.some((l) => l.includes('re-attached')), 're-attach', 5000)
    await proxy.idle()
    assert.equal(proxy.pid(), pid, 'the same process')
    assert.equal(proxy.health().state, 'up')
    intruder.socket.destroy()
    proxy.beginShutdown()
    await proxy.stopProxy()
  } finally {
    killQuietly(pid)
    store.close()
  }
})

// --- Through startDaemon ----------------------------------------------------

function testConfig(proxyPort: number): HobbyConfig {
  return {
    image: 'postgres:18-alpine',
    proxyPort,
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

function daemonContext(home: string, store: Store, proxyPort: number): DaemonContext {
  return {
    store,
    runtime: createFakeRuntime(),
    paths: resolvePaths({ HOBBY_HOME: home }),
    config: testConfig(proxyPort),
    activity: new ActivityTracker(),
    kinds: createDefaultKindRegistry(),
  }
}

function getHealth(socketPath: string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    http
      .get({ socketPath, path: '/v1/health' }, (res) => {
        let body = ''
        res.on('data', (chunk) => (body += chunk))
        res.on('end', () => resolve(JSON.parse(body) as Record<string, unknown>))
      })
      .on('error', reject)
  })
}

test('a crash loop gives up, says so loudly, and GET /v1/health reports it', async () => {
  const home = tempHome()
  const paths = resolvePaths({ HOBBY_HOME: home })
  const store = openStore(paths.statePath)
  const port = await freePort()
  const ctx = daemonContext(home, store, port)
  const socketPath = join(home, 'd.sock')
  const logged: string[] = []
  const originalError = console.error
  console.error = (...args: unknown[]) => {
    logged.push(args.map(String).join(' '))
  }
  let blocker: net.Server | null = null
  let firstPid: number | null = null
  let daemon: Awaited<ReturnType<typeof startDaemon>> | null = null
  try {
    daemon = await startDaemon(ctx, {
      socketPath,
      apiPort: null,
      proxyProcess: { logPath: join(home, 'proxy.log'), backoff: { baseMs: 20, maxMs: 40, maxFastCrashes: 3 } },
    })
    assert.deepEqual(await getHealth(socketPath), { status: 'ok', proxy: 'up' })
    firstPid = ctx.proxyHealth!().pid
    assert.ok(firstPid !== null && firstPid !== process.pid)

    // Something else takes the port the moment the proxy dies, so every
    // respawn exits at once, unable to bind.
    process.kill(firstPid, 'SIGKILL')
    await eventually(() => !isAlive(firstPid!), 'the proxy to die')
    blocker = net.createServer()
    await new Promise<void>((resolve, reject) => {
      blocker!.once('error', reject)
      blocker!.listen(port, '127.0.0.1', resolve)
    })

    await eventually(() => ctx.proxyHealth!().state === 'failed', 'the supervisor to give up', 30_000)
    assert.ok(logged.some((l) => l.includes('GIVING UP')), logged.join('\n'))
    assert.equal(logged.filter((l) => l.startsWith('proxy: a new proxy did not start')).length, 3, logged.join('\n'))
    assert.ok(logged.some((l) => l.includes('could not start')), 'the proxy log says why')
    assert.deepEqual(await getHealth(socketPath), { status: 'degraded', proxy: 'failed' })
  } finally {
    await daemon?.close('stop')
    console.error = originalError
    killQuietly(firstPid)
    await new Promise<void>((resolve) => (blocker === null ? resolve() : blocker.close(() => resolve())))
    store.close()
  }
})

test('a proxy that dies after the daemon began shutting down is not respawned', async () => {
  const home = tempHome()
  const paths = resolvePaths({ HOBBY_HOME: home })
  const store = openStore(paths.statePath)
  const port = await freePort()
  const ctx = daemonContext(home, store, port)
  const originalError = console.error
  console.error = () => {}
  let pid: number | null = null
  let daemon: Awaited<ReturnType<typeof startDaemon>> | null = null
  try {
    daemon = await startDaemon(ctx, {
      socketPath: join(home, 'd.sock'),
      apiPort: null,
      proxyProcess: { logPath: join(home, 'proxy.log'), backoff: { baseMs: 10 } },
    })
    pid = ctx.proxyHealth!().pid
    assert.ok(pid !== null)
    const closing = daemon.close('restart')
    process.kill(pid, 'SIGKILL')
    await closing
    await sleep(500)
    assert.equal(await dialProxy(join(home, 'proxy.sock'), 300), null, 'no proxy answers')
    // The port is free: nothing respawned onto it.
    const probe = net.createServer()
    await new Promise<void>((resolve, reject) => {
      probe.once('error', reject)
      probe.listen(port, '127.0.0.1', resolve)
    })
    await new Promise<void>((resolve) => probe.close(() => resolve()))
    assert.equal(ctx.proxyHealth!().restarts, 0)
  } finally {
    await daemon?.close('stop')
    console.error = originalError
    killQuietly(pid)
    store.close()
  }
})

// --- Stop versus restart under systemd (restart-request.ts) ----------------

test('HOBBY_SIGTERM picks what a plain SIGTERM means, and refuses anything else', () => {
  assert.equal(sigtermModeFromEnv({}), 'restart')
  assert.equal(sigtermModeFromEnv({ HOBBY_SIGTERM: 'restart' }), 'restart')
  assert.equal(sigtermModeFromEnv({ HOBBY_SIGTERM: 'stop' }), 'stop')
  assert.throws(() => sigtermModeFromEnv({ HOBBY_SIGTERM: 'yes' }), /HOBBY_SIGTERM/)
})

test('a restart request counts once, only for the pid it names, and only while fresh', () => {
  const home = tempHome()
  assert.equal(takeRestartRequest(home, 42), false, 'no request')

  writeRestartRequest(home, 42)
  assert.equal(statSync(restartRequestPath(home)).mode & 0o777, 0o600)
  assert.equal(takeRestartRequest(home, 42), true)
  assert.equal(takeRestartRequest(home, 42), false, 'used up')

  writeRestartRequest(home, 41)
  assert.equal(takeRestartRequest(home, 42), false, 'a request for another daemon')
  assert.equal(takeRestartRequest(home, 41), false, 'and it was removed, not left for later')

  writeRestartRequest(home, 42)
  const old = new Date(Date.now() - 5 * 60_000)
  utimesSync(restartRequestPath(home), old, old)
  assert.equal(takeRestartRequest(home, 42), false, 'stale')
})

test('a SIGTERM is a restart that exits 75 when requested, and otherwise what HOBBY_SIGTERM says', () => {
  const home = tempHome()
  assert.deepEqual(onSigterm(home, 'stop', 42), { mode: 'stop', exitCode: 0, requested: false }, 'systemctl stop under the unit: a full stop')
  assert.deepEqual(onSigterm(home, 'restart', 42), { mode: 'restart', exitCode: 0, requested: false }, 'by hand: a restart, as before')
  writeRestartRequest(home, 42)
  assert.deepEqual(onSigterm(home, 'stop', 42), { mode: 'restart', exitCode: RESTART_EXIT_CODE, requested: true }, 'hobby daemon restart')
  assert.equal(RESTART_EXIT_CODE, 75, 'the value scripts/hobby.service names in RestartForceExitStatus=')
})
