// Pure, no network: every call below is asserted against a fake global
// fetch, verifying api.ts sends the exact method and path the daemon
// documents (packages/cli/src/daemon/routes.ts) and that a non-ok response
// in the documented { error: { code, message, hint } } envelope surfaces
// as an ApiError with that code, message and hint intact.

import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as api from '../src/api.js'

interface RecordedCall {
  url: string
  method: string
  body: unknown
}

function installFakeFetch(handler: (call: RecordedCall) => Response): RecordedCall[] {
  const calls: RecordedCall[] = []
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString()
    const method = init?.method ?? 'GET'
    const body = init?.body !== undefined ? JSON.parse(String(init.body)) : undefined
    const call = { url, method, body }
    calls.push(call)
    return handler(call)
  }) as typeof fetch
  return calls
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

test('login posts to /studio/login with the password alone', async () => {
  const calls = installFakeFetch(() => jsonResponse(200, {}))
  await api.login('correct horse battery staple')
  assert.equal(calls.length, 1)
  assert.equal(calls[0]?.url, '/studio/login')
  assert.equal(calls[0]?.method, 'POST')
  // Password only (issue #123): the daemon's login handler
  // (packages/cli/src/daemon/studio/routes.ts, loginHandler) reads `password`
  // and nothing else, because Studio has one operator credential and no
  // user table. A username used to travel here and was never read.
  assert.deepEqual(calls[0]?.body, { password: 'correct horse battery staple' })
})

// Issue #124: a 401 from an authenticated route reaches the registered
// handler so the auth provider can return to the login page. The login route
// is excluded, because a wrong password is a 401 that belongs to the form.
test('a 401 on an authenticated route calls the onUnauthorized handler, and the login route does not', async () => {
  installFakeFetch(() =>
    jsonResponse(401, { error: { code: 'unauthorized', message: 'authentication required' } }),
  )
  let fired = 0
  const off = api.onUnauthorized(() => {
    fired += 1
  })
  try {
    await assert.rejects(() => api.listProjects(), (err: unknown) => err instanceof api.ApiError && err.code === 'unauthorized')
    assert.equal(fired, 1)

    await assert.rejects(() => api.login('wrong password here'), (err: unknown) => err instanceof api.ApiError && err.status === 401)
    assert.equal(fired, 1, 'a failed login is not a lost session')
  } finally {
    off()
  }

  // Unsubscribed: a later 401 is the caller's own error again.
  await assert.rejects(() => api.listProjects())
  assert.equal(fired, 1)
})

test('a non-401 failure never calls the onUnauthorized handler', async () => {
  installFakeFetch(() => jsonResponse(400, { error: { code: 'usage', message: 'bad', hint: 'SQLSTATE 42601' } }))
  let fired = 0
  const off = api.onUnauthorized(() => {
    fired += 1
  })
  try {
    await assert.rejects(() => api.runQuery('res-1', 'selec 1'), (err: unknown) => err instanceof api.ApiError && err.hint === 'SQLSTATE 42601')
  } finally {
    off()
  }
  assert.equal(fired, 0)
})

test('logout posts to /studio/logout', async () => {
  const calls = installFakeFetch(() => jsonResponse(200, {}))
  await api.logout()
  assert.equal(calls[0]?.url, '/studio/logout')
  assert.equal(calls[0]?.method, 'POST')
})

test('session gets /studio/session and returns the authenticated flag', async () => {
  installFakeFetch(() => jsonResponse(200, { authenticated: true }))
  const result = await api.session()
  assert.equal(result.authenticated, true)
})

test('listProjects gets /v1/projects', async () => {
  const calls = installFakeFetch(() => jsonResponse(200, { projects: [] }))
  await api.listProjects()
  assert.equal(calls[0]?.url, '/v1/projects')
  assert.equal(calls[0]?.method, 'GET')
})

test('createProject posts to /v1/projects with the name', async () => {
  const calls = installFakeFetch(() => jsonResponse(201, { project: { id: '1', name: 'blog' } }))
  await api.createProject('blog')
  assert.equal(calls[0]?.url, '/v1/projects')
  assert.equal(calls[0]?.method, 'POST')
  assert.deepEqual(calls[0]?.body, { name: 'blog' })
})

test('getProject gets /v1/projects/:name, encoded', async () => {
  const calls = installFakeFetch(() => jsonResponse(200, { project: {}, resources: [] }))
  await api.getProject('my project')
  assert.equal(calls[0]?.url, '/v1/projects/my%20project')
})

test('deleteProject deletes /v1/projects/:name, with ?force=true when asked', async () => {
  const calls = installFakeFetch(() => jsonResponse(200, { deleted: true }))
  await api.deleteProject('blog', { force: true })
  assert.equal(calls[0]?.url, '/v1/projects/blog?force=true')
  assert.equal(calls[0]?.method, 'DELETE')
})

test('createResource posts kind postgres to /v1/projects/:name/resources', async () => {
  const calls = installFakeFetch(() => jsonResponse(201, { resource: {} }))
  await api.createResource('blog', 'primary')
  assert.equal(calls[0]?.url, '/v1/projects/blog/resources')
  assert.deepEqual(calls[0]?.body, { kind: 'postgres', name: 'primary' })
})

test('wakeResource posts to /v1/resources/:id/start', async () => {
  const calls = installFakeFetch(() => jsonResponse(200, { resource: {} }))
  await api.wakeResource('res-1')
  assert.equal(calls[0]?.url, '/v1/resources/res-1/start')
  assert.equal(calls[0]?.method, 'POST')
})

test('sleepResource posts to /v1/resources/:id/stop', async () => {
  const calls = installFakeFetch(() => jsonResponse(200, { resource: {} }))
  await api.sleepResource('res-1')
  assert.equal(calls[0]?.url, '/v1/resources/res-1/stop')
  assert.equal(calls[0]?.method, 'POST')
})

test('connectionString gets /v1/resources/:id/connection', async () => {
  const calls = installFakeFetch(() => jsonResponse(200, { connectionString: 'postgres://...' }))
  await api.connectionString('res-1')
  assert.equal(calls[0]?.url, '/v1/resources/res-1/connection')
})

test('logs gets /v1/resources/:id/logs with the tail param', async () => {
  const calls = installFakeFetch(() => jsonResponse(200, { logs: '' }))
  await api.logs('res-1', 50)
  assert.equal(calls[0]?.url, '/v1/resources/res-1/logs?tail=50')
})

test('runQuery posts sql and params to /v1/resources/:id/query', async () => {
  const calls = installFakeFetch(() => jsonResponse(200, { columns: [], rows: [], rowCount: 0, command: 'SELECT' }))
  await api.runQuery('res-1', 'select 1', [1, 2])
  assert.equal(calls[0]?.url, '/v1/resources/res-1/query')
  assert.equal(calls[0]?.method, 'POST')
  assert.deepEqual(calls[0]?.body, { sql: 'select 1', params: [1, 2] })
})

test('a non-ok response in the documented envelope surfaces as an ApiError with code, message and hint', async () => {
  installFakeFetch(() =>
    jsonResponse(404, { error: { code: 'resource_not_found', message: 'no resource with id x', hint: 'check the id' } })
  )
  await assert.rejects(
    () => api.getResource('x'),
    (err: unknown) => {
      assert.ok(err instanceof api.ApiError)
      assert.equal(err.code, 'resource_not_found')
      assert.equal(err.message, 'no resource with id x')
      assert.equal(err.hint, 'check the id')
      assert.equal(err.status, 404)
      return true
    }
  )
})

test('a non-ok response with no recognizable envelope becomes code unreachable', async () => {
  installFakeFetch(() => new Response('<html>bad gateway</html>', { status: 502 }))
  await assert.rejects(
    () => api.listProjects(),
    (err: unknown) => {
      assert.ok(err instanceof api.ApiError)
      assert.equal(err.code, 'unreachable')
      return true
    }
  )
})

test('a network failure (fetch throws) becomes code unreachable', async () => {
  globalThis.fetch = (async () => {
    throw new TypeError('failed to fetch')
  }) as typeof fetch
  await assert.rejects(
    () => api.listProjects(),
    (err: unknown) => {
      assert.ok(err instanceof api.ApiError)
      assert.equal(err.code, 'unreachable')
      return true
    }
  )
})
