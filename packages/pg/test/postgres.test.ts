// Written but not executed in this task, see task-3-report.md.

import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  createFakeRuntime,
  openStore,
  resolvePaths,
  type ComputeRuntime,
  type HobbyConfig,
  type PostgresConfig,
} from '@hobby.sh/core'
import { createPostgres, destroyPostgres, startPostgres } from '../src/index.js'
import { waitReady } from '../src/readiness.js'

function sampleConfig(): PostgresConfig {
  return {
    image: 'postgres:18-alpine',
    containerName: 'hobby-blog-primary',
    dataDir: '/home/user/.hobby/projects/blog/primary/pgdata',
    hostPort: 15432,
    superuser: 'postgres',
    password: 'secret',
    database: 'blog',
  }
}

function fakeClock(startAt = 0): { now: () => number; sleepFor: (ms: number) => Promise<void> } {
  let time = startAt
  return {
    now: () => time,
    sleepFor: async (ms: number) => {
      time += ms
    },
  }
}

function testHobbyConfig(): HobbyConfig {
  return {
    image: 'postgres:18-alpine',
    proxyPort: 5432,
    studioPort: 8443,
    apiPort: 7432,
    sleepAfterSeconds: 300,
    wakeTimeoutMs: 30000,
    readinessPollMs: 25,
  }
}

test('waitReady returns on the first successful probe', async () => {
  const clock = fakeClock()
  let calls = 0

  const result = await waitReady({
    config: sampleConfig(),
    pollMs: 100,
    timeoutMs: 1000,
    probe: async () => {
      calls++
      return true
    },
    sleepFor: clock.sleepFor,
    now: clock.now,
  })

  assert.deepEqual(result, { ready: true, attempts: 1, waitedMs: 0 })
  assert.equal(calls, 1)
})

test('waitReady counts attempts across failed probes before succeeding', async () => {
  const clock = fakeClock()
  let calls = 0

  const result = await waitReady({
    config: sampleConfig(),
    pollMs: 50,
    timeoutMs: 1000,
    probe: async () => {
      calls++
      return calls >= 3
    },
    sleepFor: clock.sleepFor,
    now: clock.now,
  })

  assert.equal(result.ready, true)
  assert.equal(result.attempts, 3)
  assert.equal(result.waitedMs, 100) // two 50ms sleeps before the third, successful probe
})

test('waitReady respects the timeout and gives up', async () => {
  const clock = fakeClock()
  let calls = 0

  const result = await waitReady({
    config: sampleConfig(),
    pollMs: 25,
    timeoutMs: 100,
    probe: async () => {
      calls++
      return false
    },
    sleepFor: clock.sleepFor,
    now: clock.now,
  })

  assert.equal(result.ready, false)
  assert.equal(result.attempts, 5)
  assert.equal(result.waitedMs, 100)
  assert.equal(calls, 5)
})

test('waitReady takes more attempts with a finer poll interval for the same timeout', async () => {
  async function run(pollMs: number) {
    const clock = fakeClock()
    return waitReady({
      config: sampleConfig(),
      pollMs,
      timeoutMs: 1000,
      probe: async () => false,
      sleepFor: clock.sleepFor,
      now: clock.now,
    })
  }

  const fine = await run(10)
  const coarse = await run(100)

  assert.equal(fine.ready, false)
  assert.equal(coarse.ready, false)
  assert.ok(fine.attempts > coarse.attempts, 'a finer poll interval should take more attempts')
})

test('createPostgres against the fake runtime leaves the resource sleeping with config populated', async () => {
  const store = openStore(':memory:')
  try {
    const project = store.createProject({ name: 'blog', sleepAfterSeconds: 300 })
    const runtime = createFakeRuntime()
    const paths = resolvePaths({ HOBBY_HOME: join(tmpdir(), `hobby-pg-test-${randomUUID()}`) })

    const resource = await createPostgres(
      {
        store,
        runtime,
        paths,
        config: testHobbyConfig(),
        // No real Postgres is listening anywhere in this test: the fake
        // runtime never boots a real container. This is the seam described
        // in postgres.ts's PgDeps comment that makes createPostgres testable
        // at all against createFakeRuntime.
        probeFactory: () => async () => true,
      },
      { project, name: 'primary' }
    )

    assert.equal(resource.state, 'sleeping')
    assert.equal(resource.projectId, project.id)
    assert.equal(resource.name, 'primary')
    assert.equal(resource.config.containerName, 'hobby-blog-primary')
    assert.equal(resource.config.database, 'blog')
    assert.equal(resource.config.superuser, 'postgres')
    assert.equal(resource.config.image, 'postgres:18-alpine')
    assert.equal(resource.config.password.length, 32)
    assert.ok(resource.config.hostPort >= 15432 && resource.config.hostPort <= 25432)

    const status = await runtime.inspect(resource.config.containerName)
    assert.equal(status.exists, true)
    assert.equal(status.running, false)

    const spec = runtime._specs.get(resource.config.containerName)
    assert.ok(spec !== undefined)
    assert.equal(spec?.network, project.networkName)
    assert.deepEqual(spec?.binds, [
      { host: resource.config.dataDir, container: '/var/lib/postgresql/data' },
    ])
    assert.deepEqual(spec?.env.POSTGRES_DB, 'blog')
  } finally {
    store.close()
  }
})

test('createPostgres marks the resource failed when readiness never arrives', async () => {
  const store = openStore(':memory:')
  try {
    const project = store.createProject({ name: 'blog', sleepAfterSeconds: 300 })
    const runtime = createFakeRuntime()
    const paths = resolvePaths({ HOBBY_HOME: join(tmpdir(), `hobby-pg-test-${randomUUID()}`) })

    await assert.rejects(
      () =>
        createPostgres(
          {
            store,
            runtime,
            paths,
            config: { ...testHobbyConfig(), wakeTimeoutMs: 10, readinessPollMs: 5 },
            probeFactory: () => async () => false,
          },
          { project, name: 'primary' }
        ),
      (err: unknown) => {
        assert.ok(err instanceof Error)
        assert.equal((err as { code?: string }).code, 'wake_failed')
        return true
      }
    )

    const resource = store.getResourceByName(project.id, 'primary')
    assert.equal(resource?.state, 'failed')
  } finally {
    store.close()
  }
})

test('destroyPostgres deletes the row even when the container was never created', async () => {
  const store = openStore(':memory:')
  try {
    const project = store.createProject({ name: 'blog', sleepAfterSeconds: 300 })
    const config: PostgresConfig = { ...sampleConfig(), containerName: 'hobby-blog-primary' }
    const created = store.createResource({
      projectId: project.id,
      kind: 'postgres',
      name: 'primary',
      config,
    })
    store.setResourceState(created.id, 'failed')
    const resource = store.getResource(created.id)
    assert.ok(resource !== null)

    // A fresh fake runtime that was never told about this container via
    // ensureCreated: this is exactly the state a resource is left in when
    // createPostgres fails at mkdir or ensureNetwork, before ensureCreated
    // ever runs. stop() and remove() on a real (and fake) runtime resolve
    // as no-ops for a container that never existed, matching Docker's real
    // contract; this test pins that destroyPostgres still completes and
    // deletes the row in that case, without needing anything to throw.
    const runtime = createFakeRuntime()
    const paths = resolvePaths({ HOBBY_HOME: join(tmpdir(), `hobby-pg-test-${randomUUID()}`) })

    await destroyPostgres({ store, runtime, paths, config: testHobbyConfig() }, resource)

    assert.equal(store.getResource(created.id), null)
  } finally {
    store.close()
  }
})

test('destroyPostgres deletes the row and throws when removing the data directory fails', async () => {
  const store = openStore(':memory:')
  try {
    const project = store.createProject({ name: 'blog', sleepAfterSeconds: 300 })
    const config: PostgresConfig = { ...sampleConfig(), containerName: 'hobby-blog-primary' }
    const created = store.createResource({
      projectId: project.id,
      kind: 'postgres',
      name: 'primary',
      config,
    })

    const runtime = createFakeRuntime()
    await runtime.ensureCreated({
      name: config.containerName,
      image: config.image,
      env: {},
      ports: [],
      binds: [],
    })
    const paths = resolvePaths({ HOBBY_HOME: join(tmpdir(), `hobby-pg-test-${randomUUID()}`) })

    await assert.rejects(
      () =>
        destroyPostgres(
          {
            store,
            runtime,
            paths,
            config: testHobbyConfig(),
            // Simulates a real, non-not-found failure (a busy disk, a
            // permission error), which must not be swallowed the way a
            // missing container or a missing directory is.
            removeDataDir: async () => {
              throw new Error('device or resource busy')
            },
          },
          created
        ),
      (err: unknown) => {
        assert.ok(err instanceof Error)
        assert.equal((err as { code?: string }).code, 'internal')
        assert.match((err as Error).message, /remove data directory/)
        assert.match((err as Error).message, /device or resource busy/)
        return true
      }
    )

    // The row is still gone even though the call above threw: the record
    // must not survive a partial teardown, only the caller must be told
    // something may remain on disk.
    assert.equal(store.getResource(created.id), null)
  } finally {
    store.close()
  }
})

test('startPostgres marks the resource failed, not starting, when runtime.start throws', async () => {
  const store = openStore(':memory:')
  try {
    const project = store.createProject({ name: 'blog', sleepAfterSeconds: 300 })
    const config: PostgresConfig = { ...sampleConfig(), containerName: 'hobby-blog-primary' }
    const resource = store.createResource({
      projectId: project.id,
      kind: 'postgres',
      name: 'primary',
      config,
    })

    const base = createFakeRuntime()
    const failingRuntime: ComputeRuntime = {
      available: base.available,
      ensureCreated: base.ensureCreated,
      start: async () => {
        throw new Error('docker start failed')
      },
      stop: base.stop,
      remove: base.remove,
      inspect: base.inspect,
      logs: base.logs,
      ensureNetwork: base.ensureNetwork,
      removeNetwork: base.removeNetwork,
    }
    const paths = resolvePaths({ HOBBY_HOME: join(tmpdir(), `hobby-pg-test-${randomUUID()}`) })

    await assert.rejects(() =>
      startPostgres({ store, runtime: failingRuntime, paths, config: testHobbyConfig() }, resource)
    )

    const stored = store.getResource(resource.id)
    assert.equal(stored?.state, 'failed')
    assert.notEqual(stored?.state, 'starting')
  } finally {
    store.close()
  }
})
