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
import { CancelRegistry, type CancelRoute } from './cancel.js'
import {
  buildCancelRequest,
  buildStartupPacket,
  errorResponse,
  parseStartup,
  scanBackendStartup,
  type StartupMessage,
} from './startup.js'

export interface ProxyTarget {
  resourceId: string
  host: string
  port: number
  state: string
  // The database this resolved resource's primary connection should use.
  // Required so the proxy can fill in `database` for a routing key with no
  // dot (`blog`, not `blog.analytics`): the client never named a specific
  // database in that case, and only `resolve` (backed by the resource's
  // stored config, see packages/pg's PostgresConfig.database) knows what
  // the project's actual default database is called.
  database: string
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

// A client that never sends a complete startup packet (connects and goes
// silent, or trickles a partial length prefix) must not hold this
// connection's socket, promise and listeners open forever: that is a
// one-line denial of service against the front door to every database on
// the box, and it is also why server.close() (which waits for open
// connections to end) would hang on daemon shutdown. This deadline only
// ever fires against a stalled or malicious client; a normal connect
// completes in well under it, so it adds no delay to the happy path the
// cold-start budget cares about.
const STARTUP_TIMEOUT_MS = 5000

// After sendErrorAndClose's socket.end(), a well-behaved peer closes
// promptly. An unresponsive or malicious one might never acknowledge the
// FIN, which would otherwise leave the socket half-open indefinitely and,
// same as the startup deadline above, keep server.close() from resolving.
// This is the hard-kill fallback: if the socket has not fully closed on
// its own within this grace window, force it.
const FORCE_CLOSE_GRACE_MS = 1000

// A single dial attempt's timeout, and the bounded retry around it. The
// retry exists for one specific race: deps.wake resolving a moment before
// Postgres is actually accepting connections, which would otherwise hand
// the client a hard ECONNREFUSED, exactly the experience wake-on-connect
// exists to eliminate. Attempts only continue on failure, never on the
// happy path, so a normal, already-listening upstream is dialed once with
// no added delay. Worst case total (3 attempts of 500ms plus 2 gaps of
// 100ms) is 1700ms, comfortably inside the 3 second hard cold-start
// ceiling even stacked on top of whatever the wake itself already took.
const DIAL_ATTEMPT_TIMEOUT_MS = 500
const DIAL_RETRY_INTERVAL_MS = 100
const DIAL_MAX_ATTEMPTS = 3

// libpq's real default order can be two encryption negotiation round trips
// before the actual startup packet: GSSENCRequest first (when gssencmode
// defaults to "prefer" and Kerberos credentials are cached), then
// SSLRequest (sslmode defaults to "prefer" too), each answered with a
// single 'N' before the client retries. Bounded so a client that just
// keeps sending negotiation requests cannot hold this loop open forever.
const MAX_ENCRYPTION_NEGOTIATIONS = 2

function errorMessage(err: unknown): string {
  if (err instanceof HobbyError) {
    return err.hint ? `${err.message} (${err.hint})` : err.message
  }
  return err instanceof Error ? err.message : String(err)
}

// Writes a real ErrorResponse and ends the socket. socket.end(buffer)
// flushes the buffer before sending FIN, so the client's read of the error
// is not racing the close: never a dropped socket, always a readable one.
// The follow-up timer is the hard-kill fallback described above FORCE_CLOSE_GRACE_MS:
// it guarantees this socket cannot linger past a bounded grace window
// regardless of whether the peer cooperates.
function sendErrorAndClose(socket: net.Socket, severity: string, code: string, message: string): void {
  if (socket.destroyed || !socket.writable) {
    return
  }
  socket.end(errorResponse(severity, code, message))
  const timer = setTimeout(() => {
    if (!socket.destroyed) {
      socket.destroy()
    }
  }, FORCE_CLOSE_GRACE_MS)
  socket.once('close', () => clearTimeout(timer))
}

function remainingMs(deadline: number): number {
  return Math.max(0, deadline - Date.now())
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// Buffers socket bytes until parseStartup can produce one complete message,
// then resolves with that message. Any bytes read past the message
// boundary are pushed back with socket.unshift so the next reader (a
// second readMessage call after an encryption negotiation request, or the
// eventual splice) sees them. Rejects if `timeoutMs` elapses first, or if
// the socket closes or errors before a complete message arrives.
function readMessage(socket: net.Socket, timeoutMs: number): Promise<StartupMessage> {
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0)
    let settled = false

    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      cleanup()
      reject(new Error(`no complete startup packet within ${timeoutMs}ms`))
    }, timeoutMs)

    const cleanup = (): void => {
      clearTimeout(timer)
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
      const rest = buffer.subarray(result.consumed)
      if (rest.length > 0) {
        socket.unshift(rest)
      }
      resolve(result.message)
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

function connectUpstreamOnce(host: string, port: number, timeoutMs: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port })
    let settled = false

    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      cleanup()
      socket.destroy()
      reject(new Error(`connect to ${host}:${port} timed out after ${timeoutMs}ms`))
    }, timeoutMs)

    const cleanup = (): void => {
      clearTimeout(timer)
      socket.off('connect', onConnect)
      socket.off('error', onError)
    }
    const onConnect = (): void => {
      if (settled) return
      settled = true
      cleanup()
      resolve(socket)
    }
    const onError = (err: Error): void => {
      if (settled) return
      settled = true
      cleanup()
      reject(err)
    }

    socket.once('connect', onConnect)
    socket.once('error', onError)
  })
}

// Bounded retry wrapper around a single dial attempt. See
// DIAL_ATTEMPT_TIMEOUT_MS / DIAL_RETRY_INTERVAL_MS / DIAL_MAX_ATTEMPTS above
// for the budget reasoning. The retry interval is only ever awaited after a
// failed attempt, never unconditionally, so this adds no delay when the
// first attempt succeeds.
async function connectUpstream(host: string, port: number): Promise<net.Socket> {
  let lastErr: unknown
  for (let attempt = 1; attempt <= DIAL_MAX_ATTEMPTS; attempt++) {
    try {
      return await connectUpstreamOnce(host, port, DIAL_ATTEMPT_TIMEOUT_MS)
    } catch (err) {
      lastErr = err
      if (attempt < DIAL_MAX_ATTEMPTS) {
        await sleep(DIAL_RETRY_INTERVAL_MS)
      }
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr))
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

// Attaches the activity tracker, registers the connection for cancellation,
// and pipes both directions. activity.close fires exactly once per
// connection: `closed` is the guard. Whichever of client close, upstream
// close, client error or upstream error happens first calls finish(); every
// other event after that is a no-op. Tearing down both sockets in finish()
// (rather than only the one that fired) is what stops the other side from
// being left half-open forever once its peer is gone.
//
// The two directions are not symmetric. Client to backend is a plain pipe
// and always was: nothing a client sends after the startup packet is the
// proxy's business. Backend to client is read one message at a time until
// ReadyForQuery, purely so BackendKeyData can be swapped for a key this
// proxy can route a cancel on, and then becomes a plain pipe too. The cost
// is bounded by the startup phase; query traffic is never parsed.
function spliceAndTrackActivity(
  client: net.Socket,
  upstream: net.Socket,
  activity: ActivityTracker,
  cancels: CancelRegistry,
  target: ProxyTarget
): void {
  const handle = activity.open(target.resourceId)
  // Registered before the backend has said anything, because the address is
  // already known and the key it will send is not. scanBackendStartup fills
  // in backendKey when BackendKeyData arrives; until then lookup refuses to
  // resolve this entry.
  const route: CancelRoute = { host: target.host, port: target.port, backendKey: null }
  const minted = cancels.add(route)
  let closed = false

  const finish = (): void => {
    if (closed) return
    closed = true
    // Before activity.close, so that the map is bounded by live connections
    // even if something below throws.
    if (minted !== null) {
      cancels.remove(minted)
    }
    activity.close(handle)
    client.destroy()
    upstream.destroy()
  }

  client.on('close', finish)
  client.on('error', finish)
  upstream.on('close', finish)
  upstream.on('error', finish)

  client.pipe(upstream)

  // No key to hand the client means nothing to look a cancel up by, so
  // there is nothing to gain by reading the backend's startup messages.
  // This connection behaves exactly as every connection did before cancel
  // routing existed.
  if (minted === null) {
    upstream.pipe(client)
    return
  }

  // Annotated rather than inferred: Buffer.alloc gives Buffer<ArrayBuffer>
  // and subarray gives the wider Buffer<ArrayBufferLike>, so the inferred
  // type would reject the reassignment below.
  let pending: Buffer = Buffer.alloc(0)

  const onBackendData = (chunk: Buffer): void => {
    pending = pending.length === 0 ? chunk : Buffer.concat([pending, chunk])

    const scan = scanBackendStartup(pending, minted)
    if (scan.backendKey !== null) {
      route.backendKey = scan.backendKey
    }
    if (scan.forward.length > 0) {
      // The write return value is deliberately ignored. Honouring
      // backpressure here would mean pausing the backend mid-handshake, and
      // the total volume being written is one authentication exchange and a
      // handful of ParameterStatus messages: kilobytes, once, per
      // connection. The moment that phase ends, pipe() takes over and
      // backpressure is handled properly for everything that matters.
      client.write(scan.forward)
    }
    pending = pending.subarray(scan.consumed)

    if (!scan.done) {
      return
    }

    // Startup is over. Hand the rest of this connection to pipe(), which is
    // what it was doing before and what it does for the whole session after.
    // The listener is removed and pipe attached in the same tick, so no
    // chunk can arrive in between.
    upstream.off('data', onBackendData)
    if (pending.length > 0) {
      client.write(pending)
      pending = Buffer.alloc(0)
    }
    upstream.pipe(client)
  }

  upstream.on('data', onBackendData)
}

// A CancelRequest is a second connection carrying nothing but the key pair,
// so this key is the entire routing decision: no database name to resolve,
// no user, nothing to wake. An unknown key closes silently, which is both
// what a real Postgres does with a key it does not recognise and what this
// proxy did with every cancel before routing existed.
async function handleCancel(
  socket: net.Socket,
  cancels: CancelRegistry,
  message: Extract<StartupMessage, { type: 'cancel_request' }>
): Promise<void> {
  const route = cancels.lookup({ processId: message.processId, secretKey: message.secretKey })
  if (route === null) {
    socket.end()
    return
  }

  let upstream: net.Socket
  try {
    // One attempt, no retry. The dial in handleStartup retries because it
    // may be racing a container that is still coming up; this one cannot
    // be, since an entry in the registry means a connection is spliced to
    // this address right now.
    upstream = await connectUpstreamOnce(route.host, route.port, DIAL_ATTEMPT_TIMEOUT_MS)
  } catch {
    // Nothing useful to tell the client: the protocol has no reply to a
    // cancel, successful or otherwise.
    socket.end()
    return
  }
  upstream.on('error', () => {})

  // The backend's own key, not the one the client presented. Postgres reads
  // the request and closes without replying, so this connection exists only
  // to carry these 16 bytes.
  upstream.end(buildCancelRequest(route.backendKey))
  socket.end()
}

async function handleStartup(
  socket: net.Socket,
  deps: ProxyDeps,
  cancels: CancelRegistry,
  wakeTimeoutMs: number,
  message: Extract<StartupMessage, { type: 'startup' }>
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
    // The client may already be gone by the time we would even start a
    // multi-second wake; no point pinning a resource awake for nobody.
    if (socket.destroyed) {
      return
    }

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

  // The client may have disconnected during the wake, which can run for
  // seconds. Dialing upstream and opening activity tracking for a socket
  // that is already gone would pin the resource awake and leak an upstream
  // connection for no one; check again, immediately before the dial.
  if (socket.destroyed) {
    return
  }

  let upstream: net.Socket
  try {
    upstream = await connectUpstream(target.host, target.port)
  } catch (err) {
    sendErrorAndClose(socket, 'FATAL', CANNOT_CONNECT_NOW, `could not connect to ${target.resourceId}: ${errorMessage(err)}`)
    return
  }
  // Same reasoning as the safety net on the client socket in
  // handleConnectionInner: connectUpstreamOnce's own 'error' listener is
  // detached the moment it resolves, and an unhandled 'error' on this
  // socket would otherwise crash the process rather than just this
  // connection.
  upstream.on('error', () => {})

  // And check once more: the client could have disconnected in the (very
  // short, but non-zero, especially across dial retries) window between
  // deciding to dial and the dial actually completing. If so, there is no
  // one to splice to; tear the fresh upstream connection down rather than
  // leak it, and never call activity.open for a connection that never
  // really existed from the client's side.
  if (socket.destroyed) {
    upstream.destroy()
    return
  }

  // Auth passes through: every parameter and its order is carried over
  // unchanged from the parsed startup packet. The one deliberate edit is
  // the `database` value, substituted for the actual database name this
  // resolved resource should see: the routing key's project segment
  // (`blog` in `blog.analytics`) is never a real Postgres database, and a
  // bare project with no dot needs the project's own default database
  // filled in, which only `resolve` knows. Nothing else is touched, so
  // SCRAM still negotiates directly between the client and Postgres and
  // this proxy never sees a password.
  const finalDatabase = routingKey.database ?? target.database
  const packet = buildStartupPacket({ ...message.params, database: finalDatabase }, message.version)
  upstream.write(packet)
  spliceAndTrackActivity(socket, upstream, deps.activity, cancels, target)
}

async function handleConnectionInner(
  socket: net.Socket,
  deps: ProxyDeps,
  cancels: CancelRegistry,
  wakeTimeoutMs: number
): Promise<void> {
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

  const deadline = Date.now() + STARTUP_TIMEOUT_MS

  let read: StartupMessage
  try {
    read = await readMessage(socket, remainingMs(deadline))
  } catch (err) {
    sendErrorAndClose(socket, 'FATAL', PROTOCOL_VIOLATION, `malformed startup packet: ${errorMessage(err)}`)
    return
  }

  // TLS/GSS termination is required eventually: the startup packet is
  // unreadable inside a TLS session otherwise, and this is recorded as the
  // explicit next step in docs/proxy/, not built here. For now every
  // client is told plaintext is the only option for both encryption
  // negotiation requests; a well-behaved client retries on the same
  // connection after seeing the single 'N'. Looping (bounded) rather than
  // handling only one is what makes a real libpq default (gssencmode and
  // sslmode both "prefer": GSSENCRequest, then SSLRequest, then the real
  // startup packet) actually work end to end.
  for (let i = 0; i < MAX_ENCRYPTION_NEGOTIATIONS && (read.type === 'ssl_request' || read.type === 'gss_enc_request'); i++) {
    if (!socket.writable) return
    socket.write(Buffer.from('N', 'ascii'))
    try {
      read = await readMessage(socket, remainingMs(deadline))
    } catch (err) {
      sendErrorAndClose(socket, 'FATAL', PROTOCOL_VIOLATION, `malformed startup packet: ${errorMessage(err)}`)
      return
    }
  }

  if (read.type === 'ssl_request' || read.type === 'gss_enc_request') {
    sendErrorAndClose(socket, 'FATAL', PROTOCOL_VIOLATION, 'too many encryption negotiation requests')
    return
  }

  if (read.type === 'cancel_request') {
    // Routed, never treated as a wake: handleCancel neither resolves a
    // routing key nor calls deps.wake. The registry it reads only holds
    // connections that are spliced right now, so a cancel can never be the
    // thing that starts a container.
    await handleCancel(socket, cancels, read)
    return
  }

  await handleStartup(socket, deps, cancels, wakeTimeoutMs, read)
}

export function startPgProxy(opts: { port: number; host?: string; deps: ProxyDeps; wakeTimeoutMs: number }): Promise<{
  close(): Promise<void>
  port: number
}> {
  return new Promise((resolve, reject) => {
    // One registry per server, holding one entry per spliced connection. It
    // is deliberately not part of ProxyDeps: the daemon supplies the world
    // this proxy cannot see for itself, and this is the opposite, state that
    // only exists because connections pass through here.
    const cancels = new CancelRegistry()

    const server = net.createServer((socket) => {
      handleConnectionInner(socket, opts.deps, cancels, opts.wakeTimeoutMs).catch((err) => {
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
