// Studio's own HTTP surface: login, logout, and a session check, plus the
// gate that gives those meaning. This deliberately does NOT re-implement or
// wrap the control-plane routes from ../routes.ts (projects, resources,
// eject and so on): those already exist, are already fully tested, and
// stay exactly as Task 4 built them. What this file adds is a second,
// narrower request handler, createStudioApp, meant to sit in front of that
// existing app on the loopback TCP listener only (the one Caddy is the sole
// caller of, see ADR 0008): it always allows login and health, and requires
// a valid session cookie for everything else before ever calling through.
// The unix socket listener (CLI and MCP) is untouched: filesystem
// permissions are its authentication, and it never sees this file at all.
// See the task report for exactly how server.ts wires this in and why the
// wiring lives in server.ts's startDaemon rather than in createApp itself
// (createApp's existing tests assert its handler has no auth gate at all,
// which must stay true for the unix socket).
//
// Router below is deliberately not a pattern-matching framework, matching
// ../routes.ts's own stated philosophy ("a manual match is more legible
// here than a regex router would be"): Studio's route set is three fixed,
// enumerable paths, so a Map keyed on "METHOD path" is the whole
// implementation.

import { HobbyError } from '@hobby.sh/core'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { DaemonContext } from '../context.js'
import { DUMMY_CREDENTIAL_HASH, LoginThrottle, readOperatorCredential, verifyPassword } from './auth.js'
import { readSessionCookie, serializeClearCookie, serializeSessionCookie, SessionStore } from './session.js'

interface RouteResult {
  status: number
  body: unknown
}

export type StudioRouteHandler = (
  ctx: DaemonContext,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL
) => Promise<RouteResult>

export interface Router {
  add(method: string, path: string, handler: StudioRouteHandler): void
}

interface DispatchableRouter extends Router {
  // Returns true if the request matched a registered studio route and a
  // response was already sent; false means "not one of mine," so the
  // caller (createStudioApp below) can fall through to the daemon's own
  // control-plane app.
  dispatch(ctx: DaemonContext, req: IncomingMessage, res: ServerResponse): Promise<boolean>
}

const MAX_LOGIN_BODY_BYTES = 8 * 1024

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    let settled = false

    const fail = (err: Error): void => {
      if (settled) return
      settled = true
      reject(err)
    }

    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_LOGIN_BODY_BYTES) {
        fail(new HobbyError('usage', 'request body too large', `limit is ${MAX_LOGIN_BODY_BYTES} bytes`))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })

    req.on('end', () => {
      if (settled) return
      if (chunks.length === 0) {
        settled = true
        resolve({})
        return
      }
      try {
        const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        settled = true
        resolve(parsed)
      } catch {
        fail(new HobbyError('usage', 'invalid JSON body', 'the request body must be valid JSON'))
      }
    })

    req.on('error', fail)
  })
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(payload)
}

function toHobbyError(err: unknown): HobbyError {
  if (err instanceof HobbyError) {
    return err
  }
  const detail = err instanceof Error ? (err.stack ?? err.message) : String(err)
  console.error(`studio: unexpected error: ${detail}`)
  return new HobbyError('internal', 'internal error')
}

export function createRouter(): DispatchableRouter {
  const handlers = new Map<string, StudioRouteHandler>()

  return {
    add(method, path, handler) {
      handlers.set(`${method} ${path}`, handler)
    },

    async dispatch(ctx, req, res): Promise<boolean> {
      const method = req.method ?? 'GET'
      const url = new URL(req.url ?? '/', 'http://localhost')
      const handler = handlers.get(`${method} ${url.pathname}`)
      if (handler === undefined) {
        return false
      }

      try {
        const result = await handler(ctx, req, res, url)
        sendJson(res, result.status, result.body)
      } catch (err) {
        const hobbyErr = toHobbyError(err)
        sendJson(res, hobbyErr.httpStatus, hobbyErr.toWire())
      }
      return true
    },
  }
}

// Per-DaemonContext session store and login throttle, created lazily on
// first use by whichever of mountStudioRoutes or isAuthenticated runs
// first, and shared by both from then on. A WeakMap keyed on the
// DaemonContext object itself, rather than module-level singletons, is what
// keeps every test's own freshly-built DaemonContext isolated from every
// other test's, the same way each test already gets its own fresh
// in-memory Store.
interface StudioState {
  sessions: SessionStore
  throttle: LoginThrottle
}

const registry = new WeakMap<DaemonContext, StudioState>()

function stateFor(ctx: DaemonContext): StudioState {
  let state = registry.get(ctx)
  if (state === undefined) {
    state = { sessions: new SessionStore(), throttle: new LoginThrottle() }
    registry.set(ctx, state)
  }
  return state
}

// Behind Caddy (the only intended caller of the loopback TCP listener, see
// ADR 0008), req.socket.remoteAddress is always Caddy's own loopback
// connection, which would collapse every real client into one throttle key.
// Caddy's reverse_proxy sets X-Forwarded-For by default, so that header is
// preferred when present. This trusts a client-controlled header, which is
// only sound because the listener is loopback-only and Caddy is assumed to
// be the sole caller; a local process on the same box could still forge it
// and blur throttle keys together. That is a real, accepted limitation of
// this exact trust model, not an oversight, flagged again in the task
// report as a review item for anyone exposing this to a real network.
function remoteKey(req: IncomingMessage): string {
  const forwarded = req.headers['x-forwarded-for']
  if (typeof forwarded === 'string' && forwarded.length > 0) {
    return (forwarded.split(',')[0] ?? '').trim() || 'unknown'
  }
  return req.socket.remoteAddress ?? 'unknown'
}

async function loginHandler(ctx: DaemonContext, req: IncomingMessage, res: ServerResponse): Promise<RouteResult> {
  const state = stateFor(ctx)
  const key = remoteKey(req)
  state.throttle.check(key)

  const body = await readJsonBody(req)
  const password = isRecord(body) ? body['password'] : undefined
  if (typeof password !== 'string' || password.length === 0) {
    throw new HobbyError('usage', 'password is required', 'POST /studio/login expects { "password": string }')
  }

  const stored = readOperatorCredential(ctx.paths)
  // Always run a real argon2 comparison, against the real stored hash if one
  // exists or against a fixed dummy hash if it does not, and always return
  // the exact same error, message and status either way. ADR 0008 requires
  // that a login failure never reveal whether a credential has been set at
  // all: a distinct "no credential configured, run hobby studio passwd"
  // message would do exactly that, to anyone who can reach this route,
  // which on a network-exposed box is anyone on the internet.
  const ok = await verifyPassword(password, stored ?? DUMMY_CREDENTIAL_HASH)

  if (!ok || stored === null) {
    state.throttle.fail(key)
    throw new HobbyError('unauthorized', 'invalid credentials')
  }

  state.throttle.succeed(key)
  const token = state.sessions.issue()
  res.setHeader('set-cookie', serializeSessionCookie(token))
  return { status: 200, body: { ok: true } }
}

function logoutHandler(ctx: DaemonContext, req: IncomingMessage, res: ServerResponse): RouteResult {
  const state = stateFor(ctx)
  const token = readSessionCookie(req)
  if (token !== null) {
    state.sessions.revoke(token)
  }
  res.setHeader('set-cookie', serializeClearCookie())
  return { status: 200, body: { ok: true } }
}

function sessionHandler(ctx: DaemonContext, req: IncomingMessage): RouteResult {
  const state = stateFor(ctx)
  const token = readSessionCookie(req)
  const authenticated = token !== null && state.sessions.verify(token)
  return { status: 200, body: { authenticated } }
}

// Registers Studio's three routes on `app`. Session cookies are set by
// writing res.setHeader directly, outside the RouteResult shape dispatch()
// renders (which only ever carries status and body): login and logout are
// the two handlers that need to attach a Set-Cookie header alongside a JSON
// body, so each sets it on `res` itself before returning.
export function mountStudioRoutes(app: Router, ctx: DaemonContext): void {
  // Ensures state exists for this ctx immediately, so the very first
  // request (whichever route it hits first) is never the thing that lazily
  // constructs the session store.
  stateFor(ctx)

  app.add('POST', '/studio/login', (routeCtx, req, res) => loginHandler(routeCtx, req, res))

  app.add('POST', '/studio/logout', (routeCtx, req, res) => Promise.resolve(logoutHandler(routeCtx, req, res)))

  app.add('GET', '/studio/session', (routeCtx, req) => Promise.resolve(sessionHandler(routeCtx, req)))
}

// Every path an unauthenticated request may reach on the studio-fronted TCP
// listener. Login must be reachable to log in at all. Health is harmless to
// leave open (Caddy or an operator polling liveness) and reveals nothing.
// Session is deliberately open too: it is how the client finds out whether
// it is currently authenticated, and if calling it required already being
// authenticated it could never usefully answer "no."
const UNAUTHENTICATED_PATHS = new Set(['/studio/login', '/studio/logout', '/studio/session', '/v1/health'])

export function isAuthenticated(ctx: DaemonContext, req: IncomingMessage): boolean {
  const token = readSessionCookie(req)
  if (token === null) {
    return false
  }
  return stateFor(ctx).sessions.verify(token)
}

function requiresAuth(pathname: string): boolean {
  return pathname.startsWith('/v1/') && !UNAUTHENTICATED_PATHS.has(pathname)
}

// The handler actually bound to the loopback TCP listener (see server.ts):
// tries Studio's own three routes first, then, for anything else under
// /v1/, requires a valid session before ever calling `next` (the daemon's
// existing control-plane app, unmodified). The unix socket listener keeps
// using `next` directly and never sees this wrapper at all, per this file's
// header comment.
export function createStudioApp(
  ctx: DaemonContext,
  next: (req: IncomingMessage, res: ServerResponse) => void
): (req: IncomingMessage, res: ServerResponse) => void {
  const router = createRouter()
  mountStudioRoutes(router, ctx)

  return (req, res) => {
    handle(ctx, router, req, res, next).catch((err: unknown) => {
      console.error(`studio: request handling failed outside the normal error path: ${errorMessage(err)}`)
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
      }
      if (!res.writableEnded) {
        res.end(JSON.stringify({ error: { code: 'internal', message: 'internal error' } }))
      }
    })
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

async function handle(
  ctx: DaemonContext,
  router: DispatchableRouter,
  req: IncomingMessage,
  res: ServerResponse,
  next: (req: IncomingMessage, res: ServerResponse) => void
): Promise<void> {
  const handled = await router.dispatch(ctx, req, res)
  if (handled) {
    return
  }

  const url = new URL(req.url ?? '/', 'http://localhost')
  if (!requiresAuth(url.pathname)) {
    next(req, res)
    return
  }

  if (!isAuthenticated(ctx, req)) {
    sendJson(res, 401, { error: { code: 'unauthorized', message: 'authentication required' } })
    return
  }

  next(req, res)
}
