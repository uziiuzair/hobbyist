// The HTTP half of the wake router. This file is to port 443 what proxy.ts
// is to port 5432, and it exists for one reason stated in ADR 0009: Caddy
// terminates TLS and routes, but nothing in Caddy knows how to start a
// stopped container. So the wake trigger stays here, and every request to an
// app or a worker passes through this file on its way to an upstream.
//
// Same seam as the Postgres proxy, and for the same reason: this file never
// imports Docker, never touches a store, never starts a container. It
// resolves a hostname to an address, calls wake(resourceId) and waits, then
// splices. Everything about the world arrives through the injected
// HttpProxyDeps, which is what makes the whole wake path testable against a
// fake with no Docker in the loop.

import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import net from 'node:net'
import type { Duplex } from 'node:stream'
import type { ActivityTracker, ConnectionHandle } from './activity.js'

export interface HttpTarget {
  resourceId: string
  host: string
  port: number
  // The resource's recorded state, as the store has it. Anything other than
  // 'running' means this request pays for a wake before it is served.
  state: string
}

export interface HttpProxyDeps {
  // Hostname only: no port, already lowercased. Resolving is the daemon's
  // job because only it knows what hostnames exist; null means "no app or
  // worker answers to this name", which is a 404 rather than an error.
  resolve(hostname: string): Promise<HttpTarget | null>
  // Safe to call concurrently. Ten simultaneous requests to a sleeping app
  // each call this and each await it; de-duplicating them into one container
  // start is the daemon's responsibility (see getOrCreateWake in the
  // daemon's context.ts), exactly as it is for the Postgres proxy.
  wake(resourceId: string): Promise<void>
  activity: ActivityTracker
  // Caddy's on-demand TLS ask check: "is this hostname one you serve?"
  // Answered before a certificate is issued for a name nobody configured
  // ahead of time. Optional; absent means on-demand TLS is not in use and
  // the endpoint answers 404 for everything.
  //
  // This must NOT wake anything and must not enumerate. It is the one
  // unauthenticated surface in the whole system that a stranger can reach
  // deliberately, so it answers exactly one bit and does no work.
  allowHostname?(hostname: string): Promise<boolean>
}

export interface HttpRouterOptions {
  // How long a request will wait for a sleeping resource before giving up.
  // Distinct from the cold start BUDGET (1s target, 3s ceiling, see
  // docs/compute/specs/2026-08-10-phase-2-compute-design.md): the budget is
  // what we promise, this is the point past which we stop waiting and say
  // so. Deliberately well above the ceiling, because a slow wake that
  // eventually succeeds is a bad experience and a wake cut off at exactly
  // the ceiling is a broken one.
  wakeTimeoutMs?: number
  // How long to wait for the upstream to accept a connection once the
  // resource is running.
  upstreamTimeoutMs?: number
}

// The one path this router answers itself rather than proxying. Exported so
// the daemon can build the ask URL it hands Caddy from the same constant.
export const TLS_ASK_PATH = '/.hobby/tls-ask'

const DEFAULT_WAKE_TIMEOUT_MS = 30_000
const DEFAULT_UPSTREAM_TIMEOUT_MS = 10_000

// Headers that describe a single hop and must not be forwarded to the
// upstream. RFC 9110 section 7.6.1. `upgrade` and `connection` are handled
// separately by the upgrade path below; forwarding them on an ordinary
// request would make Node's own client emit a malformed message.
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailers',
  'transfer-encoding',
  'upgrade',
])

// The Host header, minus any port, lowercased. Returns null for a request
// with no Host at all, which is malformed for HTTP/1.1 and cannot be routed
// since the hostname IS the routing key here.
export function hostnameFrom(hostHeader: string | undefined): string | null {
  if (hostHeader === undefined || hostHeader.length === 0) {
    return null
  }
  // An IPv6 literal arrives bracketed ("[::1]:8080"), so the last colon is
  // only a port separator when it falls outside the brackets.
  const closingBracket = hostHeader.lastIndexOf(']')
  const colon = hostHeader.lastIndexOf(':')
  const withoutPort = colon > closingBracket ? hostHeader.slice(0, colon) : hostHeader
  const trimmed = withoutPort.trim().toLowerCase()
  return trimmed.length === 0 ? null : trimmed
}

function forwardableHeaders(req: IncomingMessage): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {}
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined || HOP_BY_HOP.has(name)) {
      continue
    }
    out[name] = value
  }
  return out
}

function sendPlain(res: ServerResponse, status: number, body: string): void {
  if (res.headersSent || res.writableEnded) {
    return
  }
  res.writeHead(status, {
    'content-type': 'text/plain; charset=utf-8',
    'content-length': String(Buffer.byteLength(body)),
    // A wake failure is about this moment, not about this URL. Caching it
    // would make one slow start look like a permanently broken app.
    'cache-control': 'no-store',
  })
  res.end(body)
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (err: unknown) => {
        clearTimeout(timer)
        reject(err instanceof Error ? err : new Error(String(err)))
      }
    )
  })
}

export interface HttpRouter {
  handleRequest(req: IncomingMessage, res: ServerResponse): void
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void
}

export function createHttpRouter(deps: HttpProxyDeps, opts: HttpRouterOptions = {}): HttpRouter {
  const wakeTimeoutMs = opts.wakeTimeoutMs ?? DEFAULT_WAKE_TIMEOUT_MS
  const upstreamTimeoutMs = opts.upstreamTimeoutMs ?? DEFAULT_UPSTREAM_TIMEOUT_MS

  // Three outcomes, deliberately distinguished, because they mean different
  // things to whoever is looking at the browser tab:
  //
  //   { kind: 'target' }    ready to serve
  //   { kind: 'missing' }   no app answers to this hostname (404)
  //   { kind: 'refused' }   something answers, but cannot be served, and the
  //                         reason is worth printing (503). A released
  //                         project is the case that exists today: its
  //                         container belongs to the user's own compose stack
  //                         now, so waking it would start a second copy.
  //   { kind: 'timeout' }   the wake did not finish in time (504)
  type Resolution =
    | { kind: 'target'; target: HttpTarget }
    | { kind: 'missing' }
    | { kind: 'refused'; reason: string }
    | { kind: 'timeout'; reason: string }

  async function resolveAndWake(hostname: string): Promise<Resolution> {
    let target: HttpTarget | null
    try {
      target = await deps.resolve(hostname)
    } catch (err) {
      return { kind: 'refused', reason: err instanceof Error ? err.message : String(err) }
    }
    if (target === null) {
      return { kind: 'missing' }
    }
    if (target.state === 'running') {
      return { kind: 'target', target }
    }
    // The whole product, in one line: the client is not told the app is
    // asleep, it is made to wait. wake() must not resolve until the upstream
    // is genuinely accepting connections, which is the kind handler's
    // contract (ResourceKindHandler.start waits on probe()).
    try {
      await withTimeout(deps.wake(target.resourceId), wakeTimeoutMs, `wake timed out after ${wakeTimeoutMs}ms`)
    } catch (err) {
      return { kind: 'timeout', reason: err instanceof Error ? err.message : String(err) }
    }
    // Re-read: the resource's address cannot change across a wake today,
    // but reading the post-wake state is what the Postgres proxy does after
    // its own wake and matching it costs one call.
    const woken = await deps.resolve(hostname).catch(() => null)
    return { kind: 'target', target: woken ?? target }
  }

  // Caddy asks this before issuing a certificate for a hostname nobody
  // configured. Returns true if the request was handled here and must not be
  // proxied.
  //
  // Gated on the request arriving at the loopback literal rather than on the
  // path alone, so this cannot shadow a path in somebody's deployed app: an
  // app is only ever reached under `<resource>.<project>.<domain>`, which is
  // never `127.0.0.1`.
  function handleInternal(hostname: string, req: IncomingMessage, res: ServerResponse): boolean {
    if (hostname !== '127.0.0.1' && hostname !== '::1') {
      return false
    }
    const path = (req.url ?? '').split('?')[0]
    if (path !== TLS_ASK_PATH) {
      return false
    }

    const asked = new URL(req.url ?? '/', 'http://127.0.0.1').searchParams.get('domain')
    if (asked === null || deps.allowHostname === undefined) {
      sendPlain(res, 404, 'no\n')
      return true
    }
    void deps.allowHostname(asked.toLowerCase()).then(
      (allowed) => sendPlain(res, allowed ? 200 : 404, allowed ? 'ok\n' : 'no\n'),
      // A store error must read as "no". Answering yes on failure would let
      // a lookup outage become an open certificate-issuance endpoint.
      () => sendPlain(res, 404, 'no\n')
    )
    return true
  }

  function handleRequest(req: IncomingMessage, res: ServerResponse): void {
    const hostname = hostnameFrom(req.headers.host)
    if (hostname === null) {
      sendPlain(res, 400, 'hobby: this request carried no Host header, and the hostname is how a request finds an app.\n')
      return
    }
    if (handleInternal(hostname, req, res)) {
      return
    }

    void (async (): Promise<void> => {
      const resolution = await resolveAndWake(hostname)
      if (resolution.kind === 'missing') {
        sendPlain(res, 404, `hobby: nothing is deployed at ${hostname}.\n`)
        return
      }
      if (resolution.kind === 'refused') {
        sendPlain(res, 503, `hobby: ${hostname} cannot be served right now. ${resolution.reason}\n`)
        return
      }
      if (resolution.kind === 'timeout') {
        sendPlain(res, 504, `hobby: ${hostname} did not wake up in time (${resolution.reason}).\n`)
        return
      }
      const target = resolution.target

      // Activity is opened AFTER the wake, not before. A request that
      // waits three seconds for a container to start has not been using
      // that container for three seconds, and counting it as such would
      // move the idle clock for a stretch when nothing was served.
      const handle = deps.activity.open(target.resourceId)
      let released = false
      const release = (): void => {
        if (released) return
        released = true
        deps.activity.close(handle)
      }

      const upstream = httpRequest(
        {
          host: target.host,
          port: target.port,
          method: req.method,
          path: req.url,
          headers: forwardableHeaders(req),
          timeout: upstreamTimeoutMs,
        },
        (upstreamRes) => {
          res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers)
          upstreamRes.pipe(res)
          // Released when the RESPONSE ends, not when the request is sent.
          // A streaming response (Server-Sent Events, a long download) is
          // the app being used for its whole duration, and releasing early
          // would let hibernation sleep a container mid-stream.
          upstreamRes.on('end', release)
          upstreamRes.on('close', release)
        }
      )

      upstream.on('timeout', () => {
        upstream.destroy(new Error(`upstream did not respond within ${upstreamTimeoutMs}ms`))
      })

      upstream.on('error', (err: Error) => {
        release()
        sendPlain(res, 502, `hobby: ${hostname} is running but did not answer (${err.message}).\n`)
      })

      // A client that hangs up mid-request must not leave the upstream
      // request open, and must not leave an activity handle behind either:
      // an unreleased handle is a resource that never goes idle and
      // therefore never sleeps again, which is the wedge quietly failing.
      res.on('close', () => {
        release()
        if (!upstream.destroyed) {
          upstream.destroy()
        }
      })

      req.pipe(upstream)
    })()
  }

  // WebSockets and any other Upgrade. Node hands us the raw socket with the
  // request already parsed, so this path reconstructs the request line and
  // headers verbatim and then gets out of the way: after the upgrade there
  // is no HTTP framing left to reason about, only bytes, exactly like the
  // Postgres proxy's splice.
  function handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const hostname = hostnameFrom(req.headers.host)
    if (hostname === null) {
      socket.end('HTTP/1.1 400 Bad Request\r\n\r\n')
      return
    }

    void (async (): Promise<void> => {
      const resolution = await resolveAndWake(hostname)
      if (resolution.kind === 'missing') {
        socket.end('HTTP/1.1 404 Not Found\r\n\r\n')
        return
      }
      if (resolution.kind === 'refused') {
        socket.end('HTTP/1.1 503 Service Unavailable\r\n\r\n')
        return
      }
      if (resolution.kind === 'timeout') {
        socket.end('HTTP/1.1 504 Gateway Timeout\r\n\r\n')
        return
      }
      const target = resolution.target
      if (socket.destroyed) {
        return
      }

      const handle = deps.activity.open(target.resourceId)
      let released = false
      const release = (): void => {
        if (released) return
        released = true
        deps.activity.close(handle)
      }

      const upstream = net.connect(target.port, target.host)

      upstream.on('connect', () => {
        const lines = [`${req.method ?? 'GET'} ${req.url ?? '/'} HTTP/${req.httpVersion}`]
        for (const [name, value] of Object.entries(req.headers)) {
          if (value === undefined) continue
          for (const single of Array.isArray(value) ? value : [value]) {
            lines.push(`${name}: ${single}`)
          }
        }
        upstream.write(`${lines.join('\r\n')}\r\n\r\n`)
        if (head.length > 0) {
          upstream.write(head)
        }
        socket.pipe(upstream)
        upstream.pipe(socket)
      })

      // A held-open WebSocket is continuous use, so the handle lives as long
      // as the socket pair does. Released on whichever side closes first.
      const teardown = (): void => {
        release()
        if (!upstream.destroyed) upstream.destroy()
        if (!socket.destroyed) socket.destroy()
      }
      upstream.on('error', teardown)
      upstream.on('close', teardown)
      socket.on('error', teardown)
      socket.on('close', teardown)
    })()
  }

  return { handleRequest, handleUpgrade }
}

export interface HttpRouterHandle {
  port: number
  close(): Promise<void>
}

// Binds the router to a real port. Loopback by default and in production:
// Caddy is the only thing that should ever reach this listener, and Caddy
// runs on the same box. Publishing it on every interface would let anyone
// who can route to the machine reach every app by sending a Host header,
// with TLS termination and any future access control skipped, which is the
// same class of mistake DEFAULT_PORT_BIND exists to prevent for Postgres.
export function startHttpRouter(
  deps: HttpProxyDeps,
  opts: { port: number; host?: string } & HttpRouterOptions
): Promise<HttpRouterHandle & { server: Server }> {
  const router = createHttpRouter(deps, opts)
  const server = createServer(router.handleRequest)
  server.on('upgrade', router.handleUpgrade)

  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(opts.port, opts.host ?? '127.0.0.1', () => {
      server.removeListener('error', reject)
      const address = server.address()
      const port = typeof address === 'object' && address !== null ? address.port : opts.port
      resolve({
        port,
        server,
        close(): Promise<void> {
          return new Promise((resolveClose) => {
            // closeAllConnections, not a bare close: close() waits on every
            // keep-alive socket it has accepted, and a browser holding one
            // open would make daemon shutdown hang indefinitely. The same
            // hazard the Postgres proxy's own startup deadline addresses.
            server.closeAllConnections?.()
            server.close(() => resolveClose())
          })
        },
      })
    })
  })
}

export type { ConnectionHandle }
