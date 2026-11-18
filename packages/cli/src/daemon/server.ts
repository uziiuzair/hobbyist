// Two control-plane listeners, one handler. A unix socket for the CLI and
// MCP (filesystem permissions are the authentication, see docs/cli/CLAUDE.md),
// and an optional loopback TCP port for Studio once it exists. Neither
// listener does anything a request handler couldn't: createApp is the single
// function both are built from, so there is exactly one place routing and
// error handling can live, never two copies that can drift.
//
// startDaemon also starts the two pieces that make the product's defining
// feature real: the wake-on-connect proxy (packages/proxy, the keystone
// component, see root CLAUDE.md) and the hibernator (hibernator.ts, the
// sleep half of that same pair). Both are bound to this same DaemonContext,
// both are torn down as part of this file's own shutdown sequence, and the
// order that teardown happens in is deliberate: see performShutdown below.

import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { chmod, rm } from 'node:fs/promises'
import http, { type IncomingMessage, type ServerResponse } from 'node:http'
import net from 'node:net'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { assertSocketPathFits, HobbyError, type ProxyTlsConfig, type Resource } from '@hobby.sh/core'
import { startAlarmMirror } from '@hobby.sh/do'
import { defaultSameBox, startHttpRouter, startPgProxy, TLS_ASK_PATH, type ProxyTlsFiles } from '@hobby.sh/proxy'
import { startQueueTick } from '@hobby.sh/queue'
import { durableObjectNamespaces } from './alarms.js'
import { cronState, postScheduled, scheduledWorkers, startCronScheduler } from './crons.js'
import { createCaddyManager, type CaddyManager } from './caddy.js'
import { createHttpProxyDeps, createProxyDeps, getOrCreateWake, getWakeRefusal, type DaemonContext } from './context.js'
import { proxySocketPath } from './proxy-link.js'
import { onSigterm } from './restart-request.js'
import { superviseProxy, type ProxyBackoff, type SupervisedProxy } from './proxy-supervisor.js'
import { SOCKET_MODE, type ProxydConfig } from '../proxyd/protocol.js'
import { startExpirySweeper } from './expiry.js'
import { startHibernator } from './hibernator.js'
import { startQueueEndpoint } from './queue-endpoint.js'
import { drainableQueues, queueDeliverFn, queueStateOf, retentionTargets } from './queues.js'
import { deleteProject, handleRequest } from './routes.js'
import { createStudioApp } from './studio/routes.js'
import { resolveProxyHosts } from './proxy-hosts.js'

const execFileAsync = promisify(execFile)

// How often the hibernator re-checks every resource for a sleep candidate.
// docs/hibernation/CLAUDE.md cites Xata's CNPG sidecar polling once a minute
// as the cost envelope to stay inside; this is tighter than that so a short
// sleepAfterSeconds (a developer testing the feature, e.g.) does not sit up
// to a full extra minute past its own threshold, while still being far from
// a meaningful load on a single box (the hibernator's own tick is in-memory
// ActivityTracker reads for every resource that is not already a sleep
// candidate, and only one real Postgres round trip for the ones that are).
const HIBERNATION_TICK_MS = 10_000
// Branch expiry is measured in hours and days, so a minute late is nothing,
// and a sweep that only reads the store costs nothing either.
const EXPIRY_SWEEP_MS = 60_000

// How often the alarm mirror re-reads pending Durable Object deadlines.
//
// Matched to the hibernation tick on purpose. The mirror's cost is one
// read-only sqlite query per namespace of a SLEEPING worker, which is cheap,
// but the number that matters is lateness: an alarm can fire at most one tick
// after its deadline, so this is the worst-case delay a user sees on a
// scheduled task. Ten seconds is well inside what a cron-shaped workload
// tolerates and is the same order as the cold start that follows it anyway.
//
// It is deliberately not shorter than the guard's grace window
// (DEFAULT_WAKE_GRACE_SECONDS in @hobby.sh/do), so a worker is never slept by
// one loop moments before being woken by the other.
const ALARM_MIRROR_TICK_MS = 10_000

// How often the queue tick checks every drainable queue for a ready batch.
// docs/queues/specs/2026-08-13-queues-design.md's own "The tick" section
// names 250ms; unlike the alarm mirror, this loop's lateness is on the
// project's own keystone budget (root CLAUDE.md's "under 1 second target,
// 3 second hard ceiling" for a cold start), not a cron-shaped tolerance, so
// it runs far more often than the ten-second hibernation and alarm ticks.
const QUEUE_TICK_MS = 250

// How long to wait for a connection attempt against a possibly-stale socket
// file before assuming nothing is listening. Generous enough that a real,
// merely slow-to-accept daemon is never mistaken for a dead one, short
// enough that a genuinely stale file does not stall startup.
const SOCKET_PROBE_TIMEOUT_MS = 500

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

// A fast index for the enqueue listener's own authenticate() to consult
// first (packages/cli/src/daemon/queue-endpoint.ts): token -> resourceId, or
// null. Deliberately a plain linear scan rather than a maintained map: that
// file's own comment is explicit that this is not the last word on
// authentication ("even a tokenFor backed by a naive linear scan cannot turn
// into a wrong resource being authenticated"), the actual pass/fail decision
// is a constant-time compare against the store's own record, done inside
// that file. A worker count in the tens to low hundreds on one box makes a
// maintained index not worth the invalidation surface a rename, redeploy or
// token rotation would each need to keep correct.
function queueTokenFor(ctx: DaemonContext): (token: string) => string | null {
  return (token: string): string | null => {
    for (const resource of ctx.store.listResources()) {
      if (resource.kind === 'worker' && resource.config.queueToken === token) {
        return resource.id
      }
    }
    return null
  }
}

// Which addresses the enqueue listener binds, decided once at daemon start.
// Always loopback: on macOS (Docker Desktop, OrbStack) `host.docker.internal`
// and `host.orb.internal` both proxy to the host's own loopback, verified in
// docs/queues/research/2026-08-13-miniflare-queues-are-in-memory.md's own
// transport probes.
//
// On Linux that same hostname resolves via `--add-host=host.docker.internal:
// host-gateway` to the BRIDGE GATEWAY of whichever network a container is
// attached to (docs/queues/research/2026-08-13-miniflare-queues-are-in-memory.md,
// "3. How does a container reach the daemon on the host?"), which a socket
// bound only to 127.0.0.1 never sees. Every project gets its own docker
// network (Project.networkName), so this asks docker directly for each one's
// own gateway rather than guessing a single shared address.
//
// A best-effort snapshot taken once at startup, not re-read per project
// created afterward: a project created while the daemon is already running
// gets its network's gateway added only on the next daemon restart. Recorded
// here rather than hidden, because docs/queues/specs/2026-08-13-queues-design.md's
// own milestone table already marks the Linux gateway bind as owed, not
// closed, and a daemon that silently only ever bound loopback on Linux would
// look like it worked right up until the first real container tried to send.
// resolveProxyHosts (ADR 0017) moved to proxy-hosts.ts (issue #108) so preflight can run
// the same resolution startDaemon does. Re-exported for its existing callers.
export { resolveProxyHosts }

// ADR 0019. Refuses a half-configured proxyTls rather than starting without
// TLS: an operator who set two of the three variables meant to have TLS, and
// a daemon that quietly serves plaintext instead is the failure this whole
// setting exists to prevent. A missing or unreadable file fails later, in
// startPgProxy, with the filesystem's own error, before the port is bound.
export function proxyTlsFiles(tls: ProxyTlsConfig | null): ProxyTlsFiles | undefined {
  if (tls === null) return undefined
  const missing = (['certFile', 'keyFile', 'hostname'] as const).filter((k) => tls[k].trim() === '')
  if (missing.length > 0) {
    throw new HobbyError(
      'usage',
      `proxyTls is missing ${missing.join(', ')}`,
      'Set all three (HOBBY_PROXY_TLS_CERT, HOBBY_PROXY_TLS_KEY, HOBBY_PROXY_TLS_HOSTNAME), or none.'
    )
  }
  return { certFile: tls.certFile, keyFile: tls.keyFile }
}

// The bridge gateway of a docker network, or null if it has none or docker
// cannot be asked. Shared by the startup snapshot and the per-project hook so
// both agree on what "the gateway" means.
async function networkGateway(name: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('docker', [
      'network',
      'inspect',
      name,
      '--format',
      '{{range .IPAM.Config}}{{.Gateway}}{{end}}',
    ])
    const gateway = stdout.trim()
    return gateway.length > 0 ? gateway : null
  } catch {
    return null
  }
}

// The bridge gateways of every project network on this box, Linux only. The
// wake-on-connect proxy binds these too (#53), so an app's DATABASE_URL by
// host.docker.internal reaches it; see queueEndpointHosts for the longer
// account of why the gateway is the address.
async function proxyGatewayHosts(ctx: DaemonContext): Promise<string[]> {
  return (await queueEndpointHosts(ctx)).filter((host) => host !== '127.0.0.1')
}

async function queueEndpointHosts(ctx: DaemonContext): Promise<string[]> {
  const hosts = new Set<string>(['127.0.0.1'])
  if (process.platform !== 'linux') {
    return [...hosts]
  }

  // The address `--add-host=host.docker.internal:host-gateway` actually
  // writes into a container's /etc/hosts. Docker resolves host-gateway to the
  // default bridge's gateway (docker0, usually 172.17.0.1) or to the daemon's
  // configured host-gateway-ip, NOT to the gateway of the network the
  // container is attached to. The 2026-08-22 Linux research note measured
  // 172.17.0.1 for a container on the default network and assumed a project
  // container would see its own gateway instead; the first CI smoke run on
  // ubuntu-latest (2026-11-17) showed a producer on hobby-<project>
  // (gateway 172.19.0.1) failing with "Network connection lost" because the
  // daemon was bound only to loopback and 172.19.0.1. Binding the default
  // bridge gateway too is what makes host.docker.internal reach this
  // listener. A daemon.json host-gateway-ip set to something else is not
  // read here; that is a documented gap, not a silent one.
  const bridge = await networkGateway('bridge')
  if (bridge !== null) {
    hosts.add(bridge)
  } else {
    console.error(
      'daemon: could not read the default docker bridge gateway; containers reaching the host as host.docker.internal may not reach the queue endpoint or the proxy'
    )
  }

  for (const project of ctx.store.listProjects()) {
    try {
      const gateway = await networkGateway(project.networkName)
      if (gateway !== null) {
        hosts.add(gateway)
      }
    } catch (err) {
      // Best-effort: a project whose network has not been created yet (no
      // resource in it has ever started), or a docker CLI failure, must not
      // stop the daemon from starting. Queue delivery from that project's
      // containers may simply not reach this listener until the network
      // exists and the daemon is restarted.
      console.error(
        `daemon: could not read the docker network gateway for project ${project.name}, queue sends from its containers may not reach the enqueue listener: ${errorMessage(err)}`
      )
    }
  }

  return [...hosts]
}

// This repo's standing convention, decision hobbyist.bound-every-outbound-
// call: every call that leaves the process is bounded by a timeout, not a
// try/catch, because a hang is not a throw. preflight.ts's own withTimeout
// (packages/cli/src/daemon/preflight.ts:230) is the same convention applied
// to a probe that must never fail its caller, so it swallows a timeout (and
// every rejection) into one fallback value. The caddy startup block below
// needs the opposite: the catch just past it (Task 3's) exists to log the
// *real* reason caddy did not come up, including ensureRunning's own
// HobbyError naming exactly what never became reachable (see caddy.ts), so
// this rejects with the underlying error unless the deadline fires first,
// rather than discarding it the way preflight's version deliberately does
// for its own, different, never-fail use.
function withDeadline<T>(promise: Promise<T>, ms: number, describe: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${describe} did not finish within ${ms}ms`))
    }, ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (err: unknown) => {
        clearTimeout(timer)
        reject(err)
      }
    )
  })
}

// Bounds the whole caddy startup block below. Ordering elsewhere in this
// file requires it: the block runs before startHibernator, startAlarmMirror
// and the SIGTERM/SIGINT handlers are registered (see the docstring on
// performShutdown), so an unbounded hang here, e.g. `docker create` blocked
// on a first-run pull of caddy:2-alpine, means Ctrl-C during that window
// gets Node's default behaviour instead of performShutdown, and every
// running Postgres container is left for the next wake's crash recovery
// instead of stopped cleanly. 60s is generous for a small alpine-based
// image pull on an ordinary connection (ensureRunning's own admin-API poll,
// ADMIN_READY_TIMEOUT_MS in caddy.ts, spends 1.5s from WITHIN this budget
// rather than extending it) while still being an actual bound instead of
// none at all.
const CADDY_STARTUP_TIMEOUT_MS = 60_000

// Deleting a live daemon's socket file out from under it would let a second
// daemon bind the same path and start fighting the first one over the same
// store and the same containers, which is data-destructive. So the file is
// only ever removed after confirming, by actually trying to connect,
// that nothing answers it.
function probeUnixSocket(path: string, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection(path)
    let settled = false

    const finish = (alive: boolean): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.removeAllListeners()
      socket.destroy()
      resolve(alive)
    }

    const timer = setTimeout(() => finish(false), timeoutMs)
    socket.once('connect', () => finish(true))
    socket.once('error', () => finish(false))
  })
}

async function removeStaleSocketIfAny(socketPath: string): Promise<void> {
  if (!existsSync(socketPath)) {
    return
  }
  const alive = await probeUnixSocket(socketPath, SOCKET_PROBE_TIMEOUT_MS)
  if (alive) {
    throw new Error(`a daemon is already listening on ${socketPath}`)
  }
  await rm(socketPath, { force: true })
}

function listen(server: http.Server, target: string | { port: number; host: string }): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    const onListening = (): void => {
      server.off('error', reject)
      resolve()
    }
    if (typeof target === 'string') {
      server.listen(target, onListening)
    } else {
      server.listen(target.port, target.host, onListening)
    }
  })
}

function closeServer(server: http.Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()))
  })
}

// The four spellings resolveConfig (packages/core/src/config.ts) accepts for
// HOBBY_CADDY_ENABLED, lowercased. That parser fails closed on purpose: a
// bare Boolean(...) would treat '0' or 'false' as true, which would bind :80
// and :443 on an operator who explicitly opted out. core has no logger and
// no I/O (deliberately, see docs/CLAUDE.md), so it cannot warn about a value
// it silently turned into false; this is that warning's only home.
const ACCEPTED_CADDY_ENABLED_VALUES = new Set(['1', 'true', '0', 'false'])

// Warn only when the operator set the variable to something this parser does
// not recognise. A deliberate '0' or 'false' is not a mistake and must stay
// silent; a typo like 'yes' or 'tru' silently disables the front door with
// no other signal that anything went wrong.
function warnOnUnrecognizedCaddyEnabled(): void {
  const raw = process.env.HOBBY_CADDY_ENABLED
  if (raw === undefined || ACCEPTED_CADDY_ENABLED_VALUES.has(raw.toLowerCase())) {
    return
  }
  console.error(
    `caddy: HOBBY_CADDY_ENABLED is set to "${raw}", which is not a value this understands, so the front door ` +
      'is off. Use 1 or true to enable it, 0 or false to disable it.'
  )
}

// createApp is the shared handler both listeners are built from.
// handleRequest already converts every thrown error, HobbyError or
// otherwise, into a wire-shaped JSON error response with the right status;
// the catch here is a last-resort safety net for something handleRequest
// itself could not finish (a response stream error mid-write), so a
// connection is never simply dropped with no response at all.
export function createApp(ctx: DaemonContext): (req: IncomingMessage, res: ServerResponse) => void {
  return (req, res) => {
    handleRequest(ctx, req, res).catch((err: unknown) => {
      console.error(`daemon: request handling failed outside the normal error path: ${errorMessage(err)}`)
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
      }
      if (!res.writableEnded) {
        res.end(JSON.stringify({ error: { code: 'internal', message: 'internal error' } }))
      }
    })
  }
}

export interface StartDaemonOptions {
  socketPath: string
  // null means Studio's loopback listener is not started at all. Task 4
  // never needs this to be null in practice (the CLI and MCP only ever
  // need the unix socket), but tests that only care about the unix socket
  // path can skip binding a second port.
  apiPort: number | null
  // Run once, last, after every listener is closed and every running resource
  // has been stopped cleanly. The daemon lock is released here rather than by
  // the caller because the caller's own await never returns: `hobby daemon`
  // blocks forever and this process exits from inside the signal handler
  // below, so a release after startDaemon() would never run.
  onShutdown?: () => void
  // Same polarity as DaemonContext's detectTailnet (context.ts): production
  // wires the real createCaddyManager and tests either leave this unset,
  // getting no Caddy involved at all, or inject a fake that records calls.
  caddy?: CaddyManager
  // Run the Postgres proxy as its own process, adopting one that is already
  // running (docs/proxy/specs/2026-11-18-proxy-outlives-the-daemon.md).
  // Unset: the proxy runs inside this process, as it always did, which is
  // what tests and HOBBY_PROXY_MODE=in-process use.
  proxyProcess?: {
    logPath?: string
    // Tests only, passed through to adoptOrStartProxy.
    fingerprint?: string
    spawn?: (config: ProxydConfig) => Promise<number | null>
    // Tests only: the respawn backoff (proxy-supervisor.ts).
    backoff?: Partial<ProxyBackoff>
  }  // What a plain SIGTERM means (restart-request.ts): `restart` by default,
  // `stop` under the shipped systemd unit (HOBBY_SIGTERM=stop), where
  // `systemctl stop` and `systemctl restart` cannot be told apart. A SIGTERM
  // that `hobby daemon restart` asked for is always a restart.
  sigterm?: ShutdownMode
}

// How the daemon is going down.
//
//   restart  SIGINT (Ctrl-C), SIGTERM unless opts.sigterm says `stop`, and a
//            SIGTERM `hobby daemon restart` asked for (restart-request.ts),
//            which also exits RESTART_EXIT_CODE so a supervisor starts the
//            next daemon. A separate proxy process is left running with its
//            sessions, and so is every resource one of them is using.
//   stop     SIGUSR2, which `hobby daemon stop` sends, SIGTERM under the
//            shipped systemd unit (HOBBY_SIGTERM=stop), and close() by
//            default: the whole thing, the proxy process included.
//
// With the proxy in-process the two are the same, since the proxy cannot
// outlive this process.
export type ShutdownMode = 'restart' | 'stop'

// What a restart stops: what a full stop would, less any resource that has a
// proxied session open right now. Those stay up for the next daemon, which
// adopts the proxy and finds them running (reconcile); its hibernator puts
// them to sleep once their sessions end.
export function resourcesToStopOnRestart(ctx: DaemonContext): Resource[] {
  return resourcesToStopOnShutdown(ctx).filter((resource) => ctx.activity.count(resource.id) === 0)
}

// Which resources the daemon stops on its way down: every `running` one,
// except those in a pinned project (a null sleepAfterSeconds, the same test
// hibernator.ts applies before anything else).
//
// A pinned project is one its operator has said must stay awake, and a daemon
// restart is a control-plane event, usually an upgrade, not a reason to take
// the data plane down. Leaving the container running is safe because nothing
// about it depends on this process: docker keeps it up, the proxy that fronts
// it closes above either way, and on the next start reconcile finds it
// running, records it as `running` after its readiness probe, and touches its
// activity clock (reconcile.ts). What a restart costs a pinned project is then
// the proxy's own gap, a reconnect, rather than a clean Postgres shutdown and
// a cold start on the next connection.
//
// Projects that can sleep are still stopped cleanly, exactly as before: they
// would be stopped by the hibernator soon enough anyway, and stopping them
// here keeps a stopped daemon from leaving containers running that nothing
// will ever put to sleep.
export function resourcesToStopOnShutdown(ctx: DaemonContext): Resource[] {
  return ctx.store.listResources().filter((resource) => {
    if (resource.state !== 'running') {
      return false
    }
    // A resource with no project row is not pinned by anyone, so it keeps
    // the old behaviour and is stopped.
    const project = ctx.store.getProject(resource.projectId)
    return project === null || project.sleepAfterSeconds !== null
  })
}

export async function startDaemon(
  ctx: DaemonContext,
  opts: StartDaemonOptions
): Promise<{ close(mode?: ShutdownMode): Promise<void> }> {
  warnOnUnrecognizedCaddyEnabled()

  // Before anything binds: a socket path past sun_path's limit fails inside
  // listen() with a bare EINVAL and a stack (issue #107), and the message
  // that names HOBBY_HOME has to come from somewhere that knows the cause.
  assertSocketPathFits(opts.socketPath)

  await removeStaleSocketIfAny(opts.socketPath)

  const app = createApp(ctx)
  const socketServer = http.createServer(app)
  await listen(socketServer, opts.socketPath)
  await chmod(opts.socketPath, SOCKET_MODE)

  let tcpServer: http.Server | null = null
  if (opts.apiPort !== null) {
    // Wrapped in createStudioApp, unlike the unix socket above: this is the
    // listener Caddy is the sole intended caller of (ADR 0008), so it is
    // the one place login, logout, session-check and the session gate for
    // every other /v1/ route actually apply. The unix socket keeps using
    // the bare `app` from createApp, completely unaffected: filesystem
    // permissions remain its whole authentication story, exactly as task 4
    // built it, and createApp's own tests keep asserting that with no
    // studio code in the loop at all.
    const studioApp = createStudioApp(ctx, app)
    tcpServer = http.createServer(studioApp)
    // 127.0.0.1 only, never 0.0.0.0: this is a database control plane that
    // is unauthenticated on this listener only in the sense that the unix
    // socket's filesystem permissions do not apply to it; Studio's session
    // gate above is what actually authenticates it. Studio is the only
    // client meant to reach the TCP listener at all, always through Caddy
    // on the same box (see docs/cli/specs/2026-08-07-m1-daemon-control-api-
    // and-verbs.md). A public bind here would expose create/destroy/
    // start/stop on every Postgres on the box to the network regardless of
    // the session gate holding.
    await listen(tcpServer, { port: opts.apiPort, host: '127.0.0.1' })
  }

  // The wake-on-connect proxy: the keystone component (see root CLAUDE.md).
  // Started with the daemon's other listeners, bound to ctx.config.proxyPort,
  // and using the real ProxyDeps built from this same DaemonContext (see
  // context.ts's createProxyDeps for exactly what resolve/wake do and why).
  // ADR 0017. One proxy per resolved address, because startPgProxy binds one
  // host and "tailnet" has to be two: the tailnet address for other machines
  // and loopback for the box itself, since `hobby connect` builds its string
  // against 127.0.0.1 and would otherwise stop working on the very box the
  // database lives on.
  const proxyHosts = await resolveProxyHosts(ctx)
  const proxyTls = proxyTlsFiles(ctx.config.proxyTls)
  // Two ways to run the proxy. In-process (tests, and HOBBY_PROXY_MODE=
  // in-process) is exactly what it always was. As its own process
  // (opts.proxyProcess, what `hobby daemon` uses) it outlives this daemon, so a
  // restart or an upgrade leaves proxied sessions up:
  // docs/proxy/specs/2026-11-18-proxy-outlives-the-daemon.md.
  let proxyLink: SupervisedProxy | null = null
  const proxies: Array<{ port: number; close: () => Promise<void> }> = []
  let addProxyGateway: (gateway: string) => Promise<void>
  if (opts.proxyProcess !== undefined) {
    // Supervised: a proxy that dies while this daemon runs is started again
    // (proxy-supervisor.ts), as Restart=on-failure did when it was in-process.
    const link = await superviseProxy({
      config: {
        socketPath: proxySocketPath(ctx.paths.home),
        statePath: ctx.paths.statePath,
        port: ctx.config.proxyPort,
        hosts: proxyHosts,
        wakeTimeoutMs: ctx.config.wakeTimeoutMs,
        tls: proxyTls ?? null,
      },
      logPath: opts.proxyProcess.logPath ?? join(ctx.paths.home, 'proxy.log'),
      daemon: {
        wake: getOrCreateWake(ctx),
        activity: ctx.activity,
        refusalRetryAt: (resourceId) => getWakeRefusal(ctx, resourceId)?.retryAt ?? null,
      },
      ...(opts.proxyProcess.fingerprint === undefined ? {} : { fingerprint: opts.proxyProcess.fingerprint }),
      ...(opts.proxyProcess.spawn === undefined ? {} : { spawn: opts.proxyProcess.spawn }),
      ...(opts.proxyProcess.backoff === undefined ? {} : { backoff: opts.proxyProcess.backoff }),
    })
    proxyLink = link
    ctx.proxyHealth = () => link.health()
    // The gateways the proxy also listens on (issue #53) and counts as this
    // box for allowlists. Sent on adoption too: a gateway the proxy already
    // has is a no-op on its side.
    for (const gateway of await proxyGatewayHosts(ctx)) {
      link.addGateway(gateway)
    }
    addProxyGateway = async (gateway: string): Promise<void> => {
      link.addGateway(gateway)
    }
  } else {
    const proxyBound = new Set<string>()
    // `local`: a listener only this box's own containers can reach (a project
    // network's bridge gateway, see proxyGatewayHosts below). Plaintext is
    // allowed on it even with TLS configured, the same way it is on loopback:
    // the traffic never leaves the machine, and an app's DATABASE_URL carries
    // no sslmode. A listener on an operator-chosen address keeps ADR 0019's
    // rule exactly as it was.
    // The docker network gateways this box's own apps and workers dial the
    // proxy at (host.docker.internal on Linux). A connection that arrived on
    // one of them, or on loopback, is the box itself and is exempt from every
    // project's IP allowlist (the 2026-11-17 allowlist amendment in
    // docs/proxy/CLAUDE.md). Judged by the address the client dialed, not by
    // which listener took it, because with proxyHost "all" there is no
    // gateway listener: the 0.0.0.0 one takes that traffic, from container
    // addresses no allowlist would name. Grows with addProxyGateway below.
    const gatewayAddresses = new Set<string>(await proxyGatewayHosts(ctx))
    const sameBox = (local: string | undefined, peer: string | undefined): boolean =>
      defaultSameBox(local, peer) || (local !== undefined && gatewayAddresses.has(local.replace(/^::ffff:/, '')))
    const startProxyOn = async (host: string, local: boolean): Promise<void> => {
      if (proxyBound.has(host)) return
      proxies.push(
        await startPgProxy({
          port: ctx.config.proxyPort,
          host,
          deps: createProxyDeps(ctx),
          wakeTimeoutMs: ctx.config.wakeTimeoutMs,
          sameBox,
          ...(proxyTls === undefined ? {} : { tls: proxyTls }),
          ...(local ? { plaintextAllowed: () => true } : {}),
        })
      )
      proxyBound.add(host)
    }
    for (const host of proxyHosts) {
      await startProxyOn(host, false)
    }
    // Issue #53: an app or worker reaches its database through the proxy by
    // host.docker.internal (packages/app/src/app.ts's databaseUrlFor), which
    // on Linux is each project network's bridge gateway, an address a proxy
    // bound to loopback never sees. The same addresses the enqueue listener
    // binds, for the same reason, with the same best-effort rule: a gateway
    // that cannot be bound is logged, not fatal. A "0.0.0.0" bind already
    // covers them and binding again would fail, hence the `all` check.
    if (!proxyHosts.includes('0.0.0.0')) {
      for (const gateway of gatewayAddresses) {
        try {
          await startProxyOn(gateway, true)
        } catch (err) {
          console.error(
            `daemon: could not bind the wake-on-connect proxy on docker gateway ${gateway}, apps in that project may not reach their database: ${errorMessage(err)}`
          )
        }
      }
    }
    addProxyGateway = async (gateway: string): Promise<void> => {
      gatewayAddresses.add(gateway)
      if (proxyHosts.includes('0.0.0.0')) return
      try {
        await startProxyOn(gateway, true)
      } catch (err) {
        console.error(
          `daemon: could not bind the wake-on-connect proxy on docker gateway ${gateway}, apps in that project may not reach their database: ${errorMessage(err)}`
        )
      }
    }
  }

  // The HTTP half of the same router (M7, docs/compute/specs/2026-08-10-
  // phase-2-compute-design.md). Caddy holds :80 and :443 and forwards
  // everything it does not recognise here, because Caddy cannot trigger a
  // wake (ADR 0009). Loopback only: Caddy runs on the same box and is the
  // only intended caller, and a public bind would let anyone who can route
  // to the machine reach every app by sending a Host header, with TLS
  // termination skipped.
  const httpRouter = await startHttpRouter(createHttpProxyDeps(ctx), {
    port: ctx.config.httpPort,
    host: '127.0.0.1',
    wakeTimeoutMs: ctx.config.wakeTimeoutMs,
  })

  // Caddy is the front door the httpRouter above never had one before this
  // task: :80 and :443 on the box, TLS terminated, everything it does not
  // recognise forwarded to the loopback wake router. One fallback route,
  // never a route per deploy: the wake router above already has to resolve
  // the Host header to know what to wake, so a Caddy route per app would be
  // duplicated state that drifts the first time an admin push fails (see the
  // CaddyFallback comment in caddy.ts for the full argument). The ask URL is
  // built from @hobby.sh/proxy's own exported TLS_ASK_PATH, not a literal
  // string, so the router side and the Caddy side of on-demand TLS cannot
  // disagree about the path.
  const caddy = ctx.config.caddyEnabled
    ? (opts.caddy ??
      createCaddyManager(ctx.runtime, {
        adminPort: ctx.config.caddyAdminPort,
        caddyfilePath: join(ctx.paths.home, 'caddy', 'Caddyfile'),
      }))
    : null

  if (caddy !== null) {
    // Deliberately not fatal. A box whose Caddy will not start still has
    // Postgres resources that must wake on connection through the pg proxy,
    // which has nothing to do with HTTP. Refusing to start the daemon here
    // would take databases offline to punish a web server, inverting the
    // priority root CLAUDE.md sets between its three promises. Loud, not
    // silent, and not fatal.
    try {
      await withDeadline(
        (async () => {
          await caddy.ensureRunning()
          await caddy.setFallback({
            upstream: `127.0.0.1:${ctx.config.httpPort}`,
            askUrl: `http://127.0.0.1:${ctx.config.httpPort}${TLS_ASK_PATH}`,
          })
          if (ctx.config.caddyStudioHost !== null && opts.apiPort !== null) {
            await caddy.addRoute({
              id: 'hobby-studio',
              host: ctx.config.caddyStudioHost,
              upstream: `127.0.0.1:${opts.apiPort}`,
            })
          } else if (ctx.config.caddyStudioHost !== null) {
            console.error(
              'caddy: no studio route published, because the studio listener is not started on this daemon'
            )
          }
        })(),
        CADDY_STARTUP_TIMEOUT_MS,
        'caddy startup'
      )
    } catch (err) {
      console.error(
        `caddy: the front door did not come up, so apps are reachable only on their loopback ports: ${errorMessage(err)}`
      )
    }
  }

  // The sleep half of the pair the proxy completes. Reads activity off the
  // same ActivityTracker instance the proxy just started using (ctx.activity
  // is one source of truth for both), never polls Postgres on a schedule.
  const hibernator = startHibernator(ctx, { intervalMs: HIBERNATION_TICK_MS })

  // Deletes branches whose opt-in expiry has passed, skipping (and saying
  // so) any that are pinned, awake or held. See expiry.ts.
  const expirySweeper = startExpirySweeper(ctx, { intervalMs: EXPIRY_SWEEP_MS, remove: deleteProject })

  // The other half of the sleep pair, for the one kind whose work can arrive
  // with no request behind it. A stopped container has no timer, so nothing
  // inside a sleeping worker can fire an alarm set for 03:00. This reads the
  // schedule workerd already wrote to disk and asks for a wake when a deadline
  // comes due; workerd's own scheduler reloads every pending row at startup
  // and fires it, so being awake at the deadline is the whole contribution.
  // See docs/durable-objects/.
  // An alarm coming due is activity (issue #160), whether the worker was
  // asleep (the wake below starts its idle clock) or already running (the
  // mirror's wake is then a no-op and this touch is what resets the clock):
  // a worker that fires an alarm every few minutes should not sleep and
  // rewake around each one.
  const wakeForAlarm = getOrCreateWake(ctx)
  const alarmMirror = startAlarmMirror({
    namespaces: () => durableObjectNamespaces(ctx),
    wake: async (resourceId: string): Promise<void> => {
      await wakeForAlarm(resourceId)
      ctx.activity.touch(resourceId)
    },
    intervalMs: ALARM_MIRROR_TICK_MS,
  })

  // The listener a worker container's producer shim posts to when user code
  // calls env.MY_QUEUE.send() / .sendBatch(). Its own security boundary is
  // entirely inside queue-endpoint.ts (a per-resource bearer token, no
  // sharing of the daemon's main router); this is only the platform-specific
  // "which addresses" decision queueEndpointHosts exists for, and the token
  // index queueTokenFor exists for. Bound to ctx.config.queuePort, same
  // DEFAULT_CONFIG.queuePort (7434 in packages/core/src/config.ts) the worker
  // kind already points a container's producer shim at
  // (packages/worker/src/worker.ts's buildRunnerManifest).
  // Wired below, after the endpoint exists, so a project created while the
  // daemon runs gets its gateway bound at once.
  const queueEndpoint = await startQueueEndpoint(ctx, {
    port: ctx.config.queuePort,
    hosts: await queueEndpointHosts(ctx),
    tokenFor: queueTokenFor(ctx),
  })

  // Linux only, and a no-op elsewhere: on macOS docker resolves
  // host.docker.internal itself and there is no gateway to bind.
  //
  // Wrapping ensureNetwork rather than hooking each resource kind: postgres,
  // app and worker all call it, and three call sites is three chances for the
  // next kind to forget. Every path that can create a project network goes
  // through here.
  if (process.platform === 'linux') {
    const inner = ctx.runtime.ensureNetwork.bind(ctx.runtime)
    ctx.runtime.ensureNetwork = async (name: string): Promise<void> => {
      await inner(name)
      const gateway = await networkGateway(name)
      if (gateway !== null) {
        await queueEndpoint.addHost(gateway)
        // The proxy too, for the same reason (#53): a project created while
        // the daemon runs gets its apps' path to their database at once.
        await addProxyGateway(gateway)
      }
    }
  }

  // The keystone's queue half: notices a batch is ready, wakes a sleeping
  // consumer, delivers, and refuses to let expireLeases lose a message a
  // container died mid-batch on. Reads the store fresh every tick through
  // drainableQueues (packages/cli/src/daemon/queues.ts), the same "no cache
  // to invalidate" shape durableObjectNamespaces above already uses. wake is
  // the same idempotent, de-duplicated wake the proxy, the HTTP router and
  // the alarm mirror all share (getOrCreateWake), so a queue message and an
  // inbound request arriving for the same sleeping worker at once still cost
  // exactly one start.
  const queueTick = startQueueTick({
    queues: () => drainableQueues(ctx),
    // Every other queue in a managed project, swept for retention only
    // (issue #167): a dead letter queue or a producer-only queue has no
    // consumer to deliver to, but its messages still age out on schedule.
    retention: () => retentionTargets(ctx),
    wake: getOrCreateWake(ctx),
    deliver: queueDeliverFn(ctx),
    stateOf: queueStateOf(ctx),
    intervalMs: QUEUE_TICK_MS,
  })

  // Cron triggers (issue #75): the same wake the queue tick and the alarm
  // mirror share, so a cron firing into a sleeping worker is one wake, not
  // a second one stacked on whatever else noticed it. Ten seconds, like the
  // alarm mirror: a cron is written to the minute, and ten seconds late is
  // inside what anyone means by "at 03:00".
  const cronScheduler = startCronScheduler({
    workers: () => scheduledWorkers(ctx),
    wake: getOrCreateWake(ctx),
    stateOf: queueStateOf(ctx),
    // A cron firing is activity too (issue #160), for the same reason a
    // queue delivery is.
    fire: async (firing) => {
      const outcome = await postScheduled(firing)
      ctx.activity.touch(firing.worker.resourceId)
      return outcome
    },
    state: cronState(ctx),
    intervalMs: ALARM_MIRROR_TICK_MS,
  })

  let shutdownPromise: Promise<void> | null = null

  // Idempotent and shared between the signal handlers and the returned
  // close(): whichever fires first runs the real shutdown, and every other
  // caller (including a second SIGTERM arriving while the first is still in
  // flight) just awaits the same promise instead of racing a second one.
  function performShutdown(mode: ShutdownMode): Promise<void> {
    if (shutdownPromise !== null) {
      return shutdownPromise
    }
    const keepProxy = mode === 'restart' && proxyLink !== null
    // Before anything else: a proxy lost from here on is not respawned.
    proxyLink?.beginShutdown()
    shutdownPromise = (async () => {
      // From here on a wake the proxy asks for is answered "daemon leaving",
      // and the proxy asks the next daemon instead.
      if (keepProxy) proxyLink?.beginLeaving()

      // server.close() stops accepting new connections and waits for
      // in-flight requests to finish before its callback fires: this is
      // "stop accepting, finish in-flight requests" from the brief, for
      // free, from node:http itself. The queue endpoint closes alongside the
      // other two listeners for the same reason: a producer shim mid-send
      // finishes its request, but no new enqueue is accepted once shutdown
      // has started.
      await Promise.all([
        closeServer(socketServer),
        tcpServer ? closeServer(tcpServer) : Promise.resolve(),
        queueEndpoint.stop(),
      ])

      if (caddy !== null) {
        // Best effort: a Caddy that will not stop must not prevent the
        // daemon closing its own listeners.
        await caddy.stop().catch((err: unknown) => {
          console.error(`caddy: could not stop the front door cleanly: ${errorMessage(err)}`)
        })
      }

      // The hibernator must stop deciding to sleep things before this
      // function starts explicitly stopping things itself, or the two could
      // race over the same resource. stop() interrupts the loop's current
      // wait immediately, but if a tick had already decided to sleep a
      // resource and is running stopPostgres, this awaits that tick's
      // drain so it can never run concurrently with the loop below.
      await hibernator.stop()

      // Drained here for the hibernator's reason: a sweep that is mid-way
      // through deleting a branch must finish before shutdown stops things.
      await expirySweeper.stop()

      // Drained before the proxy closes, for the mirror's own version of the
      // ordering constraint below: a tick that has already decided to wake a
      // worker must not still be calling wake while the loop underneath is
      // stopping resources.
      await alarmMirror.stop()

      // Same ordering constraint as the alarm mirror, for the identical
      // reason: a queue tick that has already decided to wake a consumer, or
      // is mid-delivery to one, must not still be running while the loop
      // below stops resources out from under it. Drained, not merely
      // stopped, so an in-flight delivery finishes (or times out on its own)
      // rather than being abandoned with its lease still held.
      await queueTick.stop()

      await cronScheduler.stop()

      // The proxy must close before any resource below is stopped: a proxy
      // still accepting connections would wake a resource right back up the
      // instant this loop stopped it, which is the one ordering constraint
      // called out explicitly for this shutdown sequence.
      try {
        // Every one, not just the first: "tailnet" binds two, and a listener
        // left open holds the port and stops the daemon restarting cleanly.
        await Promise.all(proxies.map((p) => p.close()))
        // A full stop stops the proxy process too, and waits for it to exit,
        // for the same ordering reason. A restart leaves it accepting: its
        // wakes are held until the next daemon (beginLeaving above).
        if (proxyLink !== null && !keepProxy) {
          await proxyLink.stopProxy()
        }
      } catch (err) {
        console.error(`daemon shutdown: failed to close the wake-on-connect proxy cleanly: ${errorMessage(err)}`)
      }

      // Same ordering constraint, same reason: an HTTP router still
      // accepting requests would wake an app back up the instant the loop
      // below stopped it.
      try {
        await httpRouter.close()
      } catch (err) {
        console.error(`daemon shutdown: failed to close the http wake router cleanly: ${errorMessage(err)}`)
      }

      // Only after both control-plane listeners and the proxy are fully
      // closed: stopping a `running` resource is a clean stop (see
      // stopPostgres / docker.ts), which is what keeps the next wake out of
      // Postgres crash recovery, landing inside a user's first query. An
      // unclean daemon exit here is exactly the failure mode this step
      // exists to prevent. Pinned projects are left running, see
      // resourcesToStopOnShutdown.
      for (const resource of keepProxy ? resourcesToStopOnRestart(ctx) : resourcesToStopOnShutdown(ctx)) {
        // Re-read right before each stop, as the hibernator does: a session
        // may have opened through the proxy that is staying up.
        if (keepProxy && ctx.activity.count(resource.id) > 0) continue
        try {
          await ctx.kinds.get(resource.kind).stop(ctx, resource)
        } catch (err) {
          console.error(`daemon shutdown: failed to stop resource ${resource.id} cleanly: ${errorMessage(err)}`)
        }
      }

      // Last thing touching the proxy: the link closes and the proxy keeps
      // running with its sessions.
      if (keepProxy) proxyLink?.detach()

      try {
        await rm(opts.socketPath, { force: true })
      } catch (err) {
        console.error(`daemon shutdown: failed to remove socket file: ${errorMessage(err)}`)
      }

      // Last, and never allowed to throw: releasing the lock is what lets the
      // next daemon start, so a failure here must not become the reason the
      // rest of a clean shutdown is reported as unclean.
      try {
        opts.onShutdown?.()
      } catch (err) {
        console.error(`daemon shutdown: failed to release the daemon lock: ${errorMessage(err)}`)
      }
    })()
    return shutdownPromise
  }

  const shutdownAndExit = (mode: ShutdownMode, exitCode: number): void => {
    performShutdown(mode)
      .then(() => process.exit(exitCode))
      .catch((err: unknown) => {
        console.error(`daemon: shutdown failed: ${errorMessage(err)}`)
        process.exit(1)
      })
  }

  const onRestart = (): void => shutdownAndExit('restart', 0)
  const onStop = (): void => shutdownAndExit('stop', 0)
  const onTerm = (): void => {
    const { mode, exitCode, requested } = onSigterm(ctx.paths.home, opts.sigterm ?? 'restart')
    if (requested) console.error('daemon: restarting as `hobby daemon restart` asked; the proxy and its sessions stay up')
    shutdownAndExit(mode, exitCode)
  }
  process.on('SIGTERM', onTerm)
  process.on('SIGINT', onRestart)
  process.on('SIGUSR2', onStop)

  return {
    async close(mode: ShutdownMode = 'stop'): Promise<void> {
      process.off('SIGTERM', onTerm)
      process.off('SIGINT', onRestart)
      process.off('SIGUSR2', onStop)
      await performShutdown(mode)
    },
  }
}
