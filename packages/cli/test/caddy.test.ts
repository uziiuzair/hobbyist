// Written and RUN: createCaddyManager never shells out to Docker itself (it
// only calls the injected ComputeRuntime, here createFakeRuntime) and never
// makes a real network call (fetchFn is injected and records what it was
// asked to send). See the task report for the exact `node --test` output.

import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createFakeRuntime, openStore, resolvePaths, type ComputeRuntime, type HobbyConfig, type Store } from '@hobby.sh/core'
import { ActivityTracker } from '@hobby.sh/proxy'
import {
  createCaddyManager,
  createDefaultKindRegistry,
  startDaemon,
  type CaddyManager,
  type DaemonContext,
} from '../src/index.js'

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

// Mirrors routes.test.ts's testConfig/buildContext exactly, since that is
// this repo's one established way to build a DaemonContext for a daemon-
// level test. caddyEnabled defaults false here (the one config value this
// test file cares about); every field below still has to be present since
// HobbyConfig has no optional fields of its own.
function testConfig(overrides: Partial<HobbyConfig> = {}): HobbyConfig {
  return {
    image: 'postgres:18-alpine',
    proxyPort: 0,
    studioPort: 8443,
    apiPort: 0,
    httpPort: 0,
    domain: 'localhost',
    sleepAfterSeconds: 300,
    wakeTimeoutMs: 150,
    readinessPollMs: 20,
    caddyEnabled: false,
    caddyAdminPort: 2019,
    caddyStudioHost: null,
    ...overrides,
  }
}

function buildContext(runtime: ComputeRuntime = createFakeRuntime()): DaemonContext {
  const store: Store = openStore(':memory:')
  const paths = resolvePaths({ HOBBY_HOME: join(tmpdir(), `hobby-cli-test-${randomUUID()}`) })
  return { store, runtime, paths, config: testConfig(), activity: new ActivityTracker(), kinds: createDefaultKindRegistry() }
}

// A CaddyManager double that records every call made on it, so the test
// below can assert on absence: with caddyEnabled false, nothing here should
// ever be touched, exactly as production's own `opts.caddy ?? ...` gate in
// server.ts's startDaemon never even evaluates when ctx.config.caddyEnabled
// is false.
function recordingCaddyManager(): { manager: CaddyManager; calls: string[] } {
  const calls: string[] = []
  const manager: CaddyManager = {
    async ensureRunning() {
      calls.push('ensureRunning')
    },
    async addRoute() {
      calls.push('addRoute')
    },
    async removeRoute() {
      calls.push('removeRoute')
    },
    async setFallback() {
      calls.push('setFallback')
    },
    async stop() {
      calls.push('stop')
    },
  }
  return { manager, calls }
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

test('with caddy disabled, the daemon touches neither the runtime nor the admin API', async () => {
  // The regression nobody running without Caddy would ever notice. A daemon
  // that quietly starts a container or pushes a config on every boot, for a
  // feature the operator did not turn on, is a surprising side effect of an
  // upgrade.
  const ctx = buildContext()
  const { manager, calls } = recordingCaddyManager()
  // Kept short on purpose: a unix socket path is capped well under 104 bytes
  // on macOS, and tmpdir() itself already eats a large share of that budget.
  const home = mkdtempSync(join(tmpdir(), 'hobby-caddy-'))
  const socketPath = join(home, 'd.sock')

  const daemon = await startDaemon(ctx, { socketPath, apiPort: null, caddy: manager })
  try {
    assert.deepEqual(calls, [])
  } finally {
    await daemon.close()
    ctx.store.close()
  }

  assert.deepEqual(calls, [])
})
