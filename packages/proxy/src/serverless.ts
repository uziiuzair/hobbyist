// Neon's serverless driver endpoints, served on the Postgres proxy's own
// port. Issue #155.
//
// `@neondatabase/serverless` reaches Postgres two ways, and both arrive here:
//
//   - `neon()` and `Pool.query` with `poolQueryViaFetch`: `POST /sql`, JSON
//     in and out (sql-over-http.ts).
//   - `Pool` and `Client`: a WebSocket carrying the Postgres wire protocol,
//     `wss://<host>/v2` by default (websocket.ts, pipelined-auth.ts).
//
// Why the same port as Postgres. proxy.ts reads the first bytes of every
// accepted connection anyway, and neither an HTTP request line nor a TLS
// ClientHello can be the start of a valid Postgres startup packet (their
// first byte, read as the high byte of the packet's length, makes a length
// in the hundreds of megabytes, which parseStartup already rejects). So a
// connection is told apart on its first byte, at no cost to a Postgres
// client, and the endpoints inherit everything the port already has:
//
//   - **Where it listens** (ADR 0017). The same addresses `proxyHost`
//     resolves to, plus each project network's gateway. A box that has not
//     exposed its Postgres has not exposed this either; there is no new
//     listener and no new setting.
//   - **TLS** (ADR 0019). The proxy's own certificate, `proxyTls`. An HTTPS
//     or WSS client sends its ClientHello first, with no SSLRequest, and
//     proxy.ts hands that connection to the same terminator an SSLRequest
//     gets. Caddy's https was the alternative and was not taken, for the
//     reasons ADR 0019 gives for not sharing Caddy's certificate: Caddy is
//     off by default, and the database path should not depend on the HTTP
//     front door.
//   - **Routing, wake, cancel and activity.** Each WebSocket and each /sql
//     request becomes an in-memory connection (socket-pair.ts) given to the
//     proxy's ordinary connection handler, so a sleeping database is woken
//     exactly as a TCP connection wakes it and every request is a proxied
//     connection the hibernator counts.
//
// The one rule stricter than the Postgres port: **a request from another
// machine must arrive over TLS**, whether or not `proxyTls` is set. Over TCP,
// SCRAM keeps the password itself off the wire even without TLS; here it
// does not, since /sql carries the password in a header and the driver's
// default WebSocket login sends it in cleartext. A plaintext request from
// anything but loopback (or a project network's gateway listener, whose
// traffic never leaves the box) gets a 403 naming what to configure.
//
// Bun shapes the plumbing (ADR 0006, measured on Bun 1.3.5 and 1.3.14,
// 2026-11-17): handing an accepted socket to a node:http server with
// `server.emit('connection')` hangs, and a node:http 'upgrade' socket
// silently drops everything written to it. So the request head is read
// here, off the raw socket. An upgrade is answered here and framed by
// websocket.ts. Anything else is piped, head and all, to an internal
// node:http server on an ephemeral loopback port, the same relay pattern
// tls.ts uses for the same kind of reason, which works under both runtimes.
// That server sees every connection as coming from loopback, so the facts
// it needs (did this arrive over TLS, may it be plaintext) are recorded
// against the relay's local port before a byte is sent.

import http from 'node:http'
import net from 'node:net'
import type { Duplex } from 'node:stream'
import type { ClientAddress } from './access.js'
import { bridgeWithPipelinedPassword } from './pipelined-auth.js'
import { socketPair } from './socket-pair.js'
import { handleSql, handleSqlPreflight } from './sql-over-http.js'
import { checkUpgrade, handshakeResponse, parseHttpHead, WebSocketStream, type HttpHead } from './websocket.js'

// Matches proxy.ts's STARTUP_TIMEOUT_MS: a client that opens a connection
// and never finishes its request head does not get to hold it.
const HEAD_TIMEOUT_MS = 5000

export type ClientSocket = Duplex & { remoteAddress?: string | undefined }

export interface ConnectionOrigin {
  // The connection arrived over the proxy's TLS.
  encrypted: boolean
  // Whether this listener has a certificate at all, which only changes the
  // wording of a refusal.
  tlsConfigured: boolean
  // proxy.ts's plaintextAllowed: loopback in production, every peer on a
  // project network's gateway listener.
  plaintextAllowed: (address: string | undefined) => boolean
  // Who the client is, read from the socket the proxy accepted (access.ts).
  // Every in-memory connection this request opens carries it, which is what
  // keeps a /sql request or a WebSocket session under its project's IP
  // allowlist: the pair side itself has no address, and the internal HTTP
  // server below sees only its own loopback relay.
  client: ClientAddress
}

export interface ServerlessFrontDeps {
  // Gives one side of an in-memory connection to the proxy's connection
  // handler, as if it had just been accepted from `client`.
  connectToProxy(stream: Duplex, client: ClientAddress): void
  // Overrides for tests.
  maxRequestBytes?: number
  maxResponseBytes?: number
}

export interface ServerlessFront {
  accept(socket: ClientSocket, origin: ConnectionOrigin): void
  close(): Promise<void>
}

function refusal(origin: ConnectionOrigin): string {
  return origin.tlsConfigured
    ? 'this endpoint requires TLS for requests from other machines: use https:// for /sql and wss:// for WebSockets (neonConfig.useSecureWebSocket = true)'
    : 'this endpoint requires TLS for requests from other machines, and this proxy has no certificate: configure proxyTls (ADR 0019), or reach it over loopback'
}

function plainResponse(status: number, reason: string, body: string): string {
  return (
    `HTTP/1.1 ${status} ${reason}\r\n` +
    'Content-Type: text/plain; charset=utf-8\r\n' +
    'Access-Control-Allow-Origin: *\r\n' +
    `Content-Length: ${Buffer.byteLength(body)}\r\n` +
    'Connection: close\r\n\r\n' +
    body
  )
}

// Ends with a final write and, as proxy.ts's sendErrorAndClose does, forces
// the socket closed if the peer never acknowledges the FIN, so a refused
// client cannot hold the proxy's server.close() open.
function endAndClose(socket: ClientSocket, data: string): void {
  socket.end(data)
  const timer = setTimeout(() => socket.destroy(), 1000)
  timer.unref()
  socket.once('close', () => clearTimeout(timer))
}

function readHead(socket: ClientSocket): Promise<{ head: HttpHead; buffered: Buffer } | { error: string } | null> {
  return new Promise((resolve) => {
    let buffered = Buffer.alloc(0)
    let settled = false
    const finish = (result: { head: HttpHead; buffered: Buffer } | { error: string } | null): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.off('data', onData)
      socket.off('close', onClose)
      socket.pause()
      resolve(result)
    }
    const onData = (chunk: Buffer): void => {
      buffered = Buffer.concat([buffered, chunk])
      try {
        const head = parseHttpHead(buffered)
        if (head !== null) finish({ head, buffered })
      } catch (err) {
        finish({ error: err instanceof Error ? err.message : String(err) })
      }
    }
    const onClose = (): void => finish(null)
    const timer = setTimeout(() => finish({ error: 'request head not received in time' }), HEAD_TIMEOUT_MS)
    socket.on('data', onData)
    socket.on('close', onClose)
    socket.resume()
  })
}

interface RelayEntry {
  allowed: boolean
  origin: ConnectionOrigin
  // Takes the client's socket back from the relay, for an upgrade that
  // arrived on a kept-alive connection (see the 'upgrade' handler below).
  // Null when the relay is already gone.
  takeOver(): ClientSocket | null
}

function headFromRequest(req: http.IncomingMessage): HttpHead {
  const headers = new Map<string, string>()
  for (const [name, value] of Object.entries(req.headers)) {
    if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(', ') : value)
  }
  return { method: req.method ?? 'GET', target: req.url ?? '/', version: `HTTP/${req.httpVersion}`, headers, length: 0 }
}

export function createServerlessFront(deps: ServerlessFrontDeps): ServerlessFront {
  // Per relay connection, keyed by the relay's local port, which is the
  // remote port the internal server sees: whether that request may proceed.
  const origins = new Map<number, RelayEntry>()
  // Connections not yet answered or relayed, destroyed on close. A
  // WebSocket session moves to `sessions` instead, which close() ends with a
  // close frame: a client whose WebSocket drops without one reports an
  // error, and a daemon shutdown is a normal close, not an error.
  const live = new Set<ClientSocket>()
  const sessions = new Set<WebSocketStream>()
  let inner: Promise<{ server: http.Server; port: number }> | null = null
  let closed = false

  const openConnection = (client: ClientAddress): Duplex => {
    const [ours, theirs] = socketPair()
    deps.connectToProxy(theirs, client)
    return ours
  }

  const startInner = (): Promise<{ server: http.Server; port: number }> => {
    inner ??= new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => {
        const entry = origins.get(req.socket.remotePort ?? -1)
        const path = (req.url ?? '/').split('?')[0]
        if (entry === undefined) {
          res.writeHead(500).end()
          return
        }
        if (path === '/sql' && req.method === 'OPTIONS') {
          handleSqlPreflight(res)
          return
        }
        if (path === '/sql' && req.method === 'POST') {
          if (!entry.allowed) {
            const body = JSON.stringify({ message: refusal(entry.origin) })
            res.writeHead(403, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }).end(body)
            req.resume()
            return
          }
          const client = entry.origin.client
          void handleSql(req, res, {
            openConnection: () => openConnection(client),
            ...(deps.maxRequestBytes === undefined ? {} : { maxRequestBytes: deps.maxRequestBytes }),
            ...(deps.maxResponseBytes === undefined ? {} : { maxResponseBytes: deps.maxResponseBytes }),
          })
          return
        }
        res
          .writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
          .end('This is a Hobbyist Postgres proxy. It serves POST /sql and WebSocket upgrades for @neondatabase/serverless.\n')
        req.resume()
      })
      // An upgrade on a connection that has already carried a request, so it
      // reached this server rather than the head check in accept(). Node's
      // fetch and WebSocket share undici's connection pool, and it does send
      // a WebSocket upgrade down a kept-alive connection a /sql request just
      // used (measured, Node 26, 2026-11-17). This server cannot answer it
      // under Bun (see the file comment), so the client's socket is taken
      // back from the relay and the upgrade is answered on it directly. A
      // WebSocket client sends nothing after its request until it has read
      // the 101, so no byte is in flight in the relay to lose.
      server.on('upgrade', (req: http.IncomingMessage, socket: net.Socket, head: Buffer) => {
        const entry = origins.get(socket.remotePort ?? -1)
        const outer = entry?.takeOver() ?? null
        socket.destroy()
        if (entry === undefined || outer === null) return
        live.add(outer)
        outer.once('close', () => live.delete(outer))
        upgradeOrRefuse(outer, headFromRequest(req), head, entry.allowed, entry.origin)
      })
      server.on('clientError', (_err, socket: net.Socket) => socket.destroy())
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => {
        server.off('error', reject)
        server.on('error', () => {})
        const address = server.address()
        resolve({ server, port: typeof address === 'object' && address !== null ? address.port : 0 })
      })
    })
    return inner
  }

  const relay = async (socket: ClientSocket, buffered: Buffer, allowed: boolean, origin: ConnectionOrigin): Promise<void> => {
    const { port } = await startInner()
    if (socket.destroyed) return
    const upstream = net.createConnection({ host: '127.0.0.1', port })
    let key: number | null = null
    const finish = (): void => {
      if (key !== null) origins.delete(key)
      socket.destroy()
      upstream.destroy()
    }
    const onSocketClose = (): void => {
      upstream.destroy()
    }
    upstream.on('error', finish)
    socket.on('error', finish)
    socket.on('close', onSocketClose)
    upstream.on('close', finish)
    const entry: RelayEntry = {
      allowed,
      origin,
      takeOver: () => {
        if (socket.destroyed) return null
        if (key !== null) origins.delete(key)
        socket.unpipe(upstream)
        upstream.unpipe(socket as unknown as NodeJS.WritableStream)
        socket.off('error', finish)
        socket.off('close', onSocketClose)
        upstream.off('close', finish)
        upstream.off('error', finish)
        upstream.on('error', () => {})
        upstream.destroy()
        socket.pause()
        return socket
      },
    }
    upstream.once('connect', () => {
      // Recorded before any byte of the request is sent, so the internal
      // server cannot see the request before it can see this.
      key = upstream.localPort ?? null
      if (key !== null) origins.set(key, entry)
      upstream.write(buffered)
      socket.pipe(upstream)
      upstream.pipe(socket)
      socket.resume()
    })
  }

  const upgradeOrRefuse = (socket: ClientSocket, head: HttpHead, early: Buffer, allowed: boolean, origin: ConnectionOrigin): void => {
    const upgrade = checkUpgrade(head)
    if (upgrade === null || 'error' in upgrade) {
      endAndClose(socket, plainResponse(400, 'Bad Request', `${upgrade === null ? 'not a WebSocket upgrade' : upgrade.error}\n`))
      return
    }
    if (!allowed) {
      endAndClose(socket, plainResponse(403, 'Forbidden', `${refusal(origin)}\n`))
      return
    }
    // Any path is accepted, as Neon accepts any: the driver's default is
    // /v2, a string `wsProxy` gives `/?address=host:port`, and the routing
    // key is the database in the startup packet that follows, not the URL.
    socket.write(handshakeResponse(upgrade.key))
    const ws = new WebSocketStream(socket, early)
    live.delete(socket)
    sessions.add(ws)
    ws.once('close', () => sessions.delete(ws))
    bridgeWithPipelinedPassword(ws, openConnection(origin.client))
    socket.resume()
  }

  const accept = async (socket: ClientSocket, origin: ConnectionOrigin): Promise<void> => {
    socket.on('error', () => {})
    live.add(socket)
    socket.once('close', () => live.delete(socket))
    const read = await readHead(socket)
    if (read === null) return
    if ('error' in read) {
      endAndClose(socket, plainResponse(400, 'Bad Request', `${read.error}\n`))
      return
    }
    const { head, buffered } = read
    const allowed = origin.encrypted || origin.plaintextAllowed(socket.remoteAddress)
    if (checkUpgrade(head) === null) {
      await relay(socket, buffered, allowed, origin)
      return
    }
    upgradeOrRefuse(socket, head, buffered.subarray(head.length), allowed, origin)
  }

  return {
    accept(socket, origin): void {
      if (closed) {
        socket.destroy()
        return
      }
      accept(socket, origin).catch(() => socket.destroy())
    },
    async close(): Promise<void> {
      closed = true
      for (const socket of live) socket.destroy()
      live.clear()
      for (const ws of sessions) ws.destroy()
      sessions.clear()
      if (inner !== null) {
        const { server } = await inner
        await new Promise<void>((resolve) => {
          server.close(() => resolve())
          server.closeAllConnections?.()
        })
      }
    },
  }
}
