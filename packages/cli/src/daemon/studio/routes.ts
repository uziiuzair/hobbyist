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
import { issueToken, readBearerToken, verifyToken } from './tokens.js'
import { DUMMY_CREDENTIAL_HASH, LoginThrottle, readOperatorCredential, verifyPassword } from './auth.js'
import { readSessionCookie, serializeClearCookie, serializeSessionCookie, SessionStore } from './session.js'
import { resolveStudioDistDir, serveStudioStatic } from './static.js'

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
// connection, which would collapse every real client into one throttle key
// and let any one attacker's failures lock the operator out. Caddy's
// reverse_proxy sets X-Forwarded-For, so that header is preferred when
// present, but it is read from the RIGHT, not the left.
//
// That detail is the whole fix, and the naive reading looks correct, so:
// X-Forwarded-For is a chain, and each proxy APPENDS the address of the
// peer it received the request from. A request arriving at Caddy with a
// client-supplied `X-Forwarded-For: 1.2.3.4` leaves Caddy as
// `1.2.3.4, <real client address>`. The first element is therefore a value
// the remote client chose; taking it (as this did) let an attacker pick a
// fresh throttle key on every single request, so the exponential backoff
// never engaged at all, remotely, for anyone. The last element is the one
// written by the hop we actually trust. With no header at all, nothing is
// in front of us and the socket's own remote address is the only honest
// answer.
export function throttleKey(forwardedFor: string | string[] | undefined, socketAddress: string | undefined): string {
  // node collapses repeated headers into one comma-joined string for most
  // headers, but the typings allow an array; joining first means one code
  // path handles both, and the last element is still the last hop.
  const chain = Array.isArray(forwardedFor) ? forwardedFor.join(',') : forwardedFor
  if (typeof chain === 'string' && chain.length > 0) {
    const hops = chain.split(',')
    const last = (hops[hops.length - 1] ?? '').trim()
    if (last.length > 0) {
      return last
    }
  }
  return socketAddress ?? 'unknown'
}

function remoteKey(req: IncomingMessage): string {
  return throttleKey(req.headers['x-forwarded-for'], req.socket.remoteAddress)
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
// POST /studio/token, the CLI's half of login (ADR 0018). Same password, same
// throttle, same deliberately indistinguishable failure as the browser login
// above: this route must not become an oracle for whether a credential exists
// just because it returns a different kind of success.
//
// Deliberately not reachable with a token. A token cannot mint another token,
// so a leaked one cannot be used to quietly issue a second credential that
// survives revoking the first.
async function tokenHandler(ctx: DaemonContext, req: IncomingMessage): Promise<RouteResult> {
  const state = stateFor(ctx)
  const key = remoteKey(req)
  state.throttle.check(key)

  const body = await readJsonBody(req)
  const password = isRecord(body) ? body['password'] : undefined
  const name = isRecord(body) ? body['name'] : undefined
  if (typeof password !== 'string' || password.length === 0) {
    throw new HobbyError('usage', 'password is required', 'POST /studio/token expects { "password": string, "name": string }')
  }
  if (typeof name !== 'string' || name.trim().length === 0) {
    throw new HobbyError('usage', 'name is required', 'a token is named so it can be revoked by name later')
  }

  const stored = readOperatorCredential(ctx.paths)
  const ok = await verifyPassword(password, stored ?? DUMMY_CREDENTIAL_HASH)
  if (!ok || stored === null) {
    state.throttle.fail(key)
    throw new HobbyError('unauthorized', 'invalid credentials')
  }
  state.throttle.succeed(key)

  const token = await issueToken(ctx.paths, name)
  // The only time the plaintext exists outside the caller's memory.
  return { status: 200, body: { token, name: name.trim() } }
}

export function mountStudioRoutes(app: Router, ctx: DaemonContext): void {
  // Ensures state exists for this ctx immediately, so the very first
  // request (whichever route it hits first) is never the thing that lazily
  // constructs the session store.
  stateFor(ctx)

  app.add('POST', '/studio/login', (routeCtx, req, res) => loginHandler(routeCtx, req, res))

  app.add('POST', '/studio/logout', (routeCtx, req, res) => Promise.resolve(logoutHandler(routeCtx, req, res)))

  app.add('GET', '/studio/session', (routeCtx, req) => Promise.resolve(sessionHandler(routeCtx, req)))

  app.add('POST', '/studio/token', (routeCtx, req) => tokenHandler(routeCtx, req))
}

// Every path an unauthenticated request may reach on the studio-fronted TCP
// listener, written as the normalized segments pathKey() below produces,
// never as a raw pathname string. Login must be reachable to log in at all.
// Health is harmless to leave open (Caddy or an operator polling liveness)
// and reveals nothing. Session is deliberately open too: it is how the
// client finds out whether it is currently authenticated, and if calling it
// required already being authenticated it could never usefully answer "no."
// Everything else, without exception, needs a session: this list is the
// entire exception surface, and the gate is default-deny around it.
const UNAUTHENTICATED_PATHS = new Set(['studio/login', 'studio/logout', 'studio/session', 'studio/token', 'v1/health'])

// One gate for two credentials (ADR 0018). A browser presents the session
// cookie; a CLI presents an API token as a bearer header. Both end here rather
// than each getting its own check, so there is a single place that can be
// wrong and a single place to read when asking what is protected.
//
// The cookie is tried first because it is the cheap, in-memory path: a token
// costs an argon2 verify per stored token, and a browser making many requests
// should not pay that on every one.
export async function isAuthenticated(ctx: DaemonContext, req: IncomingMessage): Promise<boolean> {
  const cookie = readSessionCookie(req)
  if (cookie !== null && stateFor(ctx).sessions.verify(cookie)) {
    return true
  }

  const bearer = readBearerToken(req.headers.authorization)
  if (bearer === null) {
    return false
  }
  return verifyToken(ctx.paths, bearer)
}

// Reduces a request to exactly the identity ../routes.ts's `dispatch` routes
// on: URL pathname, split on '/', empty segments dropped. Returns null only
// when req.url itself cannot be parsed at all, which every caller below
// treats as "cannot be classified as anything," the same default-deny
// outcome an unmapped path already gets.
//
// This is the fix for a real bypass, so it is worth stating precisely. The
// gate used to ask `url.pathname.startsWith('/v1/')`, while dispatch routes
// on `url.pathname.split('/').filter(s => s.length > 0)`. Those two
// disagree: `GET /.//v1/projects` has a pathname of `//v1/projects`, which
// fails startsWith and so was waved through unauthenticated, and then
// dispatch dropped the empty segment and served /v1/projects anyway. That
// reached project deletion, arbitrary SQL as superuser via
// POST /v1/resources/:id/query, and the routes that hand back cleartext
// superuser passwords. Any gate that parses a path differently from the
// thing that routes it is a bypass waiting to be found, so this parses it
// once, the same way, and decides from segments rather than from a prefix.
// static.ts's own path-traversal defense is handed these same segments for
// the same reason: one normalization, trusted by every consumer, rather
// than a second copy that could drift.
//
// Two properties this must keep: it must not depend on Caddy normalizing
// the path first (the daemon's TCP listener has to be correct on its own,
// and the unix socket has no Caddy in front of it at all), and it must be
// default-deny, so a path shape nobody anticipated needs a session rather
// than skipping the check.
function pathSegments(req: IncomingMessage): string[] | null {
  let pathname: string
  try {
    pathname = new URL(req.url ?? '/', 'http://localhost').pathname
  } catch {
    return null
  }
  return pathname.split('/').filter((segment) => segment.length > 0)
}

function pathKey(segments: string[] | null): string {
  return segments === null ? '' : segments.join('/')
}

function requiresAuth(key: string): boolean {
  return !UNAUTHENTICATED_PATHS.has(key)
}

export interface CreateStudioAppOptions {
  // Test seam, same shape and reasoning as DaemonContext.probeFactory
  // (packages/cli/src/daemon/context.ts): production never sets this and
  // gets the real sibling-package resolution (static.ts's
  // resolveStudioDistDir), tests point it at a small fixture directory
  // instead of requiring a real `npm run build -w @hobby.sh/studio` to have
  // run first.
  studioDistDir?: string
}

// The handler actually bound to the loopback TCP listener (see server.ts):
// tries Studio's own three routes first, then classifies everything else by
// its normalized segments (see pathSegments above). A /v1/... or /studio/...
// path requires a valid session before ever reaching `next` (the daemon's
// existing control-plane app, unmodified). Everything else is Studio's own
// built bundle (static.ts's serveStudioStatic), served with no session at
// all: see that file's header for why that is deliberate rather than a gap.
// The unix socket listener keeps using `next` directly and never sees this
// wrapper, or the static bundle, at all, per this file's header comment.
export function createStudioApp(
  ctx: DaemonContext,
  next: (req: IncomingMessage, res: ServerResponse) => void,
  opts: CreateStudioAppOptions = {}
): (req: IncomingMessage, res: ServerResponse) => void {
  const router = createRouter()
  mountStudioRoutes(router, ctx)
  const studioDistDir = opts.studioDistDir ?? resolveStudioDistDir()

  return (req, res) => {
    applySecurityHeaders(req, res)
    handle(ctx, router, req, res, next, studioDistDir).catch((err: unknown) => {
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

// Set on every response this listener produces, static bundle included, before
// any handler runs. There was previously no security header anywhere: a stored
// XSS anywhere in Studio's own bundle had nothing standing in its way, and
// nothing stopped another origin framing the page.
//
// The policy is tight because it can be. Studio is a self-contained bundle that
// loads no third-party script, talks only to its own origin, and embeds nothing:
// so script-src and connect-src are 'self' and there is no CDN to allow. The
// one concession is style-src 'unsafe-inline', because the bundler emits inline
// style attributes; script has no such exemption, which is the half that
// matters for XSS.
//
// frame-ancestors 'none' rather than X-Frame-Options: it is the modern
// equivalent, it is what CSP-aware browsers honour, and X-Frame-Options is sent
// alongside only for anything that does not read CSP yet.
const STUDIO_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "form-action 'self'",
  "base-uri 'none'",
  "object-src 'none'",
  "frame-ancestors 'none'",
].join('; ')

export function applySecurityHeaders(req: IncomingMessage, res: ServerResponse): void {
  res.setHeader('content-security-policy', STUDIO_CSP)
  res.setHeader('x-content-type-options', 'nosniff')
  res.setHeader('x-frame-options', 'DENY')
  res.setHeader('referrer-policy', 'no-referrer')
  // Nothing here needs a camera, a microphone or a location, and saying so
  // costs one header.
  res.setHeader('permissions-policy', 'camera=(), microphone=(), geolocation=(), interest-cohort=()')

  // HSTS only when the request actually arrived over TLS. Sending it on plain
  // http://127.0.0.1 would be at best ignored and at worst would pin loopback
  // to https for the whole browser profile, which breaks the default local
  // setup for a user who never asked for TLS.
  const proto = req.headers['x-forwarded-proto']
  const overTls = proto === 'https' || (Array.isArray(proto) && proto[0] === 'https')
  if (overTls) {
    res.setHeader('strict-transport-security', 'max-age=31536000; includeSubDomains')
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

// A path belongs to the control plane (and therefore needs the session gate
// below) only if its first normalized segment is exactly "v1" or "studio".
// Everything else, including the bare root and every path an unmapped route
// used to be default-denied on, is Studio's own static bundle now, per this
// file's header on why that is safe: the bundle carries no secret, and
// nothing this branch reaches ever touches ctx.store or ctx.runtime.
function isControlPlanePath(segments: string[] | null): boolean {
  if (segments === null || segments.length === 0) {
    return false
  }
  return segments[0] === 'v1' || segments[0] === 'studio'
}

async function handle(
  ctx: DaemonContext,
  router: DispatchableRouter,
  req: IncomingMessage,
  res: ServerResponse,
  next: (req: IncomingMessage, res: ServerResponse) => void,
  studioDistDir: string
): Promise<void> {
  const handled = await router.dispatch(ctx, req, res)
  if (handled) {
    return
  }

  const segments = pathSegments(req)

  if (!isControlPlanePath(segments)) {
    // segments is never null here (isControlPlanePath already returned
    // false for null), and static serving only understands GET; anything
    // else falls through exactly like an unmapped control-plane path always
    // has, gated and then 400'd by `next` as an unknown route.
    if (segments !== null && serveStudioStatic(req, res, segments, studioDistDir)) {
      return
    }
  }

  if (!requiresAuth(pathKey(segments))) {
    next(req, res)
    return
  }

  if (!(await isAuthenticated(ctx, req))) {
    sendJson(res, 401, { error: { code: 'unauthorized', message: 'authentication required' } })
    return
  }

  next(req, res)
}
