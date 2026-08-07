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

test('login posts to /studio/login with the password body', async () => {
  const calls = installFakeFetch(() => jsonResponse(200, {}))
  await api.login('hunter2')
  assert.equal(calls.length, 1)
  assert.equal(calls[0]?.url, '/studio/login')
  assert.equal(calls[0]?.method, 'POST')
  assert.deepEqual(calls[0]?.body, { password: 'hunter2' })
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
