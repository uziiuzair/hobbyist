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
import { promisify } from 'node:util'
import { startAlarmMirror } from '@hobby.sh/do'
import { startHttpRouter, startPgProxy } from '@hobby.sh/proxy'
import { startQueueTick } from '@hobby.sh/queue'
import { durableObjectNamespaces } from './alarms.js'
import { createHttpProxyDeps, createProxyDeps, getOrCreateWake, type DaemonContext } from './context.js'
import { startHibernator } from './hibernator.js'
import { startQueueEndpoint } from './queue-endpoint.js'
import { drainableQueues, queueDeliverFn, queueStateOf } from './queues.js'
import { handleRequest } from './routes.js'
import { createStudioApp } from './studio/routes.js'

const execFileAsync = promisify(execFile)

const SOCKET_MODE = 0o600

// How often the hibernator re-checks every resource for a sleep candidate.
// docs/hibernation/CLAUDE.md cites Xata's CNPG sidecar polling once a minute
// as the cost envelope to stay inside; this is tighter than that so a short
// sleepAfterSeconds (a developer testing the feature, e.g.) does not sit up
// to a full extra minute past its own threshold, while still being far from
// a meaningful load on a single box (the hibernator's own tick is in-memory
// ActivityTracker reads for every resource that is not already a sleep
// candidate, and only one real Postgres round trip for the ones that are).
const HIBERNATION_TICK_MS = 10_000

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
async function queueEndpointHosts(ctx: DaemonContext): Promise<string[]> {
  const hosts = new Set<string>(['127.0.0.1'])
  if (process.platform !== 'linux') {
    return [...hosts]
  }

  for (const project of ctx.store.listProjects()) {
    try {
      const { stdout } = await execFileAsync('docker', [
        'network',
        'inspect',
        project.networkName,
        '--format',
        '{{range .IPAM.Config}}{{.Gateway}}{{end}}',
      ])
      const gateway = stdout.trim()
      if (gateway.length > 0) {
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
}

export async function startDaemon(
  ctx: DaemonContext,
  opts: StartDaemonOptions
): Promise<{ close(): Promise<void> }> {
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
  const proxy = await startPgProxy({
    port: ctx.config.proxyPort,
    deps: createProxyDeps(ctx),
    wakeTimeoutMs: ctx.config.wakeTimeoutMs,
  })

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

  // The sleep half of the pair the proxy completes. Reads activity off the
  // same ActivityTracker instance the proxy just started using (ctx.activity
  // is one source of truth for both), never polls Postgres on a schedule.
  const hibernator = startHibernator(ctx, { intervalMs: HIBERNATION_TICK_MS })

  // The other half of the sleep pair, for the one kind whose work can arrive
  // with no request behind it. A stopped container has no timer, so nothing
  // inside a sleeping worker can fire an alarm set for 03:00. This reads the
  // schedule workerd already wrote to disk and asks for a wake when a deadline
  // comes due; workerd's own scheduler reloads every pending row at startup
  // and fires it, so being awake at the deadline is the whole contribution.
  // See docs/durable-objects/.
  const alarmMirror = startAlarmMirror({
    namespaces: () => durableObjectNamespaces(ctx),
    wake: getOrCreateWake(ctx),
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
  const queueEndpoint = await startQueueEndpoint(ctx, {
    port: ctx.config.queuePort ?? 7434,
    hosts: await queueEndpointHosts(ctx),
    tokenFor: queueTokenFor(ctx),
  })

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
    wake: getOrCreateWake(ctx),
    deliver: queueDeliverFn(ctx),
    stateOf: queueStateOf(ctx),
    intervalMs: QUEUE_TICK_MS,
  })

  let shutdownPromise: Promise<void> | null = null

  // Idempotent and shared between the signal handlers and the returned
  // close(): whichever fires first runs the real shutdown, and every other
  // caller (including a second SIGTERM arriving while the first is still in
  // flight) just awaits the same promise instead of racing a second one.
  function performShutdown(): Promise<void> {
    if (shutdownPromise !== null) {
      return shutdownPromise
    }
    shutdownPromise = (async () => {
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

      // The hibernator must stop deciding to sleep things before this
      // function starts explicitly stopping things itself, or the two could
      // race over the same resource. stop() interrupts the loop's current
      // wait immediately, but if a tick had already decided to sleep a
      // resource and is running stopPostgres, this awaits that tick's
      // drain so it can never run concurrently with the loop below.
      await hibernator.stop()

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

      // The proxy must close before any resource below is stopped: a proxy
      // still accepting connections would wake a resource right back up the
      // instant this loop stopped it, which is the one ordering constraint
      // called out explicitly for this shutdown sequence.
      try {
        await proxy.close()
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
      // exists to prevent.
      const running = ctx.store.listResources().filter((resource) => resource.state === 'running')
      for (const resource of running) {
        try {
          await ctx.kinds.get(resource.kind).stop(ctx, resource)
        } catch (err) {
          console.error(`daemon shutdown: failed to stop resource ${resource.id} cleanly: ${errorMessage(err)}`)
        }
      }

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

  const onSignal = (): void => {
    performShutdown()
      .then(() => process.exit(0))
      .catch((err: unknown) => {
        console.error(`daemon: shutdown failed: ${errorMessage(err)}`)
        process.exit(1)
      })
  }

  process.on('SIGTERM', onSignal)
  process.on('SIGINT', onSignal)

  return {
    async close(): Promise<void> {
      process.off('SIGTERM', onSignal)
      process.off('SIGINT', onSignal)
      await performShutdown()
    },
  }
}
