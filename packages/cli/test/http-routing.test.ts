// Where a hostname becomes a routing decision, on the daemon side of the
// HTTP wake router. parseAppHostname is pure string handling with no store
// and no clock, so it is tested directly; createHttpProxyDeps is tested
// against an in-memory store and a fake runtime.

import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { get as httpGet } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  createFakeRuntime,
  openStore,
  resolvePaths,
  type AppConfig,
  type HobbyConfig,
  type PostgresConfig,
  type Store,
} from '@hobby.sh/core'
import { ActivityTracker, startHttpRouter } from '@hobby.sh/proxy'
import { createCaddyManager } from '../src/index.js'
import {
  createDefaultKindRegistry,
  createHttpProxyDeps,
  parseAppHostname,
  type DaemonContext,
} from '../src/daemon/context.js'

function testConfig(overrides: Partial<HobbyConfig> = {}): HobbyConfig {
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
    caddyEnabled: false,
    caddyAdminPort: 2019,
    caddyStudioHost: null,
    ...overrides,
  }
}

function buildContext(config: HobbyConfig = testConfig()): DaemonContext {
  const store: Store = openStore(':memory:')
  const paths = resolvePaths({ HOBBY_HOME: join(tmpdir(), `hobby-http-test-${randomUUID()}`) })
  return {
    store,
    runtime: createFakeRuntime(),
    paths,
    config,
    activity: new ActivityTracker(),
    kinds: createDefaultKindRegistry(),
  }
}

function appConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    image: 'hobby/blog-web:1',
    containerName: `hobby-blog-web-${randomUUID()}`,
    hostPort: 15500,
    containerPort: 3000,
    hostname: 'web.blog.localhost',
    source: null,
    env: {},
    databaseResourceId: null,
    ...overrides,
  }
}

function postgresConfig(): PostgresConfig {
  return {
    image: 'postgres:18-alpine',
    containerName: `hobby-blog-primary-${randomUUID()}`,
    hostPort: 15432,
    dataDir: '/tmp/pgdata',
    superuser: 'postgres',
    password: 'a'.repeat(32),
    database: 'blog',
  }
}

test('parseAppHostname reads <resource>.<project>.<domain>', () => {
  assert.deepEqual(parseAppHostname('web.blog.localhost', 'localhost'), { project: 'blog', resource: 'web' })
  assert.deepEqual(parseAppHostname('api.shop.example.com', 'example.com'), { project: 'shop', resource: 'api' })
})

// The security-relevant case. Accepting extra labels would mean
// `evil.attacker.web.blog.localhost` routes to project `blog`, which lets one
// deployed app be reached under names that look like somebody else's
// subdomains, and lets a certificate be requested for them.
test('parseAppHostname requires exactly two labels ahead of the domain', () => {
  assert.equal(parseAppHostname('a.b.c.blog.localhost', 'localhost'), null)
  assert.equal(parseAppHostname('blog.localhost', 'localhost'), null)
  assert.equal(parseAppHostname('localhost', 'localhost'), null)
  assert.equal(parseAppHostname('web.blog.notlocalhost', 'localhost'), null)
  assert.equal(parseAppHostname('..localhost', 'localhost'), null)
})

// A domain that merely ends with the same characters must not match: without
// the leading dot, `evil-localhost` would parse against domain `localhost`.
test('parseAppHostname matches a label boundary, not a string suffix', () => {
  assert.equal(parseAppHostname('web.blogevil-localhost', 'localhost'), null)
  assert.deepEqual(parseAppHostname('WEB.BLOG.LOCALHOST', 'localhost'), { project: 'blog', resource: 'web' })
})

test('createHttpProxyDeps resolves an app to its loopback port and state', async () => {
  const ctx = buildContext()
  const project = ctx.store.createProject({ name: 'blog', sleepAfterSeconds: null })
  const resource = ctx.store.createResource({
    projectId: project.id,
    kind: 'app',
    name: 'web',
    config: appConfig({ hostPort: 15501 }),
  })
  // createResource writes 'creating'; a real handler moves it on. Set it
  // here so the assertion is about what resolve reports, not about what a
  // freshly inserted row happens to say.
  ctx.store.setResourceState(resource.id, 'sleeping')

  const deps = createHttpProxyDeps(ctx)
  const target = await deps.resolve('web.blog.localhost')

  assert.ok(target !== null)
  assert.equal(target.resourceId, resource.id)
  assert.equal(target.host, '127.0.0.1')
  assert.equal(target.port, 15501)
  assert.equal(target.state, 'sleeping')
})

// A database's hostname is shaped like an app's by accident of the naming
// scheme. Routing a browser to port 5432 would hand it a Postgres wire
// protocol error, which is a confusing way to say "this is not a website".
test('createHttpProxyDeps refuses to route HTTP at a postgres resource', async () => {
  const ctx = buildContext()
  const project = ctx.store.createProject({ name: 'blog', sleepAfterSeconds: null })
  ctx.store.createResource({ projectId: project.id, kind: 'postgres', name: 'primary', config: postgresConfig() })

  const deps = createHttpProxyDeps(ctx)
  assert.equal(await deps.resolve('primary.blog.localhost'), null)
})

test('createHttpProxyDeps refuses a released project with a reason, rather than a bare 404', async () => {
  const ctx = buildContext()
  const project = ctx.store.createProject({ name: 'blog', sleepAfterSeconds: null })
  ctx.store.createResource({ projectId: project.id, kind: 'app', name: 'web', config: appConfig() })
  ctx.store.setProjectReleased(project.id, new Date())

  const deps = createHttpProxyDeps(ctx)
  await assert.rejects(() => deps.resolve('web.blog.localhost'), /was released/)
})

// A released project is a reason not to route a request. It is not a reason
// to stop renewing a certificate for a name that genuinely belongs here.
test('the tls ask gate still allows a released project hostname', async () => {
  const ctx = buildContext()
  const project = ctx.store.createProject({ name: 'blog', sleepAfterSeconds: null })
  ctx.store.createResource({ projectId: project.id, kind: 'app', name: 'web', config: appConfig() })
  ctx.store.setProjectReleased(project.id, new Date())

  const deps = createHttpProxyDeps(ctx)
  assert.equal(await deps.allowHostname?.('web.blog.localhost'), true)
  assert.equal(await deps.allowHostname?.('nothing.here.localhost'), false)
})

interface Fetched {
  status: number
  body: string
}

// A real request through a real node:http router, the same shape
// packages/proxy/test/http.test.ts uses for the router itself. This proves
// the daemon's resolve(), not a fake, actually lands on the status a
// browser would see, rather than just asserting on a rejected promise.
function fetchThrough(port: number, host: string, path = '/'): Promise<Fetched> {
  return new Promise((resolve, reject) => {
    const req = httpGet({ host: '127.0.0.1', port, path, headers: { host } }, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (chunk: string) => {
        body += chunk
      })
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }))
    })
    req.on('error', reject)
  })
}

// Deliberately a throw from resolve(), not a failure in wake(). A wake
// failure is bucketed `timeout` and rendered 504 (packages/proxy/src/http.ts:249-251),
// which would tell the user their app was slow to start; nothing timed out
// here, there is simply no code. A resolve() throw is bucketed `refused`
// and rendered 503 with the message (packages/proxy/src/http.ts:245-247),
// the same path the released-project test above already exercises.
test('an undeployed hostname answers 503 naming the command that fixes it', async () => {
  const ctx = buildContext()
  const project = ctx.store.createProject({ name: 'blog', sleepAfterSeconds: null })
  const resource = ctx.store.createResource({
    projectId: project.id,
    kind: 'app',
    name: 'web',
    config: appConfig(),
  })
  ctx.store.setResourceState(resource.id, 'undeployed')

  const deps = createHttpProxyDeps(ctx)
  const router = await startHttpRouter(deps, { port: 0 })
  try {
    const res = await fetchThrough(router.port, 'web.blog.localhost')
    assert.equal(res.status, 503)
    assert.match(res.body, /has no code deployed yet/)
    assert.match(res.body, /hobby deploy <path> --project blog --name web/)
  } finally {
    await router.close()
  }
})

// allowHostname wraps resolve() in a try and returns true on throw
// (context.ts's createHttpProxyDeps.allowHostname), deliberately, so a
// hostname that genuinely belongs to this box still gets a certificate. An
// undeployed resource inherits that for free: without it, a user's first
// deploy would also be their first TLS handshake and both would fail
// together.
test('an undeployed hostname is still allowed a certificate', async () => {
  const ctx = buildContext()
  const project = ctx.store.createProject({ name: 'blog', sleepAfterSeconds: null })
  const resource = ctx.store.createResource({
    projectId: project.id,
    kind: 'app',
    name: 'web',
    config: appConfig(),
  })
  ctx.store.setResourceState(resource.id, 'undeployed')

  const deps = createHttpProxyDeps(ctx)
  assert.equal(await deps.allowHostname?.('web.blog.localhost'), true)
})

// The two failure modes must stay distinguishable: 404 means no resource
// owns this name at all (a typo, or nothing was ever created), 503 means a
// resource owns it and has no code yet. Collapsing them would make the
// undeployed case indistinguishable from a hostname nobody ever registered.
test('a hostname that does not exist at all still answers 404, not 503', async () => {
  const ctx = buildContext()
  ctx.store.createProject({ name: 'blog', sleepAfterSeconds: null })

  const deps = createHttpProxyDeps(ctx)
  const router = await startHttpRouter(deps, { port: 0 })
  try {
    const res = await fetchThrough(router.port, 'nope.blog.localhost')
    assert.equal(res.status, 404)
  } finally {
    await router.close()
  }
})

interface RecordedCall {
  url: string
  init: RequestInit
}

function fakeFetch(): { fetchFn: typeof fetch; calls: RecordedCall[] } {
  const calls: RecordedCall[] = []
  const fetchFn = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} })
    return new Response('{}', { status: 200 })
  }) as typeof fetch
  return { fetchFn, calls }
}

function lastConfig(calls: RecordedCall[]): {
  apps: {
    http: { servers: { hobby: { routes: Array<{ '@id'?: string; match?: unknown }> } } }
    tls?: { on_demand?: { permission?: { endpoint?: string } } }
  }
} {
  const call = calls[calls.length - 1]
  assert.ok(call !== undefined)
  return JSON.parse(String(call.init.body)) as ReturnType<typeof lastConfig>
}

// Order is the whole contract: a route with no matcher matches everything,
// so the catch-all last is the difference between Studio working and Studio
// being swallowed by the app router.
test('the caddy fallback route is always last and carries no host matcher', async () => {
  const { fetchFn, calls } = fakeFetch()
  const manager = createCaddyManager(createFakeRuntime(), { adminPort: 2019, fetchFn })

  await manager.setFallback({ upstream: '127.0.0.1:7433' })
  await manager.addRoute({ id: 'studio', host: 'studio.example.com', upstream: '127.0.0.1:7432' })

  const routes = lastConfig(calls).apps.http.servers.hobby.routes
  assert.equal(routes.length, 2)
  assert.equal(routes[0]?.['@id'], 'studio')
  assert.ok(routes[0]?.match !== undefined, 'the studio route keeps its host matcher')
  assert.equal(routes[1]?.['@id'], 'hobby-fallback')
  assert.equal(routes[1]?.match, undefined, 'the catch-all must match everything')
})

test('on-demand TLS is configured only when an ask endpoint is given', async () => {
  const { fetchFn, calls } = fakeFetch()
  const manager = createCaddyManager(createFakeRuntime(), { adminPort: 2019, fetchFn })

  await manager.setFallback({ upstream: '127.0.0.1:7433' })
  assert.equal(lastConfig(calls).apps.tls, undefined, 'no ask endpoint means no on-demand issuance')

  await manager.setFallback({ upstream: '127.0.0.1:7433', askUrl: 'http://127.0.0.1:7433/.hobby/tls-ask' })
  assert.equal(
    lastConfig(calls).apps.tls?.on_demand?.permission?.endpoint,
    'http://127.0.0.1:7433/.hobby/tls-ask'
  )
})

test('clearing the fallback removes the catch-all route', async () => {
  const { fetchFn, calls } = fakeFetch()
  const manager = createCaddyManager(createFakeRuntime(), { adminPort: 2019, fetchFn })

  await manager.setFallback({ upstream: '127.0.0.1:7433' })
  await manager.setFallback(null)

  assert.deepEqual(lastConfig(calls).apps.http.servers.hobby.routes, [])
})
