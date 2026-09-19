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
import type { ActivityTracker, ConnectionHandle } from './activity.js'
import { CancelRegistry, type CancelRoute } from './cancel.js'
import {
  buildCancelRequest,
  buildStartupPacket,
  CANNOT_CONNECT_NOW,
  classifyBackendAnswer,
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

// The pause between a backend refusing a session with 57P03 ("the database
// system is starting up") and the next attempt at one. See holdUntilServing
// for the whole mechanism. Only ever slept after a refusal, never on the
// happy path, so a backend that is serving answers the first attempt and
// pays nothing for this. 100ms matches DIAL_RETRY_INTERVAL_MS: fine enough
// that a crash recovery finishing mid-wait costs the client at most a tenth
// of a second of the 1 second cold-start target, coarse enough that a client
// held for the whole budget costs Postgres ten short-lived refused backends
// a second rather than a busy loop.
const READY_RETRY_INTERVAL_MS = 100

// The least time a freshly dialed backend is given to say anything at all,
// however little of the connection's budget is left. The budget exists to
// bound how long a client is held through refusals; it must not turn a wake
// that succeeded late in its window into a failure because a healthy backend
// took two milliseconds to send AuthenticationRequest after the deadline
// passed. Same figure as a single dial attempt's timeout.
const FIRST_ANSWER_FLOOR_MS = DIAL_ATTEMPT_TIMEOUT_MS

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
//
// The activity handle arrives already open rather than being opened here,
// because the connection counts as activity from the moment its first dial
// succeeds, not from the moment the backend agreed to serve it:
// holdUntilServing can keep a client waiting on a starting backend for a
// while, and that client is using this resource the whole time. `initial`
// is what the backend already sent while holdUntilServing was deciding
// whether it was serving at all, and `upstream` arrives paused so nothing it
// sent since is lost before the listeners below exist.
function spliceAndTrackActivity(
  client: net.Socket,
  upstream: net.Socket,
  activity: ActivityTracker,
  handle: ConnectionHandle,
  cancels: CancelRegistry,
  target: ProxyTarget,
  initial: Buffer
): void {
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
    if (initial.length > 0) {
      client.write(initial)
    }
    upstream.pipe(client)
    closeIfAlreadyGone(upstream, finish)
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
  // After the listener, not before: if the bytes holdUntilServing already
  // read run all the way to ReadyForQuery, onBackendData hands over to
  // pipe() and detaches itself, and that detach has to find it attached.
  if (initial.length > 0) {
    onBackendData(initial)
  }
  upstream.resume()
  closeIfAlreadyGone(upstream, finish)
}

// The backend can fail (a reset, an error) in the gap between
// holdUntilServing letting go of the upstream socket and the listeners above
// being attached, and its 'close' event would then have fired to nobody,
// leaving both sockets and the activity handle open for good. `destroyed` is
// set synchronously by that failure, so checking it once, after the
// listeners exist, covers the gap; finish is idempotent if 'close' also
// arrives.
function closeIfAlreadyGone(upstream: net.Socket, finish: () => void): void {
  if (upstream.destroyed) {
    finish()
  }
}

type BackendAnswerWait =
  | { kind: 'answered'; bytes: Buffer }
  | { kind: 'not_ready'; message: string }
  | { kind: 'closed' }
  | { kind: 'timeout' }
  | { kind: 'client_gone' }

// Reads the backend's first answer to the startup packet, and forwards none
// of it. See classifyBackendAnswer in startup.ts for what counts as an
// answer. Resolves with the upstream socket paused on 'answered', so bytes
// that arrive between this resolving and spliceAndTrackActivity attaching its
// own listener wait in the socket's buffer rather than being emitted to no
// listener and lost.
//
// Also watches the client, because a client that gives up while its backend
// is refusing it must end the hold rather than keep dialing for nobody.
function awaitBackendAnswer(client: net.Socket, upstream: net.Socket, timeoutMs: number): Promise<BackendAnswerWait> {
  return new Promise((resolve) => {
    let received: Buffer = Buffer.alloc(0)
    let settled = false

    const settle = (result: BackendAnswerWait): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      upstream.off('data', onData)
      upstream.off('close', onUpstreamClose)
      client.off('close', onClientClose)
      if (result.kind === 'answered') {
        upstream.pause()
      }
      resolve(result)
    }

    const onData = (chunk: Buffer): void => {
      received = received.length === 0 ? chunk : Buffer.concat([received, chunk])
      const answer = classifyBackendAnswer(received)
      if (answer.kind === 'incomplete') return
      settle(answer.kind === 'answered' ? { kind: 'answered', bytes: received } : answer)
    }
    const onUpstreamClose = (): void => settle({ kind: 'closed' })
    const onClientClose = (): void => settle({ kind: 'client_gone' })
    const timer = setTimeout(() => settle({ kind: 'timeout' }), timeoutMs)

    upstream.on('data', onData)
    upstream.on('close', onUpstreamClose)
    client.on('close', onClientClose)
    if (client.destroyed) {
      settle({ kind: 'client_gone' })
    }
  })
}

type HoldResult =
  | { kind: 'serving'; upstream: net.Socket; initial: Buffer; handle: ConnectionHandle }
  | { kind: 'refused'; message: string }
  | { kind: 'client_gone' }

// Dials the backend and replays the startup packet, and keeps doing that for
// as long as the backend answers "the database system is starting up" and
// the budget allows. Issue #9.
//
// Why this is needed on top of the wake: the wake path already waits for a
// real authenticated connection before it resolves (startPostgres waits on
// pgProbe, packages/pg/src/readiness.ts), but a target whose recorded state
// is `running` skips the wake entirely, and `running` is a record, not an
// observation. A container that crashed and was restarted outside the daemon
// (the recorded state never changed), or one still finishing crash recovery,
// accepts the TCP dial and then refuses the session with FATAL 57P03. Before
// this, that FATAL went straight to the client milliseconds after connect,
// which is precisely the experience wake-on-connect exists to eliminate.
//
// Why a retry is safe: 57P03 is the backend's answer to the startup packet
// itself, sent before any authentication exchange, and it is followed by the
// backend closing the connection. Nothing has passed between this client and
// any backend except the startup packet, which this proxy holds a copy of
// (the rebuilt `packet`), and nothing the backend said has been forwarded,
// because awaitBackendAnswer forwards nothing. So the refused connection is
// discarded and a fresh one is dialed with the identical packet, and the
// client, still waiting for its first reply, cannot tell the difference
// between that and a backend that was slow to answer. The moment the answer
// is anything else (an authentication request, a different error), it is
// the backend's real answer and the client gets it untouched.
//
// Bounded by `deadline`, the same wakeTimeoutMs budget a sleeping target's
// wake gets, and ending in a real ErrorResponse naming what the backend last
// said, never a dropped socket. A healthy backend is dialed once and its
// first answer spliced the moment it arrives: there is no probe connection
// and no sleep on that path, only the wait for a reply the client was
// waiting for anyway.
//
// Activity is opened on the first successful dial, the moment it always was,
// and held across every retry after it: a client waiting on this resource is
// using it, and a hibernator tick that saw zero connections could otherwise
// stop the very backend being waited on. It is handed to the splice on
// 'serving' and closed here on every other way out, exactly once.
async function holdUntilServing(
  client: net.Socket,
  target: ProxyTarget,
  packet: Buffer,
  deadline: number,
  budgetMs: number,
  activity: ActivityTracker
): Promise<HoldResult> {
  let handle: ConnectionHandle | null = null
  const release = <T extends HoldResult>(result: T): T => {
    if (handle !== null) {
      activity.close(handle)
      handle = null
    }
    return result
  }
  let lastRefusal: string | null = null
  for (;;) {
    let upstream: net.Socket
    try {
      upstream = await connectUpstream(target.host, target.port)
    } catch (err) {
      return release({ kind: 'refused', message: `could not connect to ${target.resourceId}: ${errorMessage(err)}` })
    }
    // Same reasoning as the safety net on the client socket in
    // handleConnectionInner: connectUpstreamOnce's own 'error' listener is
    // detached the moment it resolves, and an unhandled 'error' on this
    // socket would otherwise crash the process rather than just this
    // connection.
    upstream.on('error', () => {})

    // The client could have disconnected in the (very short, but non-zero,
    // especially across dial retries) window between deciding to dial and
    // the dial actually completing. If so, there is no one to splice to;
    // tear the fresh upstream connection down rather than leak it, and
    // never call activity.open for a connection that never really existed
    // from the client's side.
    if (client.destroyed) {
      upstream.destroy()
      return release({ kind: 'client_gone' })
    }
    handle ??= activity.open(target.resourceId)

    upstream.write(packet)
    const answer = await awaitBackendAnswer(client, upstream, Math.max(remainingMs(deadline), FIRST_ANSWER_FLOOR_MS))
    if (answer.kind === 'answered') {
      return { kind: 'serving', upstream, initial: answer.bytes, handle }
    }
    upstream.destroy()

    if (answer.kind === 'client_gone') {
      return release({ kind: 'client_gone' })
    }
    if (answer.kind === 'closed') {
      // Not retried. A backend that accepts and then hangs up without a
      // word is not saying "starting up", and nothing in this issue's
      // evidence says waiting would change its mind. It used to reach the
      // client as a dropped socket, and now reaches it as a real error.
      return release({ kind: 'refused', message: `${target.resourceId} closed the connection without answering` })
    }
    if (answer.kind === 'timeout') {
      const said = lastRefusal === null ? '' : ` (it last said: ${lastRefusal})`
      return release({ kind: 'refused', message: `${target.resourceId} accepted the connection but did not answer${said}` })
    }

    lastRefusal = answer.message
    if (remainingMs(deadline) < READY_RETRY_INTERVAL_MS) {
      return release({
        kind: 'refused',
        message: `${target.resourceId} was still not accepting connections after ${budgetMs}ms: ${lastRefusal}`,
      })
    }
    await sleep(READY_RETRY_INTERVAL_MS)
    if (client.destroyed) {
      return release({ kind: 'client_gone' })
    }
  }
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

  // One budget for the whole connection attempt, a wake included, so that
  // holdUntilServing below cannot stack a second full wakeTimeoutMs on top of
  // a wake that already spent most of one.
  const deadline = Date.now() + wakeTimeoutMs

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

  const held = await holdUntilServing(socket, target, packet, deadline, wakeTimeoutMs, deps.activity)
  if (held.kind === 'refused') {
    sendErrorAndClose(socket, 'FATAL', CANNOT_CONNECT_NOW, held.message)
    return
  }
  if (held.kind === 'client_gone') {
    return
  }
  spliceAndTrackActivity(socket, held.upstream, deps.activity, held.handle, cancels, target, held.initial)
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
