// Two listeners, one handler. A unix socket for the CLI and MCP (filesystem
// permissions are the authentication, see docs/cli/CLAUDE.md), and an
// optional loopback TCP port for Studio once it exists. Neither listener
// does anything a request handler couldn't: createApp is the single
// function both are built from, so there is exactly one place routing and
// error handling can live, never two copies that can drift.

import { existsSync } from 'node:fs'
import { chmod, rm } from 'node:fs/promises'
import http, { type IncomingMessage, type ServerResponse } from 'node:http'
import net from 'node:net'
import { stopPostgres } from '@hobby.sh/pg'
import type { DaemonContext } from './context.js'
import { handleRequest } from './routes.js'

const SOCKET_MODE = 0o600

// How long to wait for a connection attempt against a possibly-stale socket
// file before assuming nothing is listening. Generous enough that a real,
// merely slow-to-accept daemon is never mistaken for a dead one, short
// enough that a genuinely stale file does not stall startup.
const SOCKET_PROBE_TIMEOUT_MS = 500

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
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
    tcpServer = http.createServer(app)
    // 127.0.0.1 only, never 0.0.0.0: this is an unauthenticated database
    // control plane, and Studio is the only client meant to reach the TCP
    // listener at all, always through Caddy on the same box (see
    // docs/cli/specs/2026-08-07-m1-daemon-control-api-and-verbs.md). A
    // public bind here would expose create/destroy/start/stop on every
    // Postgres on the box to the network.
    await listen(tcpServer, { port: opts.apiPort, host: '127.0.0.1' })
  }

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
      // free, from node:http itself.
      await Promise.all([closeServer(socketServer), tcpServer ? closeServer(tcpServer) : Promise.resolve()])

      // Only after both listeners are fully closed: stopping a `running`
      // resource is a clean stop (see stopPostgres / docker.ts), which is
      // what keeps the next wake out of Postgres crash recovery, landing
      // inside a user's first query. An unclean daemon exit here is exactly
      // the failure mode this step exists to prevent.
      const running = ctx.store.listResources().filter((resource) => resource.state === 'running')
      for (const resource of running) {
        try {
          await stopPostgres(ctx, resource)
        } catch (err) {
          console.error(`daemon shutdown: failed to stop resource ${resource.id} cleanly: ${errorMessage(err)}`)
        }
      }

      try {
        await rm(opts.socketPath, { force: true })
      } catch (err) {
        console.error(`daemon shutdown: failed to remove socket file: ${errorMessage(err)}`)
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
