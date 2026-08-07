// Written and RUN: createCaddyManager never shells out to Docker itself (it
// only calls the injected ComputeRuntime, here createFakeRuntime) and never
// makes a real network call (fetchFn is injected and records what it was
// asked to send). See the task report for the exact `node --test` output.

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createFakeRuntime } from '@hobby.sh/core'
import { createCaddyManager } from '../src/index.js'

interface RecordedCall {
  url: string
  init: RequestInit
}

function fakeFetch(): { fetchFn: typeof fetch; calls: RecordedCall[] } {
  const calls: RecordedCall[] = []
  const fetchFn = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} })
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
  return { fetchFn, calls }
}

test('ensureRunning creates and starts the caddy container with host networking, via the injected runtime', async () => {
  const runtime = createFakeRuntime()
  const { fetchFn } = fakeFetch()
  const manager = createCaddyManager(runtime, { adminPort: 2019, fetchFn })

  await manager.ensureRunning()

  const status = await runtime.inspect('hobby-caddy')
  assert.equal(status.exists, true)
  assert.equal(status.running, true)
  const spec = runtime._specs.get('hobby-caddy')
  assert.ok(spec !== undefined)
  assert.equal(spec?.network, 'host')
  assert.equal(spec?.image, 'caddy:2-alpine')
})

test('addRoute posts the expected admin API payload for a new route', async () => {
  const runtime = createFakeRuntime()
  const { fetchFn, calls } = fakeFetch()
  const manager = createCaddyManager(runtime, { adminPort: 2019, fetchFn })

  await manager.addRoute({ id: 'studio', host: 'studio.local', upstream: '127.0.0.1:7432' })

  assert.equal(calls.length, 1)
  const call = calls[0]
  assert.ok(call !== undefined)
  assert.equal(call.url, 'http://127.0.0.1:2019/load')
  assert.equal(call.init.method, 'POST')
  assert.equal((call.init.headers as Record<string, string>)['content-type'], 'application/json')

  const body = JSON.parse(call.init.body as string) as {
    apps: { http: { servers: { hobby: { listen: string[]; routes: unknown[] } } } }
  }
  assert.deepEqual(body.apps.http.servers.hobby.listen, [':80', ':443'])
  assert.deepEqual(body.apps.http.servers.hobby.routes, [
    {
      '@id': 'studio',
      match: [{ host: ['studio.local'] }],
      handle: [
        {
          handler: 'reverse_proxy',
          upstreams: [{ dial: '127.0.0.1:7432' }],
        },
      ],
    },
  ])
})

test('addRoute is idempotent by id: adding the same id twice replaces, not duplicates', async () => {
  const runtime = createFakeRuntime()
  const { fetchFn, calls } = fakeFetch()
  const manager = createCaddyManager(runtime, { adminPort: 2019, fetchFn })

  await manager.addRoute({ id: 'studio', host: 'studio.local', upstream: '127.0.0.1:7432' })
  await manager.addRoute({ id: 'studio', host: 'studio.example.com', upstream: '127.0.0.1:7432' })

  const last = calls[calls.length - 1]
  assert.ok(last !== undefined)
  const body = JSON.parse(last.init.body as string) as {
    apps: { http: { servers: { hobby: { routes: Array<{ match: Array<{ host: string[] }> }> } } } }
  }
  assert.equal(body.apps.http.servers.hobby.routes.length, 1)
  assert.deepEqual(body.apps.http.servers.hobby.routes[0]?.match, [{ host: ['studio.example.com'] }])
})

test('removeRoute drops the route from the next pushed config', async () => {
  const runtime = createFakeRuntime()
  const { fetchFn, calls } = fakeFetch()
  const manager = createCaddyManager(runtime, { adminPort: 2019, fetchFn })

  await manager.addRoute({ id: 'studio', host: 'studio.local', upstream: '127.0.0.1:7432' })
  await manager.removeRoute('studio')

  const last = calls[calls.length - 1]
  assert.ok(last !== undefined)
  const body = JSON.parse(last.init.body as string) as {
    apps: { http: { servers: { hobby: { routes: unknown[] } } } }
  }
  assert.deepEqual(body.apps.http.servers.hobby.routes, [])
})

test('addRoute prints the first-exposure warning exactly once, not on every call', async () => {
  const runtime = createFakeRuntime()
  const { fetchFn } = fakeFetch()
  const manager = createCaddyManager(runtime, { adminPort: 2019, fetchFn })

  const original = console.error
  const messages: string[] = []
  console.error = (...args: unknown[]) => {
    messages.push(args.map(String).join(' '))
  }
  try {
    await manager.addRoute({ id: 'a', host: 'a.local', upstream: '127.0.0.1:1' })
    await manager.addRoute({ id: 'b', host: 'b.local', upstream: '127.0.0.1:2' })
  } finally {
    console.error = original
  }

  const warnings = messages.filter((m) => m.includes('exposes the daemon to the network'))
  assert.equal(warnings.length, 1)
})

test('a failed admin API response surfaces as a HobbyError instead of throwing an unrelated error', async () => {
  const runtime = createFakeRuntime()
  const fetchFn = (async () => new Response('bad config', { status: 400 })) as typeof fetch
  const manager = createCaddyManager(runtime, { adminPort: 2019, fetchFn })

  await assert.rejects(
    manager.addRoute({ id: 'studio', host: 'studio.local', upstream: '127.0.0.1:7432' }),
    (err: unknown) => err instanceof Error && err.name === 'HobbyError'
  )
})
