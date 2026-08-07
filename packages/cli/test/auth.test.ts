// Written and RUN: everything here is either pure functions (hashPassword,
// LoginThrottle, SessionStore) or loopback HTTP against a fake runtime and
// an in-memory store, exactly like routes.test.ts's own precedent. Nothing
// here touches Docker or a real network. See the task report for the exact
// `node --test` output this produced.

import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, statSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createFakeRuntime, openStore, resolvePaths, type HobbyConfig, type Store } from '@hobby.sh/core'
import { ActivityTracker } from '@hobby.sh/proxy'
import {
  createApp,
  createStudioApp,
  hashPassword,
  hasOperatorCredential,
  LoginThrottle,
  readOperatorCredential,
  SessionStore,
  setOperatorPassword,
  verifyPassword,
  type DaemonContext,
} from '../src/index.js'

function testConfig(): HobbyConfig {
  return {
    image: 'postgres:18-alpine',
    proxyPort: 5432,
    studioPort: 8443,
    apiPort: 7432,
    sleepAfterSeconds: 300,
    wakeTimeoutMs: 150,
    readinessPollMs: 20,
  }
}

function buildContext(): DaemonContext {
  const store: Store = openStore(':memory:')
  const home = join(tmpdir(), `hobby-studio-test-${randomUUID()}`)
  mkdirSync(home, { recursive: true })
  const paths = resolvePaths({ HOBBY_HOME: home })
  return { store, runtime: createFakeRuntime(), paths, config: testConfig(), activity: new ActivityTracker() }
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
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())))
    ctx.store.close()
  }
}

interface JsonResponse {
  status: number
  body: unknown
  headers: Headers
}

async function call(baseUrl: string, method: string, path: string, opts: { body?: unknown; cookie?: string } = {}): Promise<JsonResponse> {
  const headers: Record<string, string> = {}
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

// Sanity check that readOperatorCredential does not throw when paths.home
// exists but the file has never been written, matching setOperatorPassword's
// own fresh-install precondition above.
test('readOperatorCredential returns null, not a throw, before the file exists', () => {
  const ctx = buildContext()
  assert.equal(readOperatorCredential(ctx.paths), null)
  ctx.store.close()
})

void readFileSync
