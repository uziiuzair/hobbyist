// Keeps the separate proxy process running for as long as the daemon is.
//
// Before the proxy became its own process
// (docs/proxy/specs/2026-11-18-proxy-outlives-the-daemon.md), a proxy crash was
// a daemon crash, and the service manager (Restart=on-failure in
// scripts/hobby.service) brought both back. Split out, a dead proxy leaves the
// daemon running with every database unreachable. This closes that gap: when
// the link to the proxy closes and the daemon did not ask for it, the
// supervisor finds out whether the proxy process is gone and, if it is,
// spawns a new one with the same settings and links to it.
//
//   link closed, pid gone     respawn (adoptOrStartProxy, which dials first,
//                             so a proxy that somehow answers is adopted, not
//                             doubled), after a backoff.
//   link closed, pid alive    re-dial and re-attach the same proxy. If it does
//                             not answer, it is stopped (SIGTERM, then
//                             SIGKILL) so its port frees, then respawned.
//
// Backoff: 0.5 s, 1 s, 2 s ... capped, counted over consecutive fast crashes
// (a proxy that stayed up for stableMs resets the count). After
// maxFastCrashes in a row it stops trying, logs it loudly, and health() says
// `failed`, which GET /v1/health and `hobby init` report.
//
// Races it rules out:
//   - two proxies on one port: a respawn starts only once the old pid is
//     gone (or has been killed), and adoptOrStartProxy dials before it spawns;
//   - a respawn during shutdown: beginShutdown() cancels a pending backoff and
//     no new attempt starts after it; one already in flight finishes, and
//     detach() / stopProxy() then act on the proxy it brought up;
//   - a respawn racing adoptOrStartProxy at startup: supervision begins only
//     once the first link exists, from the same call.

import { HobbyError } from '@hobby.sh/core'
import {
  adoptOrStartProxy,
  attachProxy,
  dialProxy,
  isAlive,
  type ProxyLink,
  type ProxyLinkDaemonSide,
} from './proxy-link.js'
import type { ProxydConfig } from '../proxyd/protocol.js'

export type ProxySupervisorState = 'up' | 'recovering' | 'failed'

// What GET /v1/health and `hobby init` show about the proxy process.
export interface ProxyHealth {
  state: ProxySupervisorState
  pid: number | null
  port: number
  // Respawns (and re-attaches) since this daemon started.
  restarts: number
  // Losses in a row that came before the proxy had stayed up stableMs.
  consecutiveFastCrashes: number
  lastLoss: { at: string; reason: string } | null
}

export interface ProxyBackoff {
  baseMs: number
  maxMs: number
  // Up this long, a proxy's next loss starts the count again.
  stableMs: number
  // Fast losses in a row after which the supervisor gives up.
  maxFastCrashes: number
  // How long a link close waits for a dying proxy to be reaped before it is
  // treated as "closed with the process alive".
  reapGraceMs: number
}

export const DEFAULT_PROXY_BACKOFF: ProxyBackoff = {
  baseMs: 500,
  maxMs: 30_000,
  stableMs: 60_000,
  maxFastCrashes: 5,
  reapGraceMs: 1000,
}

// How long a proxy that is alive but not answering is given to exit after
// SIGTERM before SIGKILL.
const UNRESPONSIVE_TERM_MS = 3000
const REDIAL_ATTEMPTS = 3
const REDIAL_PAUSE_MS = 200

export interface SupervisedProxy {
  readonly port: number
  // How the first proxy was found: adopted with its sessions, or started.
  readonly adopted: boolean
  pid(): number | null
  addGateway(host: string): void
  // From now on no respawn starts. Called first thing in a daemon shutdown,
  // before beginLeaving / detach / stopProxy.
  beginShutdown(): void
  beginLeaving(): void
  detach(): void
  stopProxy(): Promise<void>
  health(): ProxyHealth
  // Tests: resolves once no recovery is in flight.
  idle(): Promise<void>
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function describeExit(code: number | null, signal: NodeJS.Signals | null): string {
  if (signal !== null) return `killed by ${signal}`
  return `exit code ${code ?? 'unknown'}`
}

async function waitGone(pid: number, ms: number): Promise<boolean> {
  if (pid === process.pid) return false
  const deadline = Date.now() + ms
  while (isAlive(pid)) {
    if (Date.now() >= deadline) return false
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  return true
}

export async function superviseProxy(opts: {
  config: ProxydConfig
  logPath: string
  daemon: ProxyLinkDaemonSide
  log?: (line: string) => void
  fingerprint?: string
  spawn?: (config: ProxydConfig) => Promise<number | null>
  backoff?: Partial<ProxyBackoff>
}): Promise<SupervisedProxy> {
  const log = opts.log ?? ((line: string) => console.error(line))
  const backoff: ProxyBackoff = { ...DEFAULT_PROXY_BACKOFF, ...opts.backoff }
  // Exit reasons of proxies this daemon spawned, by pid. A proxy adopted from
  // an earlier daemon is not this process's child, so its exit is not seen.
  const exits = new Map<number, string>()
  const start = (): Promise<ProxyLink> =>
    adoptOrStartProxy({
      config: opts.config,
      logPath: opts.logPath,
      daemon: opts.daemon,
      log,
      ...(opts.fingerprint === undefined ? {} : { fingerprint: opts.fingerprint }),
      ...(opts.spawn === undefined ? {} : { spawn: opts.spawn }),
      onExit: (pid, code, signal) => {
        exits.set(pid, describeExit(code, signal))
      },
    })

  const first = await start()
  let link: ProxyLink | null = first
  let port = first.port
  let upSince = Date.now()
  let shuttingDown = false
  let leaving = false
  let state: ProxySupervisorState = 'up'
  let restarts = 0
  let fastCrashes = 0
  let lastLoss: ProxyHealth['lastLoss'] = null
  let recovery: Promise<void> | null = null
  let cancelWait: (() => void) | null = null
  const gateways: string[] = []

  const relink = (next: ProxyLink): void => {
    link = next
    port = next.port
    upSince = Date.now()
    state = 'up'
    for (const gateway of gateways) next.addGateway(gateway)
    if (leaving) next.beginLeaving()
    watch(next)
  }

  const pause = (ms: number): Promise<void> =>
    new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        cancelWait = null
        resolve()
      }, ms)
      cancelWait = () => {
        clearTimeout(timer)
        cancelWait = null
        resolve()
      }
    })

  // The same proxy, still running, with a link that closed under it.
  const reattach = async (pid: number): Promise<boolean> => {
    for (let attempt = 0; attempt < REDIAL_ATTEMPTS && !shuttingDown; attempt++) {
      const dialed = await dialProxy(opts.config.socketPath)
      if (dialed !== null && dialed.hello.pid === pid) {
        relink(await attachProxy(dialed, opts.daemon, true, log))
        restarts++
        log(`proxy: the link to the proxy (pid ${pid}) closed with the process still running; re-attached`)
        return true
      }
      dialed?.socket.destroy()
      await pause(REDIAL_PAUSE_MS)
    }
    return false
  }

  const recover = async (lost: ProxyLink): Promise<void> => {
    const uptime = Date.now() - upSince
    const pid = lost.pid
    state = 'recovering'
    let reason: string
    if (await waitGone(pid, backoff.reapGraceMs)) {
      reason = exits.get(pid) ?? 'exit reason unknown: it was adopted from an earlier daemon, so not a child of this daemon'
    } else {
      if (await reattach(pid)) return
      if (shuttingDown) return
      // Alive, holding the port, and not answering: stop it so a new one can
      // bind. Never a second proxy beside it.
      log(`proxy: the proxy (pid ${pid}) is running but does not answer on ${opts.config.socketPath}; stopping it to start a new one`)
      if (pid !== process.pid) {
        try {
          process.kill(pid, 'SIGTERM')
        } catch {
          // Gone already.
        }
        if (!(await waitGone(pid, UNRESPONSIVE_TERM_MS))) {
          try {
            process.kill(pid, 'SIGKILL')
          } catch {
            // Gone between the check and the kill.
          }
          await waitGone(pid, UNRESPONSIVE_TERM_MS)
        }
      }
      reason = 'it stopped answering its control socket'
    }
    lastLoss = { at: new Date().toISOString(), reason }
    if (uptime >= backoff.stableMs) fastCrashes = 0
    fastCrashes++

    while (!shuttingDown) {
      if (fastCrashes > backoff.maxFastCrashes) {
        state = 'failed'
        log(
          `proxy: GIVING UP. The proxy has failed ${fastCrashes - 1} times in a row within ${Math.round(backoff.stableMs / 1000)}s of starting ` +
            `(last: ${lastLoss.reason}). Every database is unreachable until it runs. Its log is ${opts.logPath}; ` +
            'fix the cause, then restart the daemon (`hobby daemon stop`, then start it again, or `systemctl restart hobby`).'
        )
        return
      }
      const delay = Math.min(backoff.baseMs * 2 ** (fastCrashes - 1), backoff.maxMs)
      const what = lastLoss.reason === reason ? `the proxy (pid ${pid}) is gone (${reason})` : 'that attempt failed'
      log(`proxy: ${what}; starting a new one in ${delay / 1000}s (attempt ${fastCrashes} of ${backoff.maxFastCrashes})`)
      await pause(delay)
      if (shuttingDown) return
      try {
        const next = await start()
        relink(next)
        restarts++
        log(`proxy: restarted the proxy (pid ${next.pid}, port ${next.port}); the one before it (pid ${pid}) was lost: ${lastLoss.reason}`)
        return
      } catch (err) {
        // The last line of the proxy's log is usually why (its "could not
        // start: ..." line); adoptOrStartProxy puts the log's end in the hint.
        const last = err instanceof HobbyError ? err.hint?.split('\n').filter((line) => line.trim() !== '').at(-1) : undefined
        const why = last === undefined || last.startsWith('its log is') ? errorMessage(err) : `${errorMessage(err)}: ${last.trim()}`
        lastLoss = { at: new Date().toISOString(), reason: `a new proxy did not start: ${why}` }
        log(`proxy: ${lastLoss.reason}`)
        fastCrashes++
      }
    }
  }

  function watch(current: ProxyLink): void {
    void current.closed.then(() => {
      if (link !== current || shuttingDown) return
      link = null
      recovery = recover(current)
        .catch((err: unknown) => {
          state = 'failed'
          log(`proxy: GIVING UP after an unexpected error while restarting the proxy: ${errorMessage(err)}`)
        })
        .finally(() => {
          recovery = null
        })
    })
  }
  watch(first)

  return {
    get port() {
      return port
    },
    adopted: first.adopted,
    pid: () => link?.pid ?? null,
    addGateway: (host) => {
      if (!gateways.includes(host)) gateways.push(host)
      link?.addGateway(host)
    },
    beginShutdown: () => {
      shuttingDown = true
      cancelWait?.()
    },
    beginLeaving: () => {
      leaving = true
      link?.beginLeaving()
    },
    detach: () => {
      shuttingDown = true
      cancelWait?.()
      if (recovery === null) link?.detach()
      else void recovery.then(() => link?.detach())
    },
    stopProxy: async () => {
      shuttingDown = true
      cancelWait?.()
      if (recovery !== null) await recovery
      await link?.stopProxy()
    },
    health: () => ({
      state,
      pid: link?.pid ?? null,
      port,
      restarts,
      consecutiveFastCrashes: uptimeResets(),
      lastLoss,
    }),
    idle: async () => {
      while (recovery !== null) await recovery
    },
  }

  // A count that has outlived stableMs of uptime is history, not a loop.
  function uptimeResets(): number {
    return state === 'up' && Date.now() - upSince >= backoff.stableMs ? 0 : fastCrashes
  }
}
