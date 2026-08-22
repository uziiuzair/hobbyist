// Written and RUN: everything here is either pure functions (hashPassword,
// LoginThrottle, SessionStore) or loopback HTTP against a fake runtime and
// an in-memory store, exactly like routes.test.ts's own precedent. Nothing
// here touches Docker or a real network. See the task report for the exact
// `node --test` output this produced.

import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, statSync } from 'node:fs'
import { createServer, request as httpRequest } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createFakeRuntime, openStore, resolvePaths, type HobbyConfig, type Store } from '@hobby.sh/core'
import { ActivityTracker } from '@hobby.sh/proxy'
import { createDefaultKindRegistry } from '../src/daemon/context.js'
import {
  createApp,
  createStudioApp,
  hashPassword,
  hasOperatorCredential,
  LoginThrottle,
  readOperatorCredential,
  SessionStore,
  setOperatorPassword,
  throttleKey,
  verifyPassword,
  type DaemonContext,
} from '../src/index.js'

function testConfig(): HobbyConfig {
  return {
    image: 'postgres:18-alpine',
    proxyPort: 5432,
    studioPort: 8443,
    apiPort: 7432,
    httpPort: 7433,
    domain: 'localhost',
    sleepAfterSeconds: 300,
    wakeTimeoutMs: 150,
    readinessPollMs: 20,
    queuePort: 0,
    caddyEnabled: false,
    caddyAdminPort: 2019,
    caddyStudioHost: null,
  }
}

function buildContext(): DaemonContext {
  const store: Store = openStore(':memory:')
  const home = join(tmpdir(), `hobby-studio-test-${randomUUID()}`)
  mkdirSync(home, { recursive: true })
  const paths = resolvePaths({ HOBBY_HOME: home })
  return { store, runtime: createFakeRuntime(), paths, config: testConfig(), activity: new ActivityTracker(), kinds: createDefaultKindRegistry() }
}

// --- hashPassword / verifyPassword -----------------------------------------

test('verifyPassword succeeds for the right password and fails for the wrong one', async () => {
  const hash = await hashPassword('correct horse battery staple')
  assert.equal(await verifyPassword('correct horse battery staple', hash), true)
  assert.equal(await verifyPassword('wrong password', hash), false)
})

test('hashPassword produces an argon2id hash', async () => {
  const hash = await hashPassword('correct horse battery staple')
  assert.match(hash, /^\$argon2id\$/)
})

test('setOperatorPassword writes an owner-only-readable credential file that readOperatorCredential can read back', async () => {
  const ctx = buildContext()
  assert.equal(hasOperatorCredential(ctx.paths), false)
  assert.equal(readOperatorCredential(ctx.paths), null)

  await setOperatorPassword(ctx.paths, 'correct horse battery staple')

  assert.equal(hasOperatorCredential(ctx.paths), true)
  const stored = readOperatorCredential(ctx.paths)
  assert.ok(stored !== null)
  assert.equal(await verifyPassword('correct horse battery staple', stored as string), true)

  const path = join(ctx.paths.home, 'studio-credential')
  const mode = statSync(path).mode & 0o777
  assert.equal(mode, 0o600)
  ctx.store.close()
})

// --- LoginThrottle -----------------------------------------------------

test('LoginThrottle allows the first attempt and backs off exponentially after repeated failures', () => {
  const throttle = new LoginThrottle()
  const key = '203.0.113.5'
  let now = 0

  // No prior failures: check() must not throw.
  throttle.check(key, now)

  throttle.fail(key, now) // failures=1, blocked until now+1000
  assert.throws(() => throttle.check(key, now), /unauthorized|too many attempts/)
  // Still blocked just before the window elapses.
  throttle.check.bind(throttle)
  assert.throws(() => throttle.check(key, now + 999))
  // Window elapsed: allowed again.
  throttle.check(key, now + 1000)

  now += 1000
  throttle.fail(key, now) // failures=2, blocked until now+2000
  assert.throws(() => throttle.check(key, now + 1999))
  throttle.check(key, now + 2000)

  now += 2000
  throttle.fail(key, now) // failures=3, blocked until now+4000
  assert.throws(() => throttle.check(key, now + 3999))
  throttle.check(key, now + 4000)
})

test('LoginThrottle resets a key on success, and a fresh key is never affected by another key\'s failures', () => {
  const throttle = new LoginThrottle()
  const attacker = '203.0.113.5'
  const legitimate = '198.51.100.9'
  const now = 0

  throttle.fail(attacker, now)
  throttle.fail(attacker, now)
  throttle.fail(attacker, now)
  assert.throws(() => throttle.check(attacker, now))

  // A different source address was never touched by the attacker's
  // failures: it must still be allowed immediately.
  throttle.check(legitimate, now)

  // Succeeding on the legitimate key must not clear the attacker's own
  // backoff: an attacker cannot use a second, clean address to reset the
  // first one's throttle state.
  throttle.succeed(legitimate)
  assert.throws(() => throttle.check(attacker, now))

  // Only succeeding on the attacker's own key clears it.
  throttle.succeed(attacker)
  throttle.check(attacker, now)
})

// --- SessionStore --------------------------------------------------------

test('SessionStore expires a session that has gone idle', () => {
  let now = 1_000_000
  const sessions = new SessionStore(() => now)
  const token = sessions.issue()

  now += 11 * 60 * 60 * 1000
  assert.equal(sessions.verify(token), true, 'still inside the idle window')

  // Verifying above slid the idle clock, so another 11 hours is still fine.
  now += 11 * 60 * 60 * 1000
  assert.equal(sessions.verify(token), true, 'idle clock slides on use')

  now += 13 * 60 * 60 * 1000
  assert.equal(sessions.verify(token), false, 'idle for longer than the window')
})

test('SessionStore expires a session on the absolute clock even when used constantly', () => {
  let now = 1_000_000
  const sessions = new SessionStore(() => now)
  const token = sessions.issue()

  // Use it every hour for 30 days. The idle clock never trips, which is the
  // point: without an absolute clock a stolen token would live forever.
  for (let hour = 0; hour < 30 * 24; hour += 1) {
    now += 60 * 60 * 1000
    assert.equal(sessions.verify(token), true, `still live at hour ${hour}`)
  }

  now += 60 * 60 * 1000
  assert.equal(sessions.verify(token), false, 'past the absolute lifetime')
})

test('SessionStore forgets expired sessions rather than growing forever', () => {
  let now = 1_000_000
  const sessions = new SessionStore(() => now)
  for (let i = 0; i < 50; i += 1) {
    sessions.issue()
  }
  now += 13 * 60 * 60 * 1000
  const survivor = sessions.issue()

  // Verifying sweeps, so the 50 dead entries go and only the survivor remains.
  assert.equal(sessions.verify(survivor), true)
  assert.equal(sessions.size, 1, 'expired sessions are dropped on verify')
})

test('SessionStore issues a token that verifies, and stops verifying once revoked', () => {
  const sessions = new SessionStore()
  const token = sessions.issue()
  assert.equal(sessions.verify(token), true)

  sessions.revoke(token)
  assert.equal(sessions.verify(token), false)
})

test('SessionStore rejects tokens it never issued, including garbage and empty input', () => {
  const sessions = new SessionStore()
  sessions.issue()
  assert.equal(sessions.verify('not-a-real-token'), false)
  assert.equal(sessions.verify(''), false)
})

// --- HTTP: login / session / logout, and the gate on other routes --------

async function withStudioServer(ctx: DaemonContext, fn: (baseUrl: string) => Promise<void>): Promise<void> {
  const app = createStudioApp(ctx, createApp(ctx))
  const server = createServer(app)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const address = server.address() as AddressInfo
  try {
    await fn(`http://127.0.0.1:${address.port}`)
  } finally {
    // closeAllConnections() forces any lingering keep-alive socket shut
    // immediately, rather than waiting on it: server.close()'s own callback
    // does not fire until every connection has ended on its own, and a
    // client that already got its response but never explicitly closed its
    // socket (the default node:http client behavior this suite's rawCall
    // helpers rely on) can otherwise leave that wait pending indefinitely,
    // which hangs this file's own process well after every test has already
    // reported a result (reproduced directly against this exact test file:
    // node --test finishes printing every test's outcome and then never
    // exits, with `process._getActiveHandles()` showing exactly this kind
    // of leftover Server/Socket pair).
    const closed = new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())))
    server.closeAllConnections()
    await closed
    ctx.store.close()
  }
}

interface JsonResponse {
  status: number
  body: unknown
  headers: Headers
}

async function call(
  baseUrl: string,
  method: string,
  path: string,
  opts: { body?: unknown; cookie?: string; headers?: Record<string, string> } = {}
): Promise<JsonResponse> {
  const headers: Record<string, string> = { ...opts.headers }
  if (opts.body !== undefined) headers['content-type'] = 'application/json'
  if (opts.cookie !== undefined) headers['cookie'] = opts.cookie
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  })
  const text = await res.text()
  return { status: res.status, body: text.length > 0 ? JSON.parse(text) : undefined, headers: res.headers }
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

// fetch() runs its argument through the WHATWG URL parser, which normalizes
// the path before a byte reaches the wire: `/.//v1/projects` would leave as
// `//v1/projects` and `/v1/../v1/projects` as `/v1/projects`. That is
// exactly the normalization these tests must NOT rely on, because a real
// attacker writes the request line by hand and Caddy may or may not clean it
// up first. node:http's `path` option is passed through verbatim, so this
// helper is the only way to prove the gate is correct on its own.
//
// body parses as JSON only when it looks like JSON, never unconditionally: a
// path outside /v1/ and /studio/ is Studio's static bundle now (see
// static.ts and studio-static.test.ts), which answers with HTML, not the
// control plane's JSON error envelope. An unconditional JSON.parse used to
// be safe here because every path this helper was ever pointed at answered
// in JSON; it throws for an HTML body, and it throws inside the 'end'
// listener, outside this function's own Promise executor, so neither
// resolve nor reject is ever called and the specific caller awaiting that
// call hangs forever. Confirmed directly: this exact throw, on this exact
// body, is what left rawCall's request socket and its server in
// process._getActiveHandles() long after node:test had already reported the
// test done, which is what kept this file's own process alive well past
// every test finishing.
async function rawCall(
  baseUrl: string,
  method: string,
  path: string,
  opts: { cookie?: string; headers?: Record<string, string> } = {}
): Promise<{ status: number; body: unknown; text: string }> {
  const url = new URL(baseUrl)
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { ...opts.headers }
    if (opts.cookie !== undefined) headers['cookie'] = opts.cookie
    const req = httpRequest(
      { hostname: url.hostname, port: url.port, method, path, headers },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => chunks.push(chunk))
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          resolve({ status: res.statusCode ?? 0, body: text.length > 0 ? safeJsonParse(text) : undefined, text })
        })
        res.on('error', reject)
      }
    )
    req.on('error', reject)
    req.end()
  })
}

function cookieFrom(res: JsonResponse): string {
  const setCookie = res.headers.get('set-cookie')
  assert.ok(setCookie !== null, 'expected a Set-Cookie header')
  return (setCookie as string).split(';')[0] as string
}

test('POST /studio/login with the wrong password fails with a generic message', async () => {
  const ctx = buildContext()
  await setOperatorPassword(ctx.paths, 'correct horse battery staple')

  await withStudioServer(ctx, async (baseUrl) => {
    const res = await call(baseUrl, 'POST', '/studio/login', { body: { password: 'wrong' } })
    assert.equal(res.status, 401)
    const body = res.body as { error: { code: string; message: string } }
    assert.equal(body.error.code, 'unauthorized')
    assert.equal(body.error.message, 'invalid credentials')
  })
})

test('POST /studio/login with the right password succeeds and sets a session cookie', async () => {
  const ctx = buildContext()
  await setOperatorPassword(ctx.paths, 'correct horse battery staple')

  await withStudioServer(ctx, async (baseUrl) => {
    const res = await call(baseUrl, 'POST', '/studio/login', {
      body: { password: 'correct horse battery staple' },
    })
    assert.equal(res.status, 200)
    const setCookie = res.headers.get('set-cookie') as string
    assert.match(setCookie, /^hobby_studio_session=/)
    assert.match(setCookie, /HttpOnly/)
    assert.match(setCookie, /Secure/)
    assert.match(setCookie, /SameSite=Strict/)
  })
})

test('a fresh install with no credential yet fails login with the exact same message as a wrong password', async () => {
  const ctx = buildContext()
  // setOperatorPassword deliberately never called: this is what a box looks
  // like before `hobby studio passwd` has ever run.

  await withStudioServer(ctx, async (baseUrl) => {
    const res = await call(baseUrl, 'POST', '/studio/login', { body: { password: 'anything' } })
    assert.equal(res.status, 401)
    const body = res.body as { error: { code: string; message: string } }
    assert.equal(body.error.code, 'unauthorized')
    assert.equal(body.error.message, 'invalid credentials')
  })
})

test('GET /v1/projects on the studio-fronted listener requires a session, and the login cookie satisfies it', async () => {
  const ctx = buildContext()
  await setOperatorPassword(ctx.paths, 'correct horse battery staple')

  await withStudioServer(ctx, async (baseUrl) => {
    const unauthed = await call(baseUrl, 'GET', '/v1/projects')
    assert.equal(unauthed.status, 401)

    const login = await call(baseUrl, 'POST', '/studio/login', {
      body: { password: 'correct horse battery staple' },
    })
    const cookie = cookieFrom(login)

    const authed = await call(baseUrl, 'GET', '/v1/projects', { cookie })
    assert.equal(authed.status, 200)
    assert.deepEqual(authed.body, { projects: [] })
  })
})

test('POST /studio/logout revokes the session, and the same cookie no longer authenticates', async () => {
  const ctx = buildContext()
  await setOperatorPassword(ctx.paths, 'correct horse battery staple')

  await withStudioServer(ctx, async (baseUrl) => {
    const login = await call(baseUrl, 'POST', '/studio/login', {
      body: { password: 'correct horse battery staple' },
    })
    const cookie = cookieFrom(login)

    const before = await call(baseUrl, 'GET', '/v1/projects', { cookie })
    assert.equal(before.status, 200)

    await call(baseUrl, 'POST', '/studio/logout', { cookie })

    const after = await call(baseUrl, 'GET', '/v1/projects', { cookie })
    assert.equal(after.status, 401)
  })
})

test('GET /studio/session reports authenticated: false with no cookie and true with a valid one', async () => {
  const ctx = buildContext()
  await setOperatorPassword(ctx.paths, 'correct horse battery staple')

  await withStudioServer(ctx, async (baseUrl) => {
    const before = await call(baseUrl, 'GET', '/studio/session')
    assert.deepEqual(before.body, { authenticated: false })

    const login = await call(baseUrl, 'POST', '/studio/login', {
      body: { password: 'correct horse battery staple' },
    })
    const cookie = cookieFrom(login)

    const after = await call(baseUrl, 'GET', '/studio/session', { cookie })
    assert.deepEqual(after.body, { authenticated: true })
  })
})

test('GET /v1/health stays reachable on the studio-fronted listener without a session', async () => {
  const ctx = buildContext()
  await withStudioServer(ctx, async (baseUrl) => {
    const res = await call(baseUrl, 'GET', '/v1/health')
    assert.equal(res.status, 200)
    assert.deepEqual(res.body, { status: 'ok' })
  })
})

// --- the gate itself: path normalization ---------------------------------
//
// The bypass these cover, demonstrated against running code before the fix:
// the gate asked `url.pathname.startsWith('/v1/')` while the control plane's
// own dispatch (packages/cli/src/daemon/routes.ts) routes on
// `pathname.split('/').filter(s => s.length > 0)`. `GET /.//v1/projects` has
// a pathname of `//v1/projects`, which fails the prefix test and was waved
// through, and then dispatch dropped the empty segment and served
// /v1/projects anyway. GET /v1/projects returned 401 while
// GET /.//v1/projects returned 200, and POST /.//v1/projects created a
// project. The same door reached project deletion, arbitrary SQL as
// superuser (POST /v1/resources/:id/query) and the routes that return the
// cleartext superuser password.

const BYPASS_PATHS: Array<[string, string]> = [
  ['/.//v1/projects', 'a single-dot segment, the exact shape that was proven exploitable'],
  ['/v1/../v1/projects', 'a dot-dot segment that resolves back to the same route'],
  ['/v1/projects/', 'a trailing slash, which is the same route to dispatch'],
  ['/%2e//v1/projects', 'a percent-encoded dot, decoded by the URL parser before the gate ever sees it'],
  ['/v1//projects', 'a doubled interior slash'],
]

test('every path variant that dispatch still routes to /v1/projects requires a session', async () => {
  const ctx = buildContext()
  await setOperatorPassword(ctx.paths, 'correct horse battery staple')

  await withStudioServer(ctx, async (baseUrl) => {
    for (const [path, why] of BYPASS_PATHS) {
      const res = await rawCall(baseUrl, 'GET', path)
      assert.equal(res.status, 401, `GET ${path} (${why}) must be rejected, got ${res.status}`)
      const body = res.body as { error: { code: string } }
      assert.equal(body.error.code, 'unauthorized')
    }
  })
})

// '//v1/projects' (a doubled LEADING slash, as opposed to '/v1//projects'
// above, a doubled INTERIOR one) used to live in BYPASS_PATHS asserting 401,
// on the same "dispatch still routes this to /v1/projects" premise as every
// other entry there. That premise is false for this one specific shape, and
// static serving is what surfaced it: `new URL('//v1/projects',
// 'http://localhost')` does not produce pathname '//v1/projects' the way a
// single or doubled interior slash does. A path that starts with exactly
// "//" is a network-path reference (WHATWG URL Standard, the same rule
// behind protocol-relative URLs like "//example.com/x" in an href): the URL
// parser reads "v1" as a new HOST, not a path segment, leaving pathname
// "/projects" and host "v1". Confirmed directly against a real node:http
// server, not just the URL parser in isolation: req.url is the literal
// string "//v1/projects", and dispatch (packages/cli/src/daemon/routes.ts)
// parses it the exact same way this gate does, so it was already throwing
// "unknown route: GET /projects" for this shape before this task, session or
// no session; the old gate's 401 for it was a coincidence of denying
// everything by default, not evidence dispatch ever served /v1/projects
// from it. What actually matters, and what this asserts, is that the gate's
// classification still agrees with dispatch's own routing for this shape:
// neither one ever treats it as /v1/projects, so serving it as Studio's
// static bundle (a harmless, unauthenticated HTML shell) hands out nothing
// dispatch itself would not have refused anyway.
test('a doubled leading slash is a network-path reference, not /v1/projects, in the gate and in dispatch alike', async () => {
  const ctx = buildContext()
  await setOperatorPassword(ctx.paths, 'correct horse battery staple')

  await withStudioServer(ctx, async (baseUrl) => {
    const res = await rawCall(baseUrl, 'GET', '//v1/projects')
    // Never the control plane's project list, authenticated or not: this
    // never was /v1/projects to either the gate or dispatch.
    assert.doesNotMatch(res.text, /"projects":/)
    assert.notEqual(res.status, 401, 'this path is not gated, because it is not /v1/... to dispatch either')
  })
})

test('POST /.//v1/projects without a session neither succeeds nor creates a project', async () => {
  const ctx = buildContext()
  await setOperatorPassword(ctx.paths, 'correct horse battery staple')

  await withStudioServer(ctx, async (baseUrl) => {
    const res = await rawCall(baseUrl, 'POST', '/.//v1/projects', {
      headers: { 'content-type': 'application/json' },
    })
    assert.equal(res.status, 401)
    // The status alone would not prove the write never happened, so assert
    // the store directly: this is the difference between a rejected request
    // and a rejected request that still had a side effect.
    assert.deepEqual(ctx.store.listProjects(), [])
  })
})

test('the same normalized path IS served, with a session, so the gate matches what dispatch routes', async () => {
  const ctx = buildContext()
  await setOperatorPassword(ctx.paths, 'correct horse battery staple')

  await withStudioServer(ctx, async (baseUrl) => {
    const login = await call(baseUrl, 'POST', '/studio/login', {
      body: { password: 'correct horse battery staple' },
    })
    const cookie = cookieFrom(login)

    // Proves the gate is not merely blanket-denying odd-looking paths: it
    // resolves them to the same route dispatch does, and then applies the
    // session check to that. A gate that got this wrong in the other
    // direction (denying a path the router serves) would be a bug too.
    const res = await rawCall(baseUrl, 'GET', '/.//v1/projects', { cookie })
    assert.equal(res.status, 200)
    assert.deepEqual(res.body, { projects: [] })
  })
})

// This test's own premise changed with static serving (see static.ts and
// studio-static.test.ts, which owns the full assertions on what gets served
// and with what content). '/v2/projects', '/' and '/anything' are, by
// design, none of them /v1/... or /studio/... any more, so none of them are
// gated: they are all Studio's own built bundle now, unauthenticated on
// purpose, because that bundle is what has to load before a session can ever
// exist. What must still hold, and what this asserts, is the boundary
// itself: /v1/ and /studio/ paths that do not match a real route stay
// default-denied, exactly as before, static serving or not.
test('an unmapped path outside /v1/ and /studio/ is Studio\'s static bundle, not the control plane, and is never gated', async () => {
  const ctx = buildContext()
  await setOperatorPassword(ctx.paths, 'correct horse battery staple')

  await withStudioServer(ctx, async (baseUrl) => {
    for (const path of ['/v2/projects', '/', '/anything']) {
      const res = await rawCall(baseUrl, 'GET', path)
      assert.notEqual(res.status, 401, `GET ${path} must not be gated: it is not /v1/ or /studio/`)
    }
  })
})

test('an unmapped /v1/ or /studio/ path stays gated by default, even with static serving wired in', async () => {
  const ctx = buildContext()
  await setOperatorPassword(ctx.paths, 'correct horse battery staple')

  await withStudioServer(ctx, async (baseUrl) => {
    for (const path of ['/v1/not-a-real-route', '/studio/not-a-real-route']) {
      const res = await rawCall(baseUrl, 'GET', path)
      assert.equal(res.status, 401, `GET ${path} must still require a session`)
    }
  })
})

test('repeated failed logins from the same source eventually get throttled', async () => {
  const ctx = buildContext()
  await setOperatorPassword(ctx.paths, 'correct horse battery staple')

  await withStudioServer(ctx, async (baseUrl) => {
    let lastStatus = 0
    for (let i = 0; i < 6; i += 1) {
      const res = await call(baseUrl, 'POST', '/studio/login', { body: { password: 'wrong' } })
      lastStatus = res.status
      if (res.status === 401) {
        const body = res.body as { error: { hint?: string } }
        if (body.error.hint !== undefined && /retry in/.test(body.error.hint)) {
          // Throttled: reached the point exponential backoff kicks in.
          break
        }
      }
    }
    assert.equal(lastStatus, 401)
  })
})

// --- the login throttle's key --------------------------------------------

test('throttleKey takes the last X-Forwarded-For hop, the one the trusted proxy wrote', () => {
  // Caddy appends the address of the peer it received the request from, so
  // a client that sends `X-Forwarded-For: 10.0.0.1` has its own real
  // address appended after it. Reading the first element read a value the
  // remote client chose, which let an attacker pick a fresh throttle key
  // on every request so the backoff never engaged at all.
  assert.equal(throttleKey('10.0.0.1, 203.0.113.9', '127.0.0.1'), '203.0.113.9')
  assert.equal(throttleKey('10.0.0.1,10.0.0.2, 203.0.113.9', '127.0.0.1'), '203.0.113.9')
  // Repeated headers, which node may surface as an array.
  assert.equal(throttleKey(['10.0.0.1', '203.0.113.9'], '127.0.0.1'), '203.0.113.9')
  // No proxy in front: the socket's own remote address is the only honest
  // answer.
  assert.equal(throttleKey(undefined, '198.51.100.4'), '198.51.100.4')
  assert.equal(throttleKey('', '198.51.100.4'), '198.51.100.4')
  assert.equal(throttleKey('   ', '198.51.100.4'), '198.51.100.4')
  assert.equal(throttleKey(undefined, undefined), 'unknown')
})

test('a client rotating its own X-Forwarded-For value still gets throttled', async () => {
  const ctx = buildContext()
  await setOperatorPassword(ctx.paths, 'correct horse battery staple')

  await withStudioServer(ctx, async (baseUrl) => {
    let throttled = false
    for (let i = 0; i < 8; i += 1) {
      // Exactly what Caddy forwards when a remote attacker sets the header
      // themselves and rotates it every request: their forged value first,
      // their real address appended last.
      const res = await call(baseUrl, 'POST', '/studio/login', {
        body: { password: 'wrong' },
        headers: { 'x-forwarded-for': `10.0.0.${i}, 203.0.113.9` },
      })
      assert.equal(res.status, 401)
      const body = res.body as { error: { hint?: string } }
      if (body.error.hint !== undefined && /retry in/.test(body.error.hint)) {
        throttled = true
        break
      }
    }
    assert.equal(throttled, true, 'rotating the client-supplied hop must not reset the backoff')
  })
})

// Sanity check that readOperatorCredential does not throw when paths.home
// exists but the file has never been written, matching setOperatorPassword's
// own fresh-install precondition above.
test('readOperatorCredential returns null, not a throw, before the file exists', () => {
  const ctx = buildContext()
  assert.equal(readOperatorCredential(ctx.paths), null)
  ctx.store.close()
})

void readFileSync
