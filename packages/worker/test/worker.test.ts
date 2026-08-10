// The worker kind without Docker: manifest reading, the runner manifest we
// hand the container, and the lifecycle against a fake runtime. The one
// thing these cannot cover is whether workerd actually boots inside the
// image, which is what the real-Docker run in the milestone report is for.

import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  createFakeRuntime,
  HobbyError,
  openStore,
  resolvePaths,
  type HobbyConfig,
  type PostgresConfig,
  type Project,
  type Store,
} from '@hobby.sh/core'
import {
  describeIgnored,
  findWranglerManifest,
  parseWranglerManifest,
  stripJsonComments,
} from '../src/manifest.js'
import { renderWorkerDockerfile, MINIFLARE_VERSION } from '../src/runtime-image.js'
import {
  buildRunnerManifest,
  createWorkerResource,
  deployWorker,
  startWorker,
  stopWorker,
  uniqueKeyFor,
  type WorkerDeps,
} from '../src/worker.js'

const SAMPLE_TOML = `
name = "api"
main = "src/index.ts"
compatibility_date = "2026-08-01"
compatibility_flags = ["nodejs_compat"]
account_id = "abc123"
workers_dev = true

[vars]
GREETING = "hello"
RETRIES = 3

[[kv_namespaces]]
binding = "CACHE"
id = "abc"

[[r2_buckets]]
binding = "MEDIA"
bucket_name = "media"

[[d1_databases]]
binding = "ANALYTICS"
database_name = "analytics"

[[durable_objects.bindings]]
name = "COUNTER"
class_name = "Counter"

[[queues.producers]]
queue = "jobs"
binding = "JOBS"

[[queues.consumers]]
queue = "jobs"

[[routes]]
pattern = "example.com/*"
`

function testConfig(): HobbyConfig {
  return {
    image: 'postgres:18-alpine',
    proxyPort: 5432,
    studioPort: 8443,
    apiPort: 7432,
    httpPort: 7433,
    domain: 'localhost',
    sleepAfterSeconds: 300,
    wakeTimeoutMs: 100,
    readinessPollMs: 10,
  }
}

function buildDeps(overrides: Partial<WorkerDeps> = {}): WorkerDeps & { store: Store } {
  const store = openStore(':memory:')
  return {
    store,
    runtime: createFakeRuntime(),
    paths: resolvePaths({ HOBBY_HOME: mkdtempSync(join(tmpdir(), 'hobby-worker-home-')) }),
    config: testConfig(),
    workerProbeFactory: () => async () => true,
    now: () => 1_754_870_400_000,
    ...overrides,
  }
}

function makeProject(store: Store): Project {
  return store.createProject({ name: 'blog', sleepAfterSeconds: 300 })
}

function workerSource(manifest = SAMPLE_TOML, file = 'wrangler.toml'): string {
  const dir = mkdtempSync(join(tmpdir(), 'hobby-worker-src-'))
  writeFileSync(join(dir, file), manifest)
  writeFileSync(join(dir, 'index.ts'), 'export default { fetch: () => new Response("ok") }\n')
  return dir
}

test('a wrangler.toml is read into the subset we honour', () => {
  const manifest = parseWranglerManifest(SAMPLE_TOML, 'toml')

  assert.equal(manifest.name, 'api')
  assert.equal(manifest.main, 'src/index.ts')
  assert.equal(manifest.compatibilityDate, '2026-08-01')
  assert.deepEqual(manifest.compatibilityFlags, ['nodejs_compat'])
  // Numbers become strings, which is what a Worker actually sees in env.
  assert.deepEqual(manifest.vars, { GREETING: 'hello', RETRIES: '3' })
  assert.deepEqual(manifest.kvNamespaces, ['CACHE'])
  assert.deepEqual(manifest.r2Buckets, ['MEDIA'])
  assert.deepEqual(manifest.d1Databases, ['ANALYTICS'])
  assert.deepEqual(manifest.durableObjects, [{ binding: 'COUNTER', className: 'Counter' }])
  assert.deepEqual(manifest.queues, { producers: ['jobs'], consumers: ['jobs'] })
})

// Silence about a dropped key in a config file the user believes is
// authoritative is how a platform earns a reputation for lying.
test('keys we do not act on are reported, with a reason where we have one', () => {
  const manifest = parseWranglerManifest(SAMPLE_TOML, 'toml')
  assert.deepEqual(manifest.ignored, ['account_id', 'routes', 'workers_dev'])

  const described = describeIgnored(manifest.ignored)
  assert.match(described.join('\n'), /routes: hostnames come from hobby/)
  assert.match(described.join('\n'), /account_id: has no meaning outside Cloudflare/)
})

test('an unrecognised key is reported as unrecognised, not silently explained away', () => {
  assert.deepEqual(describeIgnored(['some_future_key']), ['some_future_key: not recognised by hobby'])
})

test('a manifest with no main or no compatibility_date is refused with a reason', () => {
  assert.throws(
    () => parseWranglerManifest('name = "api"\ncompatibility_date = "2026-08-01"\n', 'toml'),
    (err: unknown) => {
      assert.ok(err instanceof HobbyError)
      assert.match(err.message, /no `main`/)
      return true
    }
  )
  assert.throws(
    () => parseWranglerManifest('main = "src/index.ts"\n', 'toml'),
    /no `compatibility_date`/
  )
})

test('wrangler.jsonc is read too, comments and all', () => {
  const jsonc = `{
  // the entry point
  "main": "src/index.ts",
  "compatibility_date": "2026-08-01", /* required by workerd */
  "vars": { "URL": "https://example.com//path" }
}`
  const manifest = parseWranglerManifest(jsonc, 'json')
  assert.equal(manifest.main, 'src/index.ts')
  // A `//` inside a string is not a comment. Stripping it would corrupt the
  // value, and a corrupted URL is a bug the user would blame on their code.
  assert.equal(manifest.vars['URL'], 'https://example.com//path')
})

test('stripJsonComments leaves string contents alone', () => {
  assert.equal(stripJsonComments('{"a":"x//y"}'), '{"a":"x//y"}')
  assert.equal(stripJsonComments('{"a":"x/*y*/z"}'), '{"a":"x/*y*/z"}')
  assert.equal(stripJsonComments('{"a":1} // trailing'), '{"a":1} ')
  assert.equal(stripJsonComments('{"a":"esc\\\\"} // x'), '{"a":"esc\\\\"} ')
})

test('findWranglerManifest prefers jsonc, then json, then toml', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hobby-worker-order-'))
  writeFileSync(join(dir, 'wrangler.toml'), 'main = "t.ts"\ncompatibility_date = "2026-01-01"\n')
  assert.equal(findWranglerManifest(dir).file, 'wrangler.toml')

  writeFileSync(join(dir, 'wrangler.jsonc'), '{"main":"j.ts","compatibility_date":"2026-01-01"}')
  assert.equal(findWranglerManifest(dir).file, 'wrangler.jsonc')
})

test('a directory with no manifest says what it looked for', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hobby-worker-empty-'))
  assert.throws(
    () => findWranglerManifest(dir),
    (err: unknown) => {
      assert.ok(err instanceof HobbyError)
      assert.match(err.message, /no wrangler manifest/)
      // The hint is where the useful part lives: "no manifest" alone does
      // not tell anyone what filenames were tried.
      assert.match(err.hint ?? '', /wrangler\.jsonc, wrangler\.json or wrangler\.toml/)
      return true
    }
  )
})

// The sharpest data-loss edge in the whole kind: workerd derives every
// Durable Object's storage identity from this, so a value that changes
// orphans every object silently.
test('the durable object unique key is derived from the resource id, not from names', async () => {
  const deps = buildDeps()
  const project = makeProject(deps.store)
  const result = await createWorkerResource(deps, {
    project,
    name: 'api',
    sourcePath: workerSource(),
    databaseResourceId: null,
  })

  const key = uniqueKeyFor(result.resource.id, 'Counter')
  assert.equal(key, `${result.resource.id}-Counter`)

  const manifest = buildRunnerManifest(deps, result.resource)
  assert.equal(manifest.durableObjects['COUNTER']?.unsafeUniqueKey, key)
  assert.equal(manifest.durableObjects['COUNTER']?.useSQLite, true)
})

test('a redeploy does not change the durable object unique key', async () => {
  const deps = buildDeps()
  const project = makeProject(deps.store)
  const source = workerSource()
  const created = await createWorkerResource(deps, {
    project,
    name: 'api',
    sourcePath: source,
    databaseResourceId: null,
  })
  const before = buildRunnerManifest(deps, created.resource).durableObjects['COUNTER']?.unsafeUniqueKey

  deps.now = () => 1_754_870_500_000
  const deployed = await deployWorker(deps, created.resource)
  const after = buildRunnerManifest(deps, deployed.resource).durableObjects['COUNTER']?.unsafeUniqueKey

  assert.equal(after, before)
  assert.notEqual(deployed.image, created.resource.config.image, 'the image should have changed even though the key did not')
})

test('a bound database becomes a hyperdrive binding against the container name', async () => {
  const deps = buildDeps()
  const project = makeProject(deps.store)
  const pgConfig: PostgresConfig = {
    image: 'postgres:18-alpine',
    containerName: 'hobby-blog-primary',
    hostPort: 15432,
    dataDir: '/tmp/pgdata',
    superuser: 'postgres',
    password: 'secret-password',
    database: 'blog',
  }
  const db = deps.store.createResource({ projectId: project.id, kind: 'postgres', name: 'primary', config: pgConfig })

  const result = await createWorkerResource(deps, {
    project,
    name: 'api',
    sourcePath: workerSource(),
    databaseResourceId: db.id,
  })

  const manifest = buildRunnerManifest(deps, result.resource)
  assert.equal(manifest.hyperdrives?.['DB'], 'postgres://postgres:secret-password@hobby-blog-primary:5432/blog')
})

test('the container mounts state and durable object storage separately', async () => {
  const deps = buildDeps()
  const runtime = deps.runtime as ReturnType<typeof createFakeRuntime>
  const project = makeProject(deps.store)
  const result = await createWorkerResource(deps, {
    project,
    name: 'api',
    sourcePath: workerSource(),
    databaseResourceId: null,
  })

  const spec = runtime._specs.get(result.resource.config.containerName)
  assert.ok(spec !== undefined)
  const targets = spec.binds.map((b) => b.container).sort()
  assert.deepEqual(targets, ['/hobby/do', '/hobby/state'])
  // The do/ mount is its own directory precisely so the daemon's alarm
  // mirror can scan it and find nothing but durable object storage.
  const doBind = spec.binds.find((b) => b.container === '/hobby/do')
  assert.match(doBind?.host ?? '', /projects\/blog\/api\/do$/)
  assert.equal(spec.ports[0]?.container, 8787)
  assert.equal(spec.ports[0]?.bind, '127.0.0.1')
})

test('a worker is created asleep, having been proven to serve', async () => {
  const deps = buildDeps()
  const project = makeProject(deps.store)
  const result = await createWorkerResource(deps, {
    project,
    name: 'api',
    sourcePath: workerSource(),
    databaseResourceId: null,
  })
  assert.equal(result.resource.state, 'sleeping')
  assert.deepEqual(result.ignored, ['account_id', 'routes', 'workers_dev'])
})

test('a worker that never serves fails with a hint about what to read', async () => {
  const deps = buildDeps({ workerProbeFactory: () => async () => false })
  const project = makeProject(deps.store)
  await assert.rejects(
    () =>
      createWorkerResource(deps, {
        project,
        name: 'api',
        sourcePath: workerSource(),
        databaseResourceId: null,
      }),
    (err: unknown) => {
      assert.ok(err instanceof HobbyError)
      assert.equal(err.code, 'wake_timeout')
      assert.match(err.hint ?? '', /compatibility_date/)
      return true
    }
  )
})

test('start and stop move a worker between running and sleeping', async () => {
  const deps = buildDeps()
  const project = makeProject(deps.store)
  const { resource } = await createWorkerResource(deps, {
    project,
    name: 'api',
    sourcePath: workerSource(),
    databaseResourceId: null,
  })

  await startWorker(deps, resource)
  assert.equal(deps.store.getResource(resource.id)?.state, 'running')
  await stopWorker(deps, resource)
  assert.equal(deps.store.getResource(resource.id)?.state, 'sleeping')
})

// Destroying a worker removes the thing that serves requests. It is not an
// instruction to delete data, and a Durable Object's sqlite file is user data
// in the way a postgres data directory is.
test('the generated Dockerfile pins miniflare and bundles for workerd', () => {
  const dockerfile = renderWorkerDockerfile({ main: 'src/index.ts' })
  assert.match(dockerfile, new RegExp(`npm install .*miniflare@${MINIFLARE_VERSION.replace(/\./g, '\\.')}`))
  assert.match(dockerfile, /--conditions=workerd,worker,browser/)
  assert.match(dockerfile, /--target=browser/)
  assert.match(dockerfile, /"src\/index\.ts"/)
  // The runner is embedded rather than COPYed, because the build context is
  // the user's own directory and hobby must not write files into it.
  assert.match(dockerfile, /base64 -d > \/hobby\/runner\.mjs/)
  assert.equal(dockerfile.includes('COPY runner.mjs'), false)
})

// Both of these cost a real Docker run to find, and both are the kind of
// thing that silently reverts under a "simplify the Dockerfile" edit.
test('bun builds and node runs, because miniflare does not work under bun', () => {
  const dockerfile = renderWorkerDockerfile({ main: 'src/index.ts' })
  assert.match(dockerfile, /^FROM oven\/bun:1-alpine AS build$/m)
  assert.match(dockerfile, /^CMD \["node", "\/hobby\/runner\.mjs"\]$/m)
  assert.equal(dockerfile.includes('CMD ["bun"'), false, 'miniflare asserts on a control pipe bun does not provide')
})

test('the runtime stage is glibc, because workerd ships no musl binary', () => {
  const dockerfile = renderWorkerDockerfile({ main: 'src/index.ts' })
  assert.match(dockerfile, /^FROM node:22-bookworm-slim$/m)
  assert.equal(
    /^FROM node:.*-alpine$/m.test(dockerfile),
    false,
    'on alpine, spawning workerd fails with ENOENT that reads like a missing file and is a missing platform'
  )
})

test('a worker entry path with a space or a quote cannot break out of the build command', () => {
  const dockerfile = renderWorkerDockerfile({ main: 'src/my worker".ts' })
  assert.match(dockerfile, /"src\/my worker\\"\.ts"/)
})
