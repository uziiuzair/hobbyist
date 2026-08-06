// The wake router itself. This file is the only one in the package that
// touches a net.Socket; startup.ts and activity.ts are pure and this file
// is what wires them to a real TCP connection.
//
// The proxy asks, the engine acts (docs/proxy/CLAUDE.md): this file never
// imports Docker, never touches a store, never starts a container. Every
// piece of world it needs, resolving a routing key to an address and
// waking a sleeping resource, arrives through the injected ProxyDeps. The
// daemon (Task 7) supplies the real implementation; tests supply a fake
// one.

import net from 'node:net'
import { HobbyError, parseRoutingKey } from '@hobby.sh/core'
import type { ActivityTracker } from './activity.js'
import { errorResponse, parseStartup, type StartupMessage } from './startup.js'

export interface ProxyTarget {
  resourceId: string
  host: string
  port: number
  state: string
}

export interface ProxyDeps {
  resolve(routingKey: string): Promise<ProxyTarget | null>
  // Safe to call concurrently: ten simultaneous connections to a sleeping
  // resource each call wake and each await it. This file does not
  // deduplicate those calls, does not track "a wake is already in flight,"
  // and does not coalesce them into one. Making concurrent wakes for the
  // same resourceId idempotent (so the tenth caller does not issue a
  // tenth container start) is the daemon's responsibility, not the
  // proxy's. See the task report for why that split is deliberate.
  wake(resourceId: string): Promise<void>
  activity: ActivityTracker
}

const PROTOCOL_VIOLATION = '08P01'
const UNKNOWN_DATABASE = '3D000'
const CANNOT_CONNECT_NOW = '57P03'

function errorMessage(err: unknown): string {
  if (err instanceof HobbyError) {
    return err.hint ? `${err.message} (${err.hint})` : err.message
  }
  return err instanceof Error ? err.message : String(err)
}

// Writes a real ErrorResponse and ends the socket. socket.end(buffer)
// flushes the buffer before sending FIN, so the client's read of the error
// is not racing the close: never a dropped socket, always a readable one.
function sendErrorAndClose(socket: net.Socket, severity: string, code: string, message: string): void {
  if (socket.destroyed || !socket.writable) {
    return
  }
  socket.end(errorResponse(severity, code, message))
}

// Buffers socket bytes until parseStartup can produce one complete message,
// then resolves with that message and the exact raw bytes it consumed. Any
// bytes read past the message boundary are pushed back with socket.unshift
// so the next reader (a second readMessage call after SSLRequest, or the
// eventual splice) sees them.
function readMessage(socket: net.Socket): Promise<{ message: StartupMessage; raw: Buffer }> {
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0)
    let settled = false

    const cleanup = (): void => {
      socket.off('data', onData)
      socket.off('close', onClose)
      socket.off('error', onError)
    }

    const onData = (chunk: Buffer): void => {
      buffer = Buffer.concat([buffer, chunk])
      let result: ReturnType<typeof parseStartup>
      try {
        result = parseStartup(buffer)
      } catch (err) {
        settled = true
        cleanup()
        reject(err)
        return
      }
      if (result === null) {
        return
      }
      settled = true
      cleanup()
      const raw = Buffer.from(buffer.subarray(0, result.consumed))
      const rest = buffer.subarray(result.consumed)
      if (rest.length > 0) {
        socket.unshift(rest)
      }
      resolve({ message: result.message, raw })
    }

    const onClose = (): void => {
      if (settled) return
      settled = true
      cleanup()
      reject(new Error('connection closed before a complete startup packet arrived'))
    }

    const onError = (err: Error): void => {
      if (settled) return
      settled = true
      cleanup()
      reject(err)
    }

    socket.on('data', onData)
    socket.on('close', onClose)
    socket.on('error', onError)
  })
}

function connectUpstream(host: string, port: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port })

    const cleanup = (): void => {
      socket.off('connect', onConnect)
      socket.off('error', onError)
    }
    const onConnect = (): void => {
      cleanup()
      resolve(socket)
    }
    const onError = (err: Error): void => {
      cleanup()
      reject(err)
    }

    socket.once('connect', onConnect)
    socket.once('error', onError)
  })
}

// Races a promise against a timer. Used only around deps.wake: a wake that
// never resolves must still produce a 57P03 within wakeTimeoutMs rather
// than holding the client's socket open indefinitely. This does not cancel
// the underlying wake, a resource that eventually does come up after this
// connection gave up on it is still fine, since the daemon owns that
// lifecycle independently of any one client's patience.
function raceTimeout<T>(promise: Promise<T>, ms: number, onTimeout: () => Error): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(onTimeout()), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (err) => {
        clearTimeout(timer)
        reject(err)
      }
    )
  })
}

// Attaches the activity tracker and pipes both directions. activity.close
// fires exactly once per connection: `closed` is the guard. Whichever of
// client close, upstream close, client error or upstream error happens
// first calls finish(); every other event after that is a no-op. Tearing
// down both sockets in finish() (rather than only the one that fired) is
// what stops the other side from being left half-open forever once its
// peer is gone.
function spliceAndTrackActivity(client: net.Socket, upstream: net.Socket, activity: ActivityTracker, resourceId: string): void {
  activity.open(resourceId)
  let closed = false

  const finish = (): void => {
    if (closed) return
    closed = true
    activity.close(resourceId)
    client.destroy()
    upstream.destroy()
  }

  client.on('close', finish)
  client.on('error', finish)
  upstream.on('close', finish)
  upstream.on('error', finish)

  client.pipe(upstream)
  upstream.pipe(client)
}

async function handleStartup(
  socket: net.Socket,
  deps: ProxyDeps,
  wakeTimeoutMs: number,
  message: Extract<StartupMessage, { type: 'startup' }>,
  raw: Buffer
): Promise<void> {
  const database = message.params['database']
  if (typeof database !== 'string' || database.length === 0) {
    sendErrorAndClose(socket, 'FATAL', UNKNOWN_DATABASE, 'no database specified in startup packet')
    return
  }

  const routingKey = parseRoutingKey(database)

  let target: ProxyTarget | null
  try {
    target = await deps.resolve(routingKey.project)
  } catch (err) {
    sendErrorAndClose(socket, 'FATAL', UNKNOWN_DATABASE, `failed to resolve ${database}: ${errorMessage(err)}`)
    return
  }

  if (target === null) {
    sendErrorAndClose(socket, 'FATAL', UNKNOWN_DATABASE, `unknown database: ${database}`)
    return
  }

  if (target.state !== 'running') {
    try {
      await raceTimeout(deps.wake(target.resourceId), wakeTimeoutMs, () => new Error(`wake timed out after ${wakeTimeoutMs}ms`))
    } catch (err) {
      sendErrorAndClose(socket, 'FATAL', CANNOT_CONNECT_NOW, `could not wake ${target.resourceId}: ${errorMessage(err)}`)
      return
    }

    // The resource was asleep, so the host and port read before the wake
    // are exactly the thing that may have just changed (a new container,
    // a new port allocation). Re-resolve rather than trust them.
    try {
      target = await deps.resolve(routingKey.project)
    } catch (err) {
      sendErrorAndClose(socket, 'FATAL', CANNOT_CONNECT_NOW, `failed to resolve ${database} after wake: ${errorMessage(err)}`)
      return
    }
    if (target === null) {
      sendErrorAndClose(socket, 'FATAL', UNKNOWN_DATABASE, `unknown database: ${database}`)
      return
    }
    if (target.state !== 'running') {
      sendErrorAndClose(socket, 'FATAL', CANNOT_CONNECT_NOW, `${target.resourceId} did not become ready after wake`)
      return
    }
  }

  let upstream: net.Socket
  try {
    upstream = await connectUpstream(target.host, target.port)
  } catch (err) {
    sendErrorAndClose(socket, 'FATAL', CANNOT_CONNECT_NOW, `could not connect to ${target.resourceId}: ${errorMessage(err)}`)
    return
  }
  // Same reasoning as the safety net on the client socket in
  // handleConnectionInner: connectUpstream's own 'error' listener is
  // detached the moment it resolves, and an unhandled 'error' on this
  // socket would otherwise crash the process rather than just this
  // connection.
  upstream.on('error', () => {})

  // Auth passes through: the buffered startup packet is replayed byte for
  // byte, so SCRAM negotiates between the client and Postgres directly and
  // this proxy never sees a password.
  upstream.write(raw)
  spliceAndTrackActivity(socket, upstream, deps.activity, target.resourceId)
}

async function handleConnectionInner(socket: net.Socket, deps: ProxyDeps, wakeTimeoutMs: number): Promise<void> {
  // A permanent safety net for the life of this function. readMessage
  // attaches and detaches its own 'error' listener around each read, and
  // there is a real gap between that detach and spliceAndTrackActivity
  // attaching its own: the whole resolve/wake/connect sequence, which can
  // run for up to wakeTimeoutMs. A socket 'error' event with zero
  // listeners throws and takes the entire process down, not just this
  // connection, so this listener must be attached before anything else
  // touches the socket. Once splice takes over, its own 'error' listener
  // is simply an additional one; both fire, only one runs finish().
  socket.on('error', () => {})

  let read: { message: StartupMessage; raw: Buffer }
  try {
    read = await readMessage(socket)
  } catch (err) {
    sendErrorAndClose(socket, 'FATAL', PROTOCOL_VIOLATION, `malformed startup packet: ${errorMessage(err)}`)
    return
  }

  if (read.message.type === 'ssl_request') {
    // TLS termination is required eventually, the startup packet is
    // unreadable inside a TLS session otherwise, but it is explicitly not
    // built in this task (see docs/proxy/ for the follow-up). For now every
    // client is told plaintext is the only option; well-behaved Postgres
    // clients retry the startup packet unencrypted on the same connection
    // after seeing this single byte.
    if (!socket.writable) return
    socket.write(Buffer.from('N', 'ascii'))
    try {
      read = await readMessage(socket)
    } catch (err) {
      sendErrorAndClose(socket, 'FATAL', PROTOCOL_VIOLATION, `malformed startup packet: ${errorMessage(err)}`)
      return
    }
  }

  if (read.message.type === 'cancel_request') {
    // CancelRequest is routed, never treated as a wake. Real routing needs
    // a processId/secretKey to upstream-address registry built from the
    // BackendKeyData handed out on each connection's original startup,
    // which does not exist yet (out of scope for this task, see the task
    // report). Without it there is nothing to route a cancel to, and a
    // cancel against a sleeping resource has nothing to cancel regardless,
    // so the only safe move is to close without resolving or waking
    // anything.
    socket.end()
    return
  }

  if (read.message.type === 'ssl_request') {
    // A second SSLRequest immediately after the first is not a real
    // Postgres client behaviour; treat it as a protocol violation rather
    // than looping.
    sendErrorAndClose(socket, 'FATAL', PROTOCOL_VIOLATION, 'unexpected second SSLRequest')
    return
  }

  await handleStartup(socket, deps, wakeTimeoutMs, read.message, read.raw)
}

export function startPgProxy(opts: { port: number; host?: string; deps: ProxyDeps; wakeTimeoutMs: number }): Promise<{
  close(): Promise<void>
  port: number
}> {
  return new Promise((resolve, reject) => {
    const server = net.createServer((socket) => {
      handleConnectionInner(socket, opts.deps, opts.wakeTimeoutMs).catch((err) => {
        // Belt and suspenders: everything above already converts failures
        // into a real ErrorResponse. If something still throws past that
        // (a bug, not an expected failure mode), the socket must still not
        // be dropped silently.
        sendErrorAndClose(socket, 'FATAL', CANNOT_CONNECT_NOW, `internal proxy error: ${errorMessage(err)}`)
      })
    })

    server.once('error', reject)

    server.listen(opts.port, opts.host ?? '0.0.0.0', () => {
      server.off('error', reject)
      // A listener must stay attached for the life of the server: an
      // unhandled 'error' event on an EventEmitter throws and takes the
      // whole process down. Accept-level errors after startup (EMFILE, a
      // transient network hiccup) are not this connection's fault and must
      // not crash every other connection the proxy is holding open.
      server.on('error', () => {})
      const address = server.address()
      const port = typeof address === 'object' && address !== null ? address.port : opts.port

      resolve({
        port,
        close: () =>
          new Promise((res, rej) => {
            server.close((err) => (err ? rej(err) : res()))
          }),
      })
    })
  })
}
