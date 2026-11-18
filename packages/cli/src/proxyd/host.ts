// The proxy process: the wake-on-connect proxy with no daemon inside it.
//
// It runs startPgProxy exactly as the daemon did, against a ProxyDeps whose
// members are answered here rather than by a DaemonContext
// (docs/proxy/specs/2026-11-18-proxy-outlives-the-daemon.md, the table):
//
//   resolve, allowlist  resolveProxyTarget and allowlistOf, the daemon's own
//                       code, against state.db opened read-only. They work
//                       while the daemon is down.
//   wake                a request on the link, answered by the daemon's
//                       getOrCreateWake. With no daemon linked it waits for
//                       one, bounded by the connection's wake timeout.
//   isWakeRefused       a cache of the refusals failed wakes reported.
//   activity            counted here and reported on the link, with a
//                       snapshot of live connections to each new daemon.
//
// The proxy asks, the engine acts: nothing here touches Docker or writes the
// store.

import { existsSync } from 'node:fs'
import { chmod, rm } from 'node:fs/promises'
import net from 'node:net'
import { HobbyError, openStoreReadOnly, type StoreReader } from '@hobby.sh/core'
import {
  defaultSameBox,
  RefusalLimiter,
  refusalLogLine,
  startPgProxy,
  type ConnectionHandle,
  type ProxyActivity,
  type ProxyDeps,
} from '@hobby.sh/proxy'
import { allowlistOf, resolveProxyTarget } from '../daemon/proxy-resolve.js'
import {
  onMessages,
  PROXY_LINK_PROTOCOL,
  proxyConfigKey,
  proxyCodeFingerprint,
  send,
  SOCKET_MODE,
  type DaemonMessage,
  type LiveConnection,
  type ProxydConfig,
} from './protocol.js'

export interface ProxyHost {
  port: number
  // Whether a daemon is linked right now. Tests only.
  linked(): boolean
  // Closes every listener (ending its sessions), the link and the control
  // socket. What `stop` from the daemon and SIGTERM to this process run.
  stop(): Promise<void>
  // Resolves once stop() has finished, whoever called it.
  stopped: Promise<void>
}

interface PendingWake {
  resourceId: string
  resolve(): void
  reject(err: Error): void
  // Sent to the daemon currently linked. Cleared when that link drops or the
  // daemon answers that it is leaving, so the next daemon is asked.
  sent: boolean
  timer: NodeJS.Timeout
}

// How much sooner than the connection's own wake timeout a wake that never
// reached a daemon gives up, so the client is told the daemon is down rather
// than the generic "wake timed out" proxy.ts's race would say a moment later.
const NO_DAEMON_MARGIN_MS = 50

// How long stop() waits for listeners to finish closing before giving up on
// sessions that will not end by themselves.
const CLOSE_GRACE_MS = 1000

export async function startProxyHost(
  config: ProxydConfig,
  opts: {
    log?: (line: string) => void
    // Tests: a fixed fingerprint instead of hashing the compiled files.
    fingerprint?: string
    // Tests: called after stop() finishes. main.ts exits the process here.
    onStopped?: () => void
  } = {}
): Promise<ProxyHost> {
  const log = opts.log ?? ((line: string) => console.error(`${new Date().toISOString()} proxy: ${line}`))
  const fingerprint = opts.fingerprint ?? proxyCodeFingerprint()
  const configKey = proxyConfigKey(config)

  let store: StoreReader | null = null
  const reader = (): StoreReader => {
    // Opened on first use rather than at start, so a proxy started before the
    // daemon ever created state.db (only possible in tests) still starts.
    store ??= openStoreReadOnly(config.statePath)
    return store
  }

  let link: net.Socket | null = null
  let stopping = false

  // Activity: the live set, and the events.
  const live = new Map<number, string>()
  let nextConnectionId = 0
  const activity: ProxyActivity = {
    open(resourceId: string): ConnectionHandle {
      const id = ++nextConnectionId
      live.set(id, resourceId)
      if (link !== null) send(link, { t: 'open', id, resourceId })
      return { resourceId, id }
    },
    close(handle: ConnectionHandle): void {
      if (!live.delete(handle.id)) return
      if (link !== null) send(link, { t: 'close', id: handle.id })
    },
  }

  // Wakes.
  const pending = new Map<number, PendingWake>()
  let nextRequest = 0
  const refusedUntil = new Map<string, number>()

  const sendPending = (): void => {
    if (link === null) return
    for (const [req, wake] of pending) {
      if (!wake.sent) {
        wake.sent = true
        send(link, { t: 'wake', req, resourceId: wake.resourceId })
      }
    }
  }

  const wake = (resourceId: string): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      const req = ++nextRequest
      const timer = setTimeout(
        () => {
          const entry = pending.get(req)
          if (entry === undefined) return
          pending.delete(req)
          entry.reject(
            entry.sent
              ? new Error(`wake timed out after ${config.wakeTimeoutMs}ms`)
              : new HobbyError(
                  'wake_timeout',
                  'the hobby daemon is not running, so nothing could wake this database',
                  'start it with `hobby daemon`; databases that are already awake keep working meanwhile'
                )
          )
        },
        Math.max(config.wakeTimeoutMs - NO_DAEMON_MARGIN_MS, 1)
      )
      pending.set(req, { resourceId, resolve, reject, sent: false, timer })
      if (link === null) {
        log(`wake of ${resourceId} is waiting for the daemon`)
      }
      sendPending()
    })

  const onDaemonMessage = (message: DaemonMessage): void => {
    switch (message.t) {
      case 'wake_result': {
        const entry = pending.get(message.req)
        if (entry === undefined) return
        if (!message.ok && message.leaving === true) {
          // Asked again of the next daemon, when one links.
          entry.sent = false
          return
        }
        pending.delete(message.req)
        clearTimeout(entry.timer)
        if (message.ok) {
          refusedUntil.delete(entry.resourceId)
          entry.resolve()
          return
        }
        if (typeof message.retryAt === 'number') refusedUntil.set(entry.resourceId, message.retryAt)
        entry.reject(new HobbyError((message.code ?? 'wake_failed') as never, message.message, message.hint))
        return
      }
      case 'attach':
        return
      case 'listen':
        void listenOnGateway(message.host)
        return
      case 'stop':
        log('the daemon asked this proxy to stop')
        void stop()
        return
    }
  }

  // Listeners.
  const gateways = new Set<string>()
  const sameBox = (local: string | undefined, peer: string | undefined): boolean =>
    defaultSameBox(local, peer) || (local !== undefined && gateways.has(local.replace(/^::ffff:/, '')))

  const deps: ProxyDeps = {
    resolve: async (project, database) => resolveProxyTarget(reader(), project, database),
    wake,
    isWakeRefused: (resourceId) => {
      const until = refusedUntil.get(resourceId)
      return until !== undefined && Date.now() < until
    },
    allowlist: (project) => allowlistOf(reader(), project),
    onAccessRefused: (() => {
      const limiter = new RefusalLimiter()
      return (refusal) => {
        const verdict = limiter.admit(refusal.address ?? '(unknown)')
        if (verdict.log) log(refusalLogLine(refusal, verdict.key, verdict.suppressed))
      }
    })(),
    activity,
  }

  const proxies: Array<{ port: number; close: () => Promise<void> }> = []
  const bound = new Set<string>()
  const listenOn = async (host: string, local: boolean): Promise<void> => {
    if (bound.has(host)) return
    bound.add(host)
    try {
      proxies.push(
        await startPgProxy({
          port: proxies[0]?.port ?? config.port,
          host,
          deps,
          wakeTimeoutMs: config.wakeTimeoutMs,
          sameBox,
          ...(config.tls === null ? {} : { tls: config.tls }),
          ...(local ? { plaintextAllowed: () => true } : {}),
        })
      )
    } catch (err) {
      bound.delete(host)
      throw err
    }
  }
  const listenOnGateway = async (host: string): Promise<void> => {
    gateways.add(host)
    if (config.hosts.includes('0.0.0.0')) return
    try {
      await listenOn(host, true)
    } catch (err) {
      log(
        `could not listen on docker gateway ${host}, apps in that project may not reach their database: ${err instanceof Error ? err.message : String(err)}`
      )
    }
  }

  for (const host of config.hosts) {
    await listenOn(host, false)
  }
  const port = proxies[0]?.port ?? config.port

  // The control socket. One daemon at a time: a new link replaces an old
  // one, since only the holder of the daemon lock ever dials.
  if (existsSync(config.socketPath)) {
    await rm(config.socketPath, { force: true })
  }
  const becomeLink = (socket: net.Socket): void => {
    if (link === socket) return
    if (link !== null) {
      log('a new daemon attached; dropping the previous link')
      link.destroy()
    }
    link = socket
    // A new daemon has an empty refusal map (a restart clears refusals).
    refusedUntil.clear()
    const snapshot: LiveConnection[] = [...live].map(([id, resourceId]) => ({ id, resourceId }))
    send(socket, { t: 'attached', live: snapshot })
    log(`daemon attached (${snapshot.length} open session${snapshot.length === 1 ? '' : 's'})`)
    sendPending()
  }

  const control = net.createServer((socket) => {
    send(socket, {
      t: 'hello',
      protocol: PROXY_LINK_PROTOCOL,
      fingerprint,
      configKey,
      pid: process.pid,
      port,
      live: [...live].map(([id, resourceId]) => ({ id, resourceId })),
    })
    onMessages<DaemonMessage>(socket, (message) => {
      if (message.t === 'attach') {
        becomeLink(socket)
        return
      }
      // A probe that never attached may look, not act.
      if (socket !== link) return
      onDaemonMessage(message)
    })
    socket.on('error', () => {})
    socket.on('close', () => {
      if (link !== socket) return
      link = null
      // Every wake the departed daemon was handling is asked again of the
      // next one. A wake is idempotent on the daemon side (getOrCreateWake).
      for (const entry of pending.values()) entry.sent = false
      if (!stopping) log('daemon link closed; open sessions stay up, wakes wait for the next daemon')
    })
  })
  await new Promise<void>((resolve, reject) => {
    control.once('error', reject)
    control.listen(config.socketPath, () => {
      control.off('error', reject)
      control.on('error', () => {})
      resolve()
    })
  })
  // Owner-only, the mode the daemon gives hobby.sock: whoever can dial this
  // socket can stop the proxy or answer its wakes.
  await chmod(config.socketPath, SOCKET_MODE)

  let markStopped: () => void = () => {}
  const stopped = new Promise<void>((resolve) => {
    markStopped = resolve
  })
  let stopPromise: Promise<void> | null = null
  const stop = (): Promise<void> => {
    stopPromise ??= (async () => {
      stopping = true
      for (const entry of pending.values()) {
        clearTimeout(entry.timer)
        entry.reject(new Error('the proxy is stopping'))
      }
      pending.clear()
      // Stops accepting new links at once; its callback waits for the open
      // link, which is destroyed below, so it is awaited last.
      const controlClosed = new Promise<void>((resolve) => control.close(() => resolve()))
      // close() stops accepting at once and ends serverless sessions, but its
      // promise waits for every spliced TCP session to end, which a psql left
      // open never does. So it is given a moment, and then the process exit
      // that follows (main.ts) is what ends those sessions. The link closes
      // last, so the daemon sees the proxy gone only once nothing is accepted.
      await Promise.race([
        Promise.all(proxies.map((p) => p.close().catch(() => {}))),
        new Promise<void>((resolve) => setTimeout(resolve, CLOSE_GRACE_MS).unref()),
      ])
      ;(link as net.Socket | null)?.destroy()
      await controlClosed
      await rm(config.socketPath, { force: true }).catch(() => {})
      store?.close()
      log('stopped')
      markStopped()
      opts.onStopped?.()
    })()
    return stopPromise
  }

  log(`listening on ${config.hosts.join(', ')} port ${port}, pid ${process.pid}`)

  return { port, linked: () => link !== null, stop, stopped }
}
