// The `app` kind, against a fake runtime and an in-memory store. No Docker,
// no real build, no real TCP: the readiness probe is injected, which is the
// only way to exercise the wake path against a fake runtime that has nothing
// listening on any port.

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
import { buildTag, resolveSource, withBuildLock } from '../src/build.js'
import { createAppResource, deployApp, destroyApp, startApp, stopApp, type AppDeps } from '../src/app.js'

function testConfig(overrides: Partial<HobbyConfig> = {}): HobbyConfig {
  return {
    image: 'postgres:18-alpine',
    proxyPort: 5432,
    studioPort: 8443,
    apiPort: 7432,
    httpPort: 7433,
    domain: 'localhost',
    sleepAfterSeconds: 300,
    // Short: any path that waits for readiness against a fake runtime with
    // nothing listening runs its budget out, and these tests exercise that
    // path deliberately.
    wakeTimeoutMs: 100,
    readinessPollMs: 10,
    caddyEnabled: false,
    caddyAdminPort: 2019,
    caddyStudioHost: null,
    ...overrides,
  }
}

function buildDeps(overrides: Partial<AppDeps> = {}): AppDeps & { store: Store } {
  const store = openStore(':memory:')
  return {
    store,
    runtime: createFakeRuntime(),
    paths: resolvePaths({ HOBBY_HOME: join(tmpdir(), `hobby-app-test-${randomUUID()}`) }),
    config: testConfig(),
    // Listening by default. A test that wants the failure path overrides it.
    appProbeFactory: () => async () => true,
    now: () => 1_754_870_400_000,
    ...overrides,
  }
}

function makeProject(store: Store, name = 'blog'): Project {
  return store.createProject({ name, sleepAfterSeconds: 300 })
}

// A real directory with a real Dockerfile in it, since resolveSource checks
// the filesystem before Docker is ever involved.
function sourceDir(): { path: string; dockerfile: string } {
  const dir = mkdtempSync(join(tmpdir(), 'hobby-app-src-'))
  writeFileSync(join(dir, 'Dockerfile'), 'FROM scratch\n')
  return { path: dir, dockerfile: 'Dockerfile' }
}

test('creating an app from a Dockerfile builds, proves it serves, and leaves it asleep', async () => {
  const deps = buildDeps()
  const runtime = deps.runtime as ReturnType<typeof createFakeRuntime>
  const project = makeProject(deps.store)

  const app = await createAppResource(deps, {
    project,
    name: 'web',
    source: sourceDir(),
    image: null,
    containerPort: 3000,
    env: {},
    databaseResourceId: null,
  })

  assert.equal(app.kind, 'app')
  assert.equal(runtime._builds.length, 1, 'the Dockerfile should have been built exactly once')
  assert.equal(runtime._builds[0]?.tag, buildTag('blog', 'web', 1_754_870_400_000))
  assert.equal(app.config.image, runtime._builds[0]?.tag)
  assert.equal(app.config.hostname, 'web.blog.localhost')
  // Sleeping, not running: proving it boots is what create is for, and
  // sleeping is the correct resting state for a system whose premise is sleep.
  assert.equal(app.state, 'sleeping')
  assert.equal((await runtime.inspect(app.config.containerName)).running, false)
})

// A build always loses to whatever else is on the box, and a build that is
// capped is the difference between a slow deploy and a database missing its
// wake budget.
test('a build is capped and serialised', async () => {
  const deps = buildDeps()
  const runtime = deps.runtime as ReturnType<typeof createFakeRuntime>
  const project = makeProject(deps.store)

  await createAppResource(deps, {
    project,
    name: 'web',
    source: sourceDir(),
    image: null,
    containerPort: 3000,
    env: {},
    databaseResourceId: null,
  })

  assert.equal(runtime._builds[0]?.memory, '2g')
  assert.equal(runtime._builds[0]?.cpuShares, 512)
})

test('the build lock serialises overlapping builds', async () => {
  const order: string[] = []
  const slow = async (label: string, ms: number): Promise<void> => {
    order.push(`start:${label}`)
    await new Promise((resolve) => setTimeout(resolve, ms))
    order.push(`end:${label}`)
  }

  const first = withBuildLock(() => slow('a', 20))
  const second = withBuildLock(() => slow('b', 1))
  await Promise.all([first, second])

  assert.deepEqual(order, ['start:a', 'end:a', 'start:b', 'end:b'])
})

test('a failed build leaves no resource row behind', async () => {
  const runtime = createFakeRuntime()
  runtime.build = async (): Promise<string> => {
    throw new HobbyError('build_failed', 'docker build failed', 'step 3 of 7')
  }
  const deps = buildDeps({ runtime })
  const project = makeProject(deps.store)

  await assert.rejects(
    () =>
      createAppResource(deps, {
        project,
        name: 'web',
        source: sourceDir(),
        image: null,
        containerPort: 3000,
        env: {},
        databaseResourceId: null,
      }),
    /docker build failed/
  )

  // Nothing to clean up before retrying, which is the whole reason the build
  // runs before the row is written.
  assert.deepEqual(deps.store.listResources(), [])
})

test('an app that never listens fails with the loopback-bind hint, not a bare timeout', async () => {
  const deps = buildDeps({ appProbeFactory: () => async () => false })
  const project = makeProject(deps.store)

  await assert.rejects(
    () =>
      createAppResource(deps, {
        project,
        name: 'web',
        source: null,
        image: 'nginx:alpine',
        containerPort: 3000,
        env: {},
        databaseResourceId: null,
      }),
    (err: unknown) => {
      assert.ok(err instanceof HobbyError)
      assert.equal(err.code, 'wake_timeout')
      // The actual failure most people hit, named.
      assert.match(err.hint ?? '', /0\.0\.0\.0/)
      return true
    }
  )
})

// Renamed from "an app needs exactly one of a build source and a prebuilt
// image": neither-supplied used to be rejected here and is now the
// record-before-code path (see 'an app created without a source or an
// image...' below), so only the both-supplied case is still ambiguous and
// still refused.
test('an app cannot take both a build source and a prebuilt image', async () => {
  const deps = buildDeps()
  const project = makeProject(deps.store)
  const base = { project, name: 'web', containerPort: 3000, env: {}, databaseResourceId: null }

  await assert.rejects(
    () => createAppResource(deps, { ...base, source: sourceDir(), image: 'nginx' }),
    /takes either a build source or a prebuilt image, not both/
  )
})

test('an app created without a source is undeployed, has a hostname, and has no image', async () => {
  const deps = buildDeps()
  const project = makeProject(deps.store)

  const app = await createAppResource(deps, {
    project,
    name: 'site',
    source: null,
    image: null,
    containerPort: 3000,
    env: {},
    databaseResourceId: null,
  })

  assert.equal(app.kind, 'app')
  assert.equal(app.state, 'undeployed')
  assert.equal(app.config.image, null)
  // The hostname is allocated now, not at deploy, so Studio can show the URL
  // before there is anything behind it and Caddy can be asked for a
  // certificate for it.
  assert.equal(app.config.hostname, 'site.blog.localhost')
  assert.ok(app.config.hostPort > 0)
})

test('creating an app without a source builds nothing and starts nothing', async () => {
  const deps = buildDeps()
  const runtime = deps.runtime as ReturnType<typeof createFakeRuntime>
  const project = makeProject(deps.store)

  const app = await createAppResource(deps, {
    project,
    name: 'site',
    source: null,
    image: null,
    containerPort: 3000,
    env: {},
    databaseResourceId: null,
  })

  // The fake runtime records every build and every container it was asked to
  // create. A record is a row, not a container.
  assert.deepEqual(runtime._builds, [])
  assert.equal(runtime._specs.has(app.config.containerName), false)
  assert.equal((await runtime.inspect(app.config.containerName)).exists, false)
})

// The reason a project has a docker network at all. An app reaches its
// database by container name inside that network, which means it does not
// depend on the database's published host port and keeps working if that
// port is ever reallocated.
test('a bound database becomes DATABASE_URL against the container, not loopback', async () => {
  const deps = buildDeps()
  const runtime = deps.runtime as ReturnType<typeof createFakeRuntime>
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

  const app = await createAppResource(deps, {
    project,
    name: 'web',
    source: null,
    image: 'nginx:alpine',
    containerPort: 3000,
    env: { NODE_ENV: 'production' },
    databaseResourceId: db.id,
  })

  const spec = runtime._specs.get(app.config.containerName)
  assert.ok(spec !== undefined)
  assert.equal(spec.env['DATABASE_URL'], 'postgres://postgres:secret-password@hobby-blog-primary:5432/blog')
  assert.equal(spec.env['PORT'], '3000')
  assert.equal(spec.env['NODE_ENV'], 'production')
  // On the project network, which is what makes the container name resolve.
  assert.equal(spec.network, project.networkName)
})

test('an app publishes only on loopback', async () => {
  const deps = buildDeps()
  const runtime = deps.runtime as ReturnType<typeof createFakeRuntime>
  const project = makeProject(deps.store)

  const app = await createAppResource(deps, {
    project,
    name: 'web',
    source: null,
    image: 'nginx:alpine',
    containerPort: 8080,
    env: {},
    databaseResourceId: null,
  })

  const spec = runtime._specs.get(app.config.containerName)
  assert.equal(spec?.ports[0]?.bind, '127.0.0.1')
  assert.equal(spec?.ports[0]?.container, 8080)
})

test('start then stop moves an app between running and sleeping', async () => {
  const deps = buildDeps()
  const project = makeProject(deps.store)
  const app = await createAppResource(deps, {
    project,
    name: 'web',
    source: null,
    image: 'nginx:alpine',
    containerPort: 3000,
    env: {},
    databaseResourceId: null,
  })

  await startApp(deps, app)
  assert.equal(deps.store.getResource(app.id)?.state, 'running')

  await stopApp(deps, app)
  assert.equal(deps.store.getResource(app.id)?.state, 'sleeping')
})

test('deploy rebuilds, replaces the container, and keeps the previous image on disk', async () => {
  const deps = buildDeps()
  const runtime = deps.runtime as ReturnType<typeof createFakeRuntime>
  const project = makeProject(deps.store)
  const source = sourceDir()

  const app = await createAppResource(deps, {
    project,
    name: 'web',
    source,
    image: null,
    containerPort: 3000,
    env: {},
    databaseResourceId: null,
  })
  const firstImage = app.config.image
  // Built from a source, so createAppResource must have produced a real
  // image by the time it returned; narrowed rather than asserted away so a
  // regression that leaves it null fails this test loudly instead of at the
  // Set lookup below.
  assert.ok(firstImage !== null)

  // A later clock so the new tag differs from the first.
  deps.now = () => 1_754_870_500_000
  const result = await deployApp(deps, app)

  assert.notEqual(result.image, firstImage)
  assert.equal(runtime._builds.length, 2)
  assert.equal(deps.store.getResource(app.id)?.config.image, result.image)
  // The image that is known to have served is still there to roll back to.
  assert.equal(runtime._images.has(firstImage), true)
  assert.equal(result.resource.state, 'sleeping')
})

test('deploy refuses an app that was created from a prebuilt image', async () => {
  const deps = buildDeps()
  const project = makeProject(deps.store)
  const app = await createAppResource(deps, {
    project,
    name: 'web',
    source: null,
    image: 'nginx:alpine',
    containerPort: 3000,
    env: {},
    databaseResourceId: null,
  })

  await assert.rejects(() => deployApp(deps, app), /has no source to rebuild/)
})

// Record-before-code's actual acceptance criterion: deploy is the transition
// out of `undeployed`, for the CLI's create-and-deploy-in-one-call door and
// for Studio/MCP's create-now-deploy-later door alike.
test('deploying an undeployed app populates its image and leaves it sleeping', async () => {
  const deps = buildDeps()
  const project = makeProject(deps.store)
  const created = await createAppResource(deps, {
    project,
    name: 'site',
    source: null,
    image: null,
    containerPort: 3000,
    env: {},
    databaseResourceId: null,
  })
  assert.equal(created.state, 'undeployed')

  const result = await deployApp(deps, created, { source: sourceDir() })

  assert.equal(result.resource.state, 'sleeping')
  assert.notEqual(result.resource.config.image, null)
  // The identity allocated at creation survives the deploy. A hostname that
  // changed on first deploy would invalidate anything the user had already
  // written down or pointed DNS at.
  assert.equal(result.resource.config.hostname, created.config.hostname)
  assert.equal(result.resource.config.hostPort, created.config.hostPort)
})

test('a failed first deploy returns the resource to undeployed, not failed', async () => {
  // `failed` means "there is code here and it broke". `undeployed` means
  // "there is no code here". Collapsing the two leaves Studio unable to say
  // which command fixes it, which is the whole reason the state exists.
  const runtime = createFakeRuntime()
  runtime.build = async (): Promise<string> => {
    throw new HobbyError('build_failed', 'docker build failed', 'step 3 of 7')
  }
  const deps = buildDeps({ runtime })
  const project = makeProject(deps.store)
  const created = await createAppResource(deps, {
    project,
    name: 'site',
    source: null,
    image: null,
    containerPort: 3000,
    env: {},
    databaseResourceId: null,
  })

  await assert.rejects(() => deployApp(deps, created, { source: sourceDir() }), /docker build failed/)

  assert.equal(deps.store.getResource(created.id)?.state, 'undeployed')
})

// I4: unlike the build-failure test above, this fails AFTER the container was
// created and started (the build succeeds, replaceContainer and
// runtime.start both succeed, only the readiness probe fails), which is the
// shape that used to leak a container nothing would ever stop: rolling
// `state` back to `undeployed` hides it from reconcile.ts (skipReconcile)
// and from the hibernator (its `state !== 'running'` gate), so a container
// left running here would run forever.
test('a failed first deploy on the readiness probe leaves no running container', async () => {
  const deps = buildDeps({ appProbeFactory: () => async () => false })
  const runtime = deps.runtime as ReturnType<typeof createFakeRuntime>
  const project = makeProject(deps.store)
  const created = await createAppResource(deps, {
    project,
    name: 'site',
    source: null,
    image: null,
    containerPort: 3000,
    env: {},
    databaseResourceId: null,
  })

  await assert.rejects(() => deployApp(deps, created, { source: sourceDir() }), /did not start listening/)

  assert.equal(deps.store.getResource(created.id)?.state, 'undeployed')
  const status = await runtime.inspect(created.config.containerName)
  assert.equal(status.exists, false)
})

test('a failed redeploy of a working app leaves it failed, because it does have code', async () => {
  const deps = buildDeps()
  const runtime = deps.runtime as ReturnType<typeof createFakeRuntime>
  const project = makeProject(deps.store)
  const source = sourceDir()

  const created = await createAppResource(deps, {
    project,
    name: 'site',
    source,
    image: null,
    containerPort: 3000,
    env: {},
    databaseResourceId: null,
  })
  assert.equal(created.state, 'sleeping')

  runtime.build = async (): Promise<string> => {
    throw new HobbyError('build_failed', 'docker build failed', 'step 3 of 7')
  }

  await assert.rejects(() => deployApp(deps, created, { source }), /docker build failed/)

  assert.equal(deps.store.getResource(created.id)?.state, 'failed')
})

test('destroy removes the container and only an image we built', async () => {
  const deps = buildDeps()
  const runtime = deps.runtime as ReturnType<typeof createFakeRuntime>
  const project = makeProject(deps.store)

  const built = await createAppResource(deps, {
    project,
    name: 'web',
    source: sourceDir(),
    image: null,
    containerPort: 3000,
    env: {},
    databaseResourceId: null,
  })
  const builtImage = built.config.image
  // Built from a source, so createAppResource must have produced a real
  // image by the time it returned.
  assert.ok(builtImage !== null)
  await destroyApp(deps, built)
  assert.equal(runtime._images.has(builtImage), false, 'an image we built goes with the resource')
  assert.equal((await runtime.inspect(built.config.containerName)).exists, false)
  assert.equal(deps.store.getResource(built.id), null)

  // A user-supplied image may be shared with anything else on the box,
  // including their own work outside hobby.
  runtime._images.add('nginx:alpine')
  const pulled = await createAppResource(deps, {
    project,
    name: 'other',
    source: null,
    image: 'nginx:alpine',
    containerPort: 3000,
    env: {},
    databaseResourceId: null,
  })
  await destroyApp(deps, pulled)
  assert.equal(runtime._images.has('nginx:alpine'), true, 'a pulled image must survive its resource')
})

test('resolveSource reports a missing Dockerfile before Docker is involved', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hobby-app-empty-'))
  assert.throws(
    () => resolveSource({ path: dir, dockerfile: 'Dockerfile' }),
    (err: unknown) => {
      assert.ok(err instanceof HobbyError)
      assert.equal(err.code, 'usage')
      assert.match(err.message, /no Dockerfile at/)
      return true
    }
  )
  assert.throws(
    () => resolveSource({ path: join(dir, 'nope'), dockerfile: 'Dockerfile' }),
    /build context does not exist/
  )
})
