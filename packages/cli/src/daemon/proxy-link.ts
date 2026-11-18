// The daemon's side of the link to the separate proxy process
// (docs/proxy/specs/2026-11-18-proxy-outlives-the-daemon.md; the proxy's side
// is packages/cli/src/proxyd/host.ts).
//
// On start the daemon dials $HOBBY_HOME/proxy.sock. A proxy that answers with
// the same link protocol, the same code fingerprint and the same config key is
// adopted, and every session it holds stays up. Anything else is stopped and a
// new one spawned, which ends its sessions, and the log says so. Nothing
// answering means no proxy: one is spawned.
//
// Once linked, this answers the proxy's wakes with the daemon's own wake (the
// proxy asks, the engine acts) and mirrors its connections into the daemon's
// ActivityTracker, so the hibernator reads the same counts it always did.

import { spawn, type ChildProcess } from 'node:child_process'
import { closeSync, existsSync, openSync, readFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import net from 'node:net'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { HobbyError } from '@hobby.sh/core'
import type { ActivityTracker, ConnectionHandle } from '@hobby.sh/proxy'
import {
  onMessages,
  PROXY_LINK_PROTOCOL,
  proxyCodeFingerprint,
  proxyConfigKey,
  send,
  type ProxydConfig,
  type ProxyMessage,
} from '../proxyd/protocol.js'

type Hello = Extract<ProxyMessage, { t: 'hello' }>

// What the link needs from the daemon. A DaemonContext supplies all three in
// production (server.ts); tests supply fakes.
export interface ProxyLinkDaemonSide {
  wake(resourceId: string): Promise<void>
  activity: Pick<ActivityTracker, 'open' | 'close'>
  // WakeRefusal.retryAt (context.ts) after a failed wake, if one was recorded.
  refusalRetryAt(resourceId: string): number | null
}

export interface ProxyLink {
  port: number
  pid: number
  // How the proxy was found: adopted with its sessions, or newly started.
  adopted: boolean
  // Tell the proxy about a docker network gateway to listen on (issue #53).
  addGateway(host: string): void
  // From now on, wakes are answered "daemon leaving" so the proxy asks the
  // next daemon. Called at the start of a restart-safe shutdown.
  beginLeaving(): void
  // Close the link and leave the proxy running with its sessions.
  detach(): void
  // Ask the proxy to stop (ending its sessions) and wait for it to exit.
  stopProxy(): Promise<void>
  // Resolves when the link closes, for whatever reason.
  closed: Promise<void>
}

// Where the proxy process listens for its daemon.
export function proxySocketPath(home: string): string {
  return join(home, 'proxy.sock')
}

const DIAL_TIMEOUT_MS = 2000
const SPAWN_TIMEOUT_MS = 10_000
const STOP_TIMEOUT_MS = 10_000

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

interface Dialed {
  socket: net.Socket
  hello: Hello
  // Messages after the hello go here once attach() sets it.
  setHandler(handler: (message: ProxyMessage) => void): void
}

// Dial the control socket and read the hello. Null when nothing answers.
export function dialProxy(socketPath: string, timeoutMs: number = DIAL_TIMEOUT_MS): Promise<Dialed | null> {
  if (!existsSync(socketPath)) return Promise.resolve(null)
  return new Promise((resolve) => {
    const socket = net.createConnection(socketPath)
    let handler: ((message: ProxyMessage) => void) | null = null
    // Messages that arrive behind the hello (a wake the proxy was holding for
    // a daemon, often in the same chunk) wait here until attach sets a handler.
    const early: ProxyMessage[] = []
    let settled = false
    const finish = (value: Dialed | null): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (value === null) socket.destroy()
      resolve(value)
    }
    const timer = setTimeout(() => finish(null), timeoutMs)
    socket.on('error', () => finish(null))
    socket.on('close', () => finish(null))
    onMessages<ProxyMessage>(socket, (message) => {
      if (!settled) {
        if (message.t !== 'hello') return finish(null)
        return finish({
          socket,
          hello: message,
          setHandler: (h) => {
            handler = h
            for (const queued of early.splice(0)) h(queued)
          },
        })
      }
      if (handler === null) early.push(message)
      else handler(message)
    })
  })
}

// Wires a dialed proxy to the daemon. Exported for tests, which link a fake
// daemon side to a proxy host started in the same process.
export async function attachProxy(
  dialed: Dialed,
  daemon: ProxyLinkDaemonSide,
  adopted: boolean,
  log: (line: string) => void
): Promise<ProxyLink> {
  const { socket, hello } = dialed
  const handles = new Map<number, ConnectionHandle>()
  let leaving = false
  let detaching = false
  let markAttached: () => void = () => {}
  const attached = new Promise<void>((resolve) => {
    markAttached = resolve
  })

  dialed.setHandler((message) => {
    switch (message.t) {
      case 'attached':
        // Every session open at the moment this link took over, so the
        // hibernator does not sleep a database a session is using.
        for (const connection of message.live) {
          handles.set(connection.id, daemon.activity.open(connection.resourceId))
        }
        markAttached()
        return
      case 'open':
        handles.set(message.id, daemon.activity.open(message.resourceId))
        return
      case 'close': {
        const handle = handles.get(message.id)
        if (handle !== undefined) {
          handles.delete(message.id)
          daemon.activity.close(handle)
        }
        return
      }
      case 'wake': {
        const { req, resourceId } = message
        if (leaving) {
          send(socket, { t: 'wake_result', req, ok: false, leaving: true, message: 'the daemon is restarting' })
          return
        }
        daemon.wake(resourceId).then(
          () => send(socket, { t: 'wake_result', req, ok: true }),
          (err: unknown) =>
            send(socket, {
              t: 'wake_result',
              req,
              ok: false,
              message: errorMessage(err),
              ...(err instanceof HobbyError ? { code: err.code, ...(err.hint === undefined ? {} : { hint: err.hint }) } : {}),
              retryAt: daemon.refusalRetryAt(resourceId),
            })
        )
        return
      }
      case 'hello':
        return
    }
  })

  const closed = new Promise<void>((resolve) => {
    socket.on('close', () => {
      // The proxy's sessions are either gone (it exited) or no longer this
      // daemon's to count (it detached). Either way the counts it reported
      // must not hold resources awake in this daemon's tracker.
      for (const handle of handles.values()) daemon.activity.close(handle)
      handles.clear()
      if (!detaching) log(`proxy: the link to the proxy (pid ${hello.pid}) closed`)
      resolve()
    })
  })
  socket.on('error', () => {})

  send(socket, { t: 'attach' })
  await Promise.race([
    attached,
    closed,
    new Promise<void>((resolve) => setTimeout(resolve, DIAL_TIMEOUT_MS).unref()),
  ])

  return {
    port: hello.port,
    pid: hello.pid,
    adopted,
    addGateway: (host) => send(socket, { t: 'listen', host }),
    beginLeaving: () => {
      leaving = true
    },
    detach: () => {
      detaching = true
      socket.end()
    },
    stopProxy: async () => {
      detaching = true
      send(socket, { t: 'stop' })
      await Promise.race([closed, new Promise<void>((resolve) => setTimeout(resolve, STOP_TIMEOUT_MS).unref())])
      await waitForExit(hello.pid)
    },
    closed,
  }
}

async function waitForExit(pid: number): Promise<void> {
  if (pid === process.pid) return
  const deadline = Date.now() + STOP_TIMEOUT_MS
  while (isAlive(pid) && Date.now() < deadline) {
    await sleep(50)
  }
  if (isAlive(pid)) {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      // Gone between the check and the kill.
    }
  }
}

// The packaged entry point, relative to this compiled file
// (dist/src/daemon/proxy-link.js).
export function proxyEntryPath(): string {
  return join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'bin', 'hobby-proxy.js')
}

// Starts the proxy process under this process's own runtime (Bun in
// production), in its own session so neither a terminal hangup nor this
// daemon exiting reaches it, with its output appended to logPath.
export function spawnProxyProcess(config: ProxydConfig, logPath: string): ChildProcess {
  const fd = openSync(logPath, 'a', 0o600)
  try {
    const child = spawn(process.execPath, [proxyEntryPath()], {
      detached: true,
      stdio: ['ignore', fd, fd],
      env: { ...process.env, HOBBY_PROXYD_CONFIG: JSON.stringify(config) },
    })
    child.unref()
    return child
  } finally {
    closeSync(fd)
  }
}

function logTail(logPath: string, lines = 20): string {
  try {
    return readFileSync(logPath, 'utf8').trimEnd().split('\n').slice(-lines).join('\n')
  } catch {
    return ''
  }
}

export async function adoptOrStartProxy(opts: {
  config: ProxydConfig
  logPath: string
  daemon: ProxyLinkDaemonSide
  log?: (line: string) => void
  // Tests: what to compare the running proxy's hello against.
  fingerprint?: string
  // Tests: start the proxy some other way. Returns a promise that settles if
  // it exits before linking (with its exit code), never otherwise.
  spawn?: (config: ProxydConfig) => Promise<number | null>
  // Called when a proxy this call spawned exits, whenever that is (before
  // linking or long after), with its exit code or the signal that ended it.
  // The supervisor (proxy-supervisor.ts) logs it as the reason for a respawn.
  onExit?: (pid: number, code: number | null, signal: NodeJS.Signals | null) => void
}): Promise<ProxyLink> {
  const log = opts.log ?? ((line: string) => console.error(line))
  const fingerprint = opts.fingerprint ?? proxyCodeFingerprint()
  const configKey = proxyConfigKey(opts.config)

  const existing = await dialProxy(opts.config.socketPath)
  if (existing !== null) {
    const { hello } = existing
    const reasons: string[] = []
    if (hello.protocol !== PROXY_LINK_PROTOCOL) reasons.push(`it speaks link protocol ${hello.protocol}, not ${PROXY_LINK_PROTOCOL}`)
    if (hello.fingerprint !== fingerprint) reasons.push('its code changed (an upgrade)')
    if (hello.configKey !== configKey) reasons.push('its settings changed (port, bind address, wake timeout or TLS files)')
    if (reasons.length === 0) {
      const sessions = hello.live.length
      log(`proxy: adopted the running proxy (pid ${hello.pid}) with ${sessions} open session${sessions === 1 ? '' : 's'}`)
      return attachProxy(existing, opts.daemon, true, log)
    }
    const sessions = hello.live.length
    log(
      `proxy: restarting the proxy (pid ${hello.pid}) because ${reasons.join(' and ')}; this ends ${sessions} open session${sessions === 1 ? '' : 's'}`
    )
    const old = await attachProxy(existing, { ...opts.daemon, activity: { open: (r) => ({ resourceId: r, id: 0 }), close: () => {} } }, false, log)
    await old.stopProxy()
  }

  await rm(opts.config.socketPath, { force: true })
  const exited =
    opts.spawn?.(opts.config) ??
    new Promise<number | null>((resolve) => {
      const child = spawnProxyProcess(opts.config, opts.logPath)
      child.once('exit', (code, signal) => {
        if (child.pid !== undefined) opts.onExit?.(child.pid, code, signal)
        resolve(code)
      })
      child.once('error', () => resolve(null))
    })
  let early: number | null | undefined
  void exited.then((code) => {
    early = code
  })

  const deadline = Date.now() + SPAWN_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (early !== undefined) break
    const dialed = await dialProxy(opts.config.socketPath, 500)
    if (dialed !== null) {
      log(`proxy: started the proxy (pid ${dialed.hello.pid}), log at ${opts.logPath}`)
      return attachProxy(dialed, opts.daemon, false, log)
    }
    await sleep(50)
  }
  const tail = logTail(opts.logPath)
  throw new HobbyError(
    'internal',
    early !== undefined
      ? `the proxy process exited (code ${early}) before it was ready`
      : `the proxy process did not answer within ${SPAWN_TIMEOUT_MS / 1000}s`,
    tail === '' ? `its log is ${opts.logPath}` : `the end of ${opts.logPath}:\n${tail}`
  )
}
