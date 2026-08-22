// resourceSize's own policy: never touch Postgres for a resource that is
// not `running`, fall back to the last known size while sleeping, and keep
// that cache scoped to one DaemonContext. getSize is injected (the same
// seam pattern PgDeps.probeFactory and the hibernator's checkActiveQuery
// use) so every case here runs with zero real Postgres and zero real time.

import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { expectKind, createFakeRuntime, openStore, resolvePaths, type HobbyConfig, type PostgresConfig, type PostgresResource, type Resource, type Store } from '@hobby.sh/core'
import { ActivityTracker } from '@hobby.sh/proxy'
import { createDefaultKindRegistry } from '../src/daemon/context.js'
import { resourceSize } from '../src/daemon/size.js'
import type { DaemonContext } from '../src/index.js'

function testConfig(): HobbyConfig {
  return {
    image: 'postgres:18-alpine',
    proxyPort: 5432,
  proxyHost: '127.0.0.1',
    studioPort: 8443,
    apiPort: 7432,
    httpPort: 7433,
    domain: 'localhost',
    sleepAfterSeconds: 300,
    wakeTimeoutMs: 150,
    readinessPollMs: 20,
    queuePort: 0,
    caddyEnabled: false,
    caddyAdminPort: 2019,
    caddyStudioHost: null,
  }
}

function buildContext(): DaemonContext {
  const store: Store = openStore(':memory:')
  const paths = resolvePaths({ HOBBY_HOME: join(tmpdir(), `hobby-size-test-${randomUUID()}`) })
  return { store, runtime: createFakeRuntime(), paths, config: testConfig(), activity: new ActivityTracker(), kinds: createDefaultKindRegistry() }
}

function samplePostgresConfig(overrides: Partial<PostgresConfig> = {}): PostgresConfig {
  return {
    image: 'postgres:18-alpine',
    containerName: `hobby-blog-primary-${randomUUID()}`,
    dataDir: '/home/user/.hobby/projects/blog/primary/pgdata',
    hostPort: 25597,
    superuser: 'postgres',
    password: 'secret',
    database: 'blog',
    ...overrides,
  }
}

// Fetches the current row and asserts it exists, rather than a bare `!`:
// every resource in this file was just created a line or two above, so a
// null here means a real bug in the test setup, not a case worth silencing.
function mustGetResource(ctx: DaemonContext, id: string): PostgresResource {
  const resource = ctx.store.getResource(id)
  assert.ok(resource !== null, `expected resource ${id} to exist`)
  return expectKind(resource, 'postgres')
}

test('resourceSize: a sleeping resource with no prior size never calls getSize and returns null', async () => {
  const ctx = buildContext()
  const project = ctx.store.createProject({ name: 'blog', sleepAfterSeconds: 300 })
  const resource = ctx.store.createResource({ projectId: project.id, kind: 'postgres', name: 'primary', config: samplePostgresConfig() })
  ctx.store.setResourceState(resource.id, 'sleeping')

  let calls = 0
  const getSize = async (): Promise<number | null> => {
    calls++
    return 12345
  }

  const size = await resourceSize(ctx, mustGetResource(ctx, resource.id), getSize)
  assert.equal(size, null)
  assert.equal(calls, 0, 'a non-running resource must never be queried, per the "never wake to show size" rule')
  ctx.store.close()
})

test('resourceSize: a running resource is queried, and the result is cached for later sleeping lookups', async () => {
  const ctx = buildContext()
  const project = ctx.store.createProject({ name: 'blog', sleepAfterSeconds: 300 })
  const resource = ctx.store.createResource({ projectId: project.id, kind: 'postgres', name: 'primary', config: samplePostgresConfig() })
  ctx.store.setResourceState(resource.id, 'running')

  let calls = 0
  const getSize = async (): Promise<number | null> => {
    calls++
    return 98765
  }

  const runningSize = await resourceSize(ctx, mustGetResource(ctx, resource.id), getSize)
  assert.equal(runningSize, 98765)
  assert.equal(calls, 1)

  ctx.store.setResourceState(resource.id, 'sleeping')
  const sleepingSize = await resourceSize(ctx, mustGetResource(ctx, resource.id), getSize)
  assert.equal(sleepingSize, 98765, 'a sleeping resource must report its last known size')
  assert.equal(calls, 1, 'the cached read must never call getSize again')
  ctx.store.close()
})

test('resourceSize: a running resource whose size query fails falls back to the last known size', async () => {
  const ctx = buildContext()
  const project = ctx.store.createProject({ name: 'blog', sleepAfterSeconds: 300 })
  const resource = ctx.store.createResource({ projectId: project.id, kind: 'postgres', name: 'primary', config: samplePostgresConfig() })
  ctx.store.setResourceState(resource.id, 'running')

  let succeed = true
  const getSize = async (): Promise<number | null> => (succeed ? 5555 : null)

  const first = await resourceSize(ctx, mustGetResource(ctx, resource.id), getSize)
  assert.equal(first, 5555)

  succeed = false
  const second = await resourceSize(ctx, mustGetResource(ctx, resource.id), getSize)
  assert.equal(second, 5555, 'a failed query on a running resource still falls back to the cached figure')
  ctx.store.close()
})

test('resourceSize: caches are isolated per DaemonContext', async () => {
  const ctxA = buildContext()
  const ctxB = buildContext()
  const projectA = ctxA.store.createProject({ name: 'blog', sleepAfterSeconds: 300 })
  const resourceA = ctxA.store.createResource({ projectId: projectA.id, kind: 'postgres', name: 'primary', config: samplePostgresConfig() })
  ctxA.store.setResourceState(resourceA.id, 'running')

  await resourceSize(ctxA, mustGetResource(ctxA, resourceA.id), async () => 111)

  const projectB = ctxB.store.createProject({ name: 'blog', sleepAfterSeconds: 300 })
  const resourceB = ctxB.store.createResource({
    projectId: projectB.id,
    kind: 'postgres',
    name: 'primary',
    config: samplePostgresConfig({ hostPort: 25596 }),
  })
  ctxB.store.setResourceState(resourceB.id, 'sleeping')

  const sizeB = await resourceSize(ctxB, mustGetResource(ctxB, resourceB.id), async () => {
    throw new Error('must not be called: resourceB is sleeping and has no cache entry of its own')
  })
  assert.equal(sizeB, null, "ctxB must not see ctxA's cached size")

  ctxA.store.close()
  ctxB.store.close()
})
