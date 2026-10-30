// The `app` kind, against a fake runtime and an in-memory store. No Docker,
// no real build, no real TCP: the readiness probe is injected, which is the
// only way to exercise the wake path against a fake runtime that has nothing
// listening on any port.

import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
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
  proxyHost: '127.0.0.1',
  proxyTls: null,
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
    queuePort: 0,
    caddyEnabled: false,
    caddyAdminPort: 2019,
    caddyStudioHost: null,
    project: null,
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

// No caps reach the runtime any more (issue #150): `docker build --memory`
// and `--cpu-shares` are accepted and ignored under BuildKit, so passing
// them promised a limit the box was not enforcing. The build lock below is
// the one real mechanism, and it is pinned separately.
test('a build carries no memory or cpu caps, since BuildKit would ignore them', async () => {
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

  assert.equal(runtime._builds.length, 1)
  assert.equal('memory' in (runtime._builds[0] ?? {}), false)
  assert.equal('cpuShares' in (runtime._builds[0] ?? {}), false)
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
// Issue #53: the URL used to point straight at the database container, so
// the app bypassed the wake-on-connect proxy and could neither wake its
// database nor keep it awake. It now goes through the proxy by the host's
// container-facing name, with the routing key `hobby connect` would print.
test('a bound database becomes DATABASE_URL through the proxy, by the host name a container can reach', async () => {
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
  assert.equal(spec.env['DATABASE_URL'], 'postgres://postgres:secret-password@host.docker.internal:5432/blog')
  assert.equal(spec.env['PORT'], '3000')
  assert.equal(spec.env['NODE_ENV'], 'production')
  assert.equal(spec.network, project.networkName)
  // What makes the host name resolve inside a container on Linux.
  assert.deepEqual(spec.extraHosts, [{ name: 'host.docker.internal', address: 'host-gateway' }])
})

test('a bound non-default database gets the dotted routing key, and an unbound app maps no extra host', async () => {
  const deps = buildDeps()
  const runtime = deps.runtime as ReturnType<typeof createFakeRuntime>
  const project = makeProject(deps.store)
  const pgConfig: PostgresConfig = {
    image: 'postgres:18-alpine',
    containerName: 'hobby-blog-analytics',
    hostPort: 15433,
    dataDir: '/tmp/pgdata2',
    superuser: 'postgres',
    password: 'secret-password',
    database: 'blog',
  }
  const db = deps.store.createResource({ projectId: project.id, kind: 'postgres', name: 'analytics', config: pgConfig })

  const bound = await createAppResource(deps, {
    project,
    name: 'web',
    source: null,
    image: 'nginx:alpine',
    containerPort: 3000,
    env: {},
    databaseResourceId: db.id,
  })
  assert.equal(
    runtime._specs.get(bound.config.containerName)?.env['DATABASE_URL'],
    'postgres://postgres:secret-password@host.docker.internal:5432/blog.analytics'
  )

  const unbound = await createAppResource(deps, {
    project,
    name: 'static',
    source: null,
    image: 'nginx:alpine',
    containerPort: 3000,
    env: {},
    databaseResourceId: null,
  })
  assert.deepEqual(runtime._specs.get(unbound.config.containerName)?.extraHosts, [])
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

// Issue #78: a redeploy that fails must leave the previous version serving.
// A build failure changes nothing, so the resource stays as it was.
test('a redeploy whose build fails leaves the working app exactly as it was', async () => {
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

  await assert.rejects(
    () => deployApp(deps, created, { source }),
    (err: unknown) => {
      assert.ok(err instanceof HobbyError)
      assert.equal(err.code, 'build_failed')
      assert.match(err.hint ?? '', /nothing was changed/)
      return true
    }
  )

  const after = deps.store.getResource(created.id)
  assert.equal(after?.state, 'sleeping')
  assert.equal(after?.config.image, created.config.image)
})

// The case from the issue: the build succeeds, the container is replaced,
// and the new code never listens. The previous image is put back.
test('a redeploy that fails readiness rolls back to the previous image', async () => {
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
    env: { GOOD: '1' },
    databaseResourceId: null,
  })
  const firstImage = created.config.image
  assert.ok(firstImage !== null)

  deps.now = () => 1_754_870_500_000
  deps.appProbeFactory = () => async () => false
  await assert.rejects(
    () => deployApp(deps, created, { source, env: { BROKEN: '1' } }),
    (err: unknown) => {
      assert.ok(err instanceof HobbyError)
      assert.equal(err.code, 'wake_timeout')
      assert.match(err.hint ?? '', new RegExp(`previous image ${firstImage} was put back`))
      return true
    }
  )

  const after = deps.store.getResource(created.id)
  assert.ok(after !== null && after.kind === 'app')
  assert.equal(after.state, 'sleeping')
  assert.equal(after.config.image, firstImage)
  assert.deepEqual(after.config.env, { GOOD: '1' })
  // The container on disk is the previous image's, stopped, ready to wake.
  assert.equal(runtime._specs.get(created.config.containerName)?.image, firstImage)
  assert.equal((await runtime.inspect(created.config.containerName)).running, false)
})

test('a redeploy of an already failed app stays failed, since there is nothing known good to go back to', async () => {
  const deps = buildDeps()
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
  deps.store.setResourceState(created.id, 'failed')
  const failed = deps.store.getResource(created.id)
  assert.ok(failed !== null && failed.kind === 'app')

  deps.appProbeFactory = () => async () => false
  await assert.rejects(() => deployApp(deps, failed, { source }), /did not start listening/)
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

// `hobby deploy --env-file`'s contract on a redeploy: a given env replaces
// the stored one wholesale, so a key removed from the file is gone, and an
// omitted env keeps what the app already had.
test('deploy with env replaces the stored env, and without it keeps it', async () => {
  const deps = buildDeps()
  const runtime = deps.runtime as ReturnType<typeof createFakeRuntime>
  const project = makeProject(deps.store)
  const app = await createAppResource(deps, {
    project,
    name: 'web',
    source: sourceDir(),
    image: null,
    containerPort: 3000,
    env: { OLD_KEY: 'old', SHARED: 'before' },
    databaseResourceId: null,
  })

  deps.now = () => 1_754_870_500_000
  const replaced = await deployApp(deps, app, { env: { SHARED: 'after', NEW_KEY: 'new' } })
  assert.deepEqual(replaced.resource.config.env, { SHARED: 'after', NEW_KEY: 'new' })
  const spec = runtime._specs.get(app.config.containerName)
  assert.ok(spec !== undefined)
  assert.equal(spec.env['OLD_KEY'], undefined)
  assert.equal(spec.env['NEW_KEY'], 'new')

  deps.now = () => 1_754_870_600_000
  const kept = await deployApp(deps, replaced.resource)
  assert.deepEqual(kept.resource.config.env, { SHARED: 'after', NEW_KEY: 'new' })
})

// A bound database is the authoritative DATABASE_URL. An env file copied
// from a laptop that still says localhost must not override it.
test('a bound database wins over a DATABASE_URL in the app env', async () => {
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
    env: { DATABASE_URL: 'postgres://localhost:5432/dev', OTHER: 'x' },
    databaseResourceId: db.id,
  })

  const spec = runtime._specs.get(app.config.containerName)
  assert.ok(spec !== undefined)
  assert.equal(spec.env['DATABASE_URL'], 'postgres://postgres:secret-password@host.docker.internal:5432/blog')
  assert.equal(spec.env['OTHER'], 'x')
})

// Issue #146: a Dockerfile that is not `<path>/Dockerfile`, and build args,
// both persisted so a redeploy rebuilds the same way.
test('an app source names its Dockerfile relative to the context and carries build args to the build', async () => {
  const deps = buildDeps()
  const runtime = deps.runtime as ReturnType<typeof createFakeRuntime>
  const project = makeProject(deps.store)
  const root = mkdtempSync(join(tmpdir(), 'hobby-mono-'))
  mkdirSync(join(root, 'deploy'))
  writeFileSync(join(root, 'deploy', 'admin.Dockerfile'), 'FROM scratch\nARG NEXT_PUBLIC_URL\n')

  const app = await createAppResource(deps, {
    project,
    name: 'admin',
    source: { path: root, dockerfile: 'deploy/admin.Dockerfile', buildArgs: { NEXT_PUBLIC_URL: 'https://admin.example' } },
    image: null,
    containerPort: 3000,
    env: {},
    databaseResourceId: null,
  })
  assert.equal(runtime._builds[0]?.contextPath, root)
  assert.equal(runtime._builds[0]?.dockerfile, join(root, 'deploy', 'admin.Dockerfile'))
  assert.deepEqual(runtime._builds[0]?.buildArgs, { NEXT_PUBLIC_URL: 'https://admin.example' })
  assert.deepEqual(app.config.source, {
    path: root,
    dockerfile: 'deploy/admin.Dockerfile',
    buildArgs: { NEXT_PUBLIC_URL: 'https://admin.example' },
  })

  // A redeploy with no source given rebuilds from the stored one, args included.
  await deployApp(deps, app, {})
  assert.deepEqual(runtime._builds[1]?.buildArgs, { NEXT_PUBLIC_URL: 'https://admin.example' })
  assert.equal(runtime._builds[1]?.dockerfile, join(root, 'deploy', 'admin.Dockerfile'))
})

// Issue #80: a first deploy whose readiness probe fails used to leave its
// container running for good: a `failed` row is outside the hibernator's
// gate, so nothing else ever stopped it.
test('a create that fails readiness stops and removes the container it started', async () => {
  const deps = buildDeps({ appProbeFactory: () => async () => false })
  const runtime = deps.runtime as ReturnType<typeof createFakeRuntime>
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
    /did not start listening/
  )

  const row = deps.store.listResources(project.id)[0]
  assert.ok(row !== undefined && row.kind === 'app')
  assert.equal(row.state, 'failed')
  assert.equal((await runtime.inspect(row.config.containerName)).exists, false, 'no container is left behind')
})

// Issue #84: every tag the app ever built goes with it, and a deploy keeps
// only the newest three.
test('destroy removes every tag under the app repository, and deploy prunes to the newest three', async () => {
  let at = 1_754_870_400_000
  const deps = buildDeps({ now: () => at })
  const runtime = deps.runtime as ReturnType<typeof createFakeRuntime>
  const project = makeProject(deps.store)
  const source = sourceDir()

  let app = await createAppResource(deps, { project, name: 'web', source, image: null, containerPort: 3000, env: {}, databaseResourceId: null })
  for (let i = 0; i < 4; i++) {
    at += 1000
    app = (await deployApp(deps, app)).resource
  }
  const tags = [...runtime._images].filter((tag) => tag.startsWith('hobby/blog-web:')).sort()
  assert.deepEqual(tags, [
    buildTag('blog', 'web', at - 2000),
    buildTag('blog', 'web', at - 1000),
    buildTag('blog', 'web', at),
  ])
  assert.equal(app.config.image, buildTag('blog', 'web', at))

  await destroyApp(deps, app)
  assert.deepEqual([...runtime._images].filter((tag) => tag.startsWith('hobby/blog-web:')), [])
})

// Issue #81: a redeploy applies a new port and database binding, and keeps
// both when neither is given.
test('deploy applies containerPort and databaseResourceId, and keeps them when absent', async () => {
  const deps = buildDeps()
  const project = makeProject(deps.store)
  const app = await createAppResource(deps, { project, name: 'web', source: sourceDir(), image: null, containerPort: 3000, env: {}, databaseResourceId: null })

  const changed = await deployApp(deps, app, { containerPort: 8080, databaseResourceId: 'db-1' as never })
  assert.equal(changed.resource.config.containerPort, 8080)
  assert.equal(changed.resource.config.databaseResourceId, 'db-1')
  const spec = (deps.runtime as ReturnType<typeof createFakeRuntime>)._specs.get(app.config.containerName)
  assert.equal(spec?.env['PORT'], '8080', 'the container is told the new port')

  const kept = await deployApp(deps, changed.resource, {})
  assert.equal(kept.resource.config.containerPort, 8080)
  assert.equal(kept.resource.config.databaseResourceId, 'db-1')

  const unbound = await deployApp(deps, kept.resource, { databaseResourceId: null })
  assert.equal(unbound.resource.config.databaseResourceId, null)
})

// Issue #93: the build output of a first deploy is handed back, since the
// return type is the resource alone.
test('createAppResource hands the build output to onBuildLogs', async () => {
  const deps = buildDeps()
  const project = makeProject(deps.store)
  let logs = ''
  await createAppResource(deps, {
    project,
    name: 'web',
    source: sourceDir(),
    image: null,
    containerPort: 3000,
    env: {},
    databaseResourceId: null,
    onBuildLogs: (built) => {
      logs = built
    },
  })
  assert.match(logs, /fake build of hobby\/blog-web:/)
})

// Issue #55: a container that exits on boot is reported after one poll, with
// its exit code and the last lines it printed, not as a 30 second readiness
// timeout that blames a loopback bind.
test('an app whose process exits on boot fails fast with the exit code and its last log lines', async () => {
  const runtime = createFakeRuntime()
  runtime.logs = async (): Promise<string> => 'boom: missing SECRET_KEY\n'
  let probes = 0
  const deps = buildDeps({
    runtime,
    config: testConfig({ wakeTimeoutMs: 10_000, readinessPollMs: 5 }),
    appProbeFactory: (config) => async () => {
      probes++
      // The process died between the start and the first probe.
      runtime._state.set(config.containerName, { exists: true, running: false, exitCode: 1 })
      return false
    },
  })
  const project = makeProject(deps.store)

  const started = Date.now()
  await assert.rejects(
    () =>
      createAppResource(deps, {
        project,
        name: 'crash',
        source: null,
        image: 'crash:latest',
        containerPort: 3000,
        env: {},
        databaseResourceId: null,
      }),
    (err: unknown) => {
      assert.ok(err instanceof HobbyError)
      assert.equal(err.code, 'wake_failed')
      assert.match(err.message, /exited with code 1/)
      assert.match(err.hint ?? '', /missing SECRET_KEY/)
      assert.doesNotMatch(err.hint ?? '', /0\.0\.0\.0/, 'the loopback hint is for a process that is alive and not listening')
      return true
    }
  )
  assert.equal(probes, 1, 'noticed on the first failed probe, not after the timeout')
  assert.ok(Date.now() - started < 5000)
})
