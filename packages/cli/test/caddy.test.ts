// Written and RUN: createCaddyManager never shells out to Docker itself (it
// only calls the injected ComputeRuntime, here createFakeRuntime) and never
// makes a real network call (fetchFn is injected and records what it was
// asked to send). See the task report for the exact `node --test` output.

import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createFakeRuntime, openStore, resolvePaths, type ComputeRuntime, type HobbyConfig, type Store } from '@hobby.sh/core'
import { ActivityTracker } from '@hobby.sh/proxy'
import {
  createCaddyManager,
  createDefaultKindRegistry,
  startDaemon,
  type CaddyFallback,
  type CaddyManager,
  type CaddyRoute,
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
    queuePort: 0,
    caddyEnabled: false,
    caddyAdminPort: 2019,
    caddyStudioHost: null,
    ...overrides,
  }
}

function buildContext(
  runtime: ComputeRuntime = createFakeRuntime(),
  configOverrides: Partial<HobbyConfig> = {}
): DaemonContext {
  const store: Store = openStore(':memory:')
  const paths = resolvePaths({ HOBBY_HOME: join(tmpdir(), `hobby-cli-test-${randomUUID()}`) })
  return {
    store,
    runtime,
    paths,
    config: testConfig(configOverrides),
    activity: new ActivityTracker(),
    kinds: createDefaultKindRegistry(),
  }
}

// A CaddyManager double that records every call made on it, in order, plus
// the arguments addRoute and setFallback were given. The order/absence tests
// only need `calls`; the content tests below also need `fallbacks`/`routes`.
// One double, reused everywhere in this file, rather than a second harness
// per assertion shape. `failing` names the methods that should reject
// instead of succeeding, for the two tests below that need a CaddyManager
// which behaves normally except for one call throwing.
type CaddyMethodName = 'ensureRunning' | 'addRoute' | 'removeRoute' | 'setFallback' | 'stop'

function recordingCaddyManager(failing: ReadonlySet<CaddyMethodName> = new Set()): {
  manager: CaddyManager
  calls: string[]
  fallbacks: CaddyFallback[]
  routes: CaddyRoute[]
} {
  const calls: string[] = []
  const fallbacks: CaddyFallback[] = []
  const routes: CaddyRoute[] = []
  const manager: CaddyManager = {
    async ensureRunning() {
      calls.push('ensureRunning')
      if (failing.has('ensureRunning')) {
        throw new Error('caddy container refused to start')
      }
    },
    async addRoute(route) {
      calls.push('addRoute')
      if (failing.has('addRoute')) {
        throw new Error('caddy admin API rejected the route')
      }
      routes.push(route)
    },
    async removeRoute() {
      calls.push('removeRoute')
    },
    async setFallback(fallback) {
      calls.push('setFallback')
      if (failing.has('setFallback')) {
        throw new Error('caddy admin API rejected the fallback config')
      }
      if (fallback !== null) {
        fallbacks.push(fallback)
      }
    },
    async stop() {
      calls.push('stop')
    },
  }
  return { manager, calls, fallbacks, routes }
}

// The strongest "the daemon is still functional" check this harness can make
// cheaply: an actual HTTP request over the actual unix socket the daemon is
// actually listening on, hitting the one route (`/v1/health`) that needs no
// auth and touches no resource. Chosen over merely asserting that close()
// resolves without throwing, because a socket that answers is proof the
// control plane a CLI or MCP client would use is alive, not just that
// teardown happens to be well-behaved.
function getOverSocket(socketPath: string, path: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ socketPath, path, method: 'GET' }, (res) => {
      res.resume()
      res.on('end', () => resolve(res.statusCode ?? 0))
    })
    req.on('error', reject)
    req.end()
  })
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

test('ensureRunning polls the admin API and does not resolve until it answers', async () => {
  // start() resolving is not Caddy answering: the container was asked to
  // run, not yet bound to :2019. Fails the first two admin-API calls with
  // ECONNREFUSED, the exact error push() would turn into a swallowed
  // HobbyError if ensureRunning fired setFallback's request right away,
  // then succeeds on the third. ensureRunning resolving at all here proves
  // it polled through the failures instead of propagating the first one.
  const runtime = createFakeRuntime()
  let calls = 0
  const fetchFn = (async () => {
    calls += 1
    if (calls <= 2) {
      throw new Error('ECONNREFUSED')
    }
    return new Response('{}', { status: 200 })
  }) as typeof fetch
  const manager = createCaddyManager(runtime, { adminPort: 2019, fetchFn })

  await manager.ensureRunning()

  assert.ok(calls >= 3, `expected at least 3 admin-API attempts, saw ${calls}`)
})

test('ensureRunning throws a HobbyError if the admin API never becomes reachable', async () => {
  const runtime = createFakeRuntime()
  const fetchFn = (async () => {
    throw new Error('ECONNREFUSED')
  }) as typeof fetch
  const manager = createCaddyManager(runtime, { adminPort: 2019, fetchFn })

  await assert.rejects(
    manager.ensureRunning(),
    (err: unknown) => err instanceof Error && err.name === 'HobbyError'
  )
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

test('with caddy enabled, ensureRunning happens before setFallback', async () => {
  // Caddy has to actually be running before its admin API can accept the
  // fallback config; the reverse order would push a config nothing is
  // listening for yet. Asserted on recorded call order, not just that both
  // eventually happened.
  const ctx = buildContext(createFakeRuntime(), { caddyEnabled: true })
  const { manager, calls } = recordingCaddyManager()
  const home = mkdtempSync(join(tmpdir(), 'hobby-caddy-'))
  const socketPath = join(home, 'd.sock')

  const daemon = await startDaemon(ctx, { socketPath, apiPort: null, caddy: manager })
  try {
    assert.deepEqual(calls, ['ensureRunning', 'setFallback'])
  } finally {
    await daemon.close()
    ctx.store.close()
  }
})

test('the fallback pushed to caddy points at the http wake router and carries the tls ask path', async () => {
  // httpPort left at testConfig's default (0, an OS-assigned ephemeral
  // port), not a fixed literal: this is the one test in the file that
  // actually needs startHttpRouter to bind for real, and a fixed port would
  // be free to collide with anything else on the box doing the same. The
  // assertion below reads back the config value the code was given, not the
  // real bound port, so 0 exercises exactly the same code path a real
  // config value would.
  const ctx = buildContext(createFakeRuntime(), { caddyEnabled: true })
  const { manager, fallbacks } = recordingCaddyManager()
  const home = mkdtempSync(join(tmpdir(), 'hobby-caddy-'))
  const socketPath = join(home, 'd.sock')

  const daemon = await startDaemon(ctx, { socketPath, apiPort: null, caddy: manager })
  try {
    assert.equal(fallbacks.length, 1)
    const fallback = fallbacks[0]
    assert.ok(fallback !== undefined)
    assert.equal(fallback.upstream, '127.0.0.1:0')
    assert.match(fallback.askUrl ?? '', /\/\.hobby\/tls-ask/)
  } finally {
    await daemon.close()
    ctx.store.close()
  }
})

test('a studio route is published when caddyStudioHost is set and apiPort is a number', async () => {
  // apiPort: 0 for the same reason httpPort is left at its default above: a
  // real bind, on whatever the OS hands out, rather than a fixed literal
  // that could collide with another process on the box. The route's
  // upstream is still asserted against the exact value startDaemon was
  // given.
  const ctx = buildContext(createFakeRuntime(), {
    caddyEnabled: true,
    caddyStudioHost: 'studio.example.com',
  })
  const { manager, routes } = recordingCaddyManager()
  const home = mkdtempSync(join(tmpdir(), 'hobby-caddy-'))
  const socketPath = join(home, 'd.sock')

  const daemon = await startDaemon(ctx, { socketPath, apiPort: 0, caddy: manager })
  try {
    assert.equal(routes.length, 1)
    const route = routes[0]
    assert.ok(route !== undefined)
    assert.equal(route.host, 'studio.example.com')
    assert.equal(route.upstream, '127.0.0.1:0')
  } finally {
    await daemon.close()
    ctx.store.close()
  }
})

test('no studio route when caddyStudioHost is set but apiPort is null, and the skip is logged', async () => {
  // The whole point of logging here rather than silently skipping: an
  // operator who configured a studio host expects a route, and with no
  // studio listener started there is nothing to reach on the other end.
  const ctx = buildContext(createFakeRuntime(), {
    caddyEnabled: true,
    caddyStudioHost: 'studio.example.com',
  })
  const { manager, routes } = recordingCaddyManager()
  const home = mkdtempSync(join(tmpdir(), 'hobby-caddy-'))
  const socketPath = join(home, 'd.sock')

  const original = console.error
  const messages: string[] = []
  console.error = (...args: unknown[]) => {
    messages.push(args.map(String).join(' '))
  }
  const daemon = await startDaemon(ctx, { socketPath, apiPort: null, caddy: manager }).finally(() => {
    console.error = original
  })
  try {
    assert.deepEqual(routes, [])
    assert.ok(messages.some((m) => m.includes('no studio route published') && m.includes('studio listener is not started')))
  } finally {
    await daemon.close()
    ctx.store.close()
  }
})

test('no studio route when caddyStudioHost is null', async () => {
  const ctx = buildContext(createFakeRuntime(), { caddyEnabled: true })
  const { manager, routes } = recordingCaddyManager()
  const home = mkdtempSync(join(tmpdir(), 'hobby-caddy-'))
  const socketPath = join(home, 'd.sock')

  const daemon = await startDaemon(ctx, { socketPath, apiPort: 0, caddy: manager })
  try {
    assert.deepEqual(routes, [])
  } finally {
    await daemon.close()
    ctx.store.close()
  }
})

test('an unrecognized HOBBY_CADDY_ENABLED warns, naming the value seen and the accepted spellings', async () => {
  // resolveConfig (packages/core) fails closed and silently on a typo like
  // "yes": core has no logger. This is the one place that silence gets a
  // voice, so the check reads process.env directly here rather than through
  // ctx.config (which by now already lost the original string).
  const ctx = buildContext()
  const home = mkdtempSync(join(tmpdir(), 'hobby-caddy-'))
  const socketPath = join(home, 'd.sock')

  const originalEnv = process.env.HOBBY_CADDY_ENABLED
  process.env.HOBBY_CADDY_ENABLED = 'yes'
  const original = console.error
  const messages: string[] = []
  console.error = (...args: unknown[]) => {
    messages.push(args.map(String).join(' '))
  }

  const daemon = await startDaemon(ctx, { socketPath, apiPort: null }).finally(() => {
    console.error = original
    if (originalEnv === undefined) {
      delete process.env.HOBBY_CADDY_ENABLED
    } else {
      process.env.HOBBY_CADDY_ENABLED = originalEnv
    }
  })
  try {
    assert.ok(
      messages.some(
        (m) => m.includes('HOBBY_CADDY_ENABLED is set to "yes"') && m.includes('1 or true') && m.includes('0 or false')
      )
    )
  } finally {
    await daemon.close()
    ctx.store.close()
  }
})

// These two are the load-bearing tests of this whole sub-project: they
// encode the difference between "the web front door is down" and "the
// databases are down". A CaddyManager call that rejects must not propagate
// out of startDaemon and take the rest of the daemon down with it.

test('a caddy that will not start leaves the daemon running and its control socket answering', async () => {
  const ctx = buildContext(createFakeRuntime(), { caddyEnabled: true })
  const { manager } = recordingCaddyManager(new Set(['ensureRunning']))
  const home = mkdtempSync(join(tmpdir(), 'hobby-caddy-'))
  const socketPath = join(home, 'd.sock')

  const original = console.error
  const messages: string[] = []
  console.error = (...args: unknown[]) => {
    messages.push(args.map(String).join(' '))
  }

  const daemon = await startDaemon(ctx, { socketPath, apiPort: null, caddy: manager }).finally(() => {
    console.error = original
  })
  try {
    assert.ok(daemon !== null)
    assert.ok(messages.some((m) => /caddy/i.test(m)))
    // The wedge: a box whose Caddy will not start still has databases that
    // must wake on connection, which has nothing to do with HTTP. Proven
    // here by hitting the daemon's own control socket, the same surface the
    // CLI and MCP use, rather than only asserting close() behaves.
    const status = await getOverSocket(socketPath, '/v1/health')
    assert.equal(status, 200)
  } finally {
    await daemon.close()
    ctx.store.close()
  }
})

test('a failing route push leaves the daemon running and its control socket answering', async () => {
  const ctx = buildContext(createFakeRuntime(), { caddyEnabled: true })
  const { manager } = recordingCaddyManager(new Set(['setFallback']))
  const home = mkdtempSync(join(tmpdir(), 'hobby-caddy-'))
  const socketPath = join(home, 'd.sock')

  const original = console.error
  const messages: string[] = []
  console.error = (...args: unknown[]) => {
    messages.push(args.map(String).join(' '))
  }

  const daemon = await startDaemon(ctx, { socketPath, apiPort: null, caddy: manager }).finally(() => {
    console.error = original
  })
  try {
    assert.ok(daemon !== null)
    assert.ok(messages.some((m) => /caddy/i.test(m)))
    const status = await getOverSocket(socketPath, '/v1/health')
    assert.equal(status, 200)
  } finally {
    await daemon.close()
    ctx.store.close()
  }
})
