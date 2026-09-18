// What the daemon stops on its way down. Before resourcesToStopOnShutdown
// existed, performShutdown (server.ts) stopped every `running` resource,
// pinned projects included, so each daemon restart (an upgrade, a systemd
// restart) took a pinned project's Postgres through a clean shutdown and a
// cold start on its next connection.

import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  createFakeRuntime,
  openStore,
  resolvePaths,
  type HobbyConfig,
  type KindRegistry,
  type PostgresConfig,
  type Resource,
  type ResourceKindHandler,
  type Store,
} from '@hobby.sh/core'
import { ActivityTracker } from '@hobby.sh/proxy'
import { createDefaultKindRegistry, resourcesToStopOnShutdown, startDaemon, type DaemonContext } from '../src/index.js'

// Mirrors caddy.test.ts's testConfig: HobbyConfig has no optional fields.
function testConfig(): HobbyConfig {
  return {
    image: 'postgres:18-alpine',
    proxyPort: 0,
    proxyHost: '127.0.0.1',
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
    project: null,
  }
}

function samplePostgresConfig(name: string): PostgresConfig {
  return {
    image: 'postgres:18-alpine',
    containerName: `hobby-${name}-primary-${randomUUID()}`,
    dataDir: `/home/user/.hobby/projects/${name}/primary/pgdata`,
    hostPort: 25557,
    superuser: 'postgres',
    password: 'secret',
    database: name,
  }
}

// A registry that behaves like the default one except that stop() records
// which resource it was asked to stop instead of touching a runtime.
function recordingKinds(stopped: string[]): KindRegistry {
  const real = createDefaultKindRegistry()
  return {
    has: (kind) => real.has(kind),
    kinds: () => real.kinds(),
    get: (kind) => {
      const handler = real.get(kind)
      return {
        ...handler,
        stop: async (_ctx: unknown, resource: Resource) => {
          stopped.push(resource.id)
        },
      } as ResourceKindHandler
    },
  }
}

function buildContext(kinds: KindRegistry = createDefaultKindRegistry()): DaemonContext {
  const store: Store = openStore(':memory:')
  const paths = resolvePaths({ HOBBY_HOME: join(tmpdir(), `hobby-shutdown-test-${randomUUID()}`) })
  return { store, runtime: createFakeRuntime(), paths, config: testConfig(), activity: new ActivityTracker(), kinds }
}

// One pinned project and one that sleeps, each with a running Postgres, plus
// a sleeping resource in the project that sleeps.
function seed(ctx: DaemonContext): { pinned: Resource; sleepy: Resource; asleep: Resource } {
  const prod = ctx.store.createProject({ name: 'prod', sleepAfterSeconds: null })
  const blog = ctx.store.createProject({ name: 'blog', sleepAfterSeconds: 300 })
  const pinned = ctx.store.createResource({ projectId: prod.id, kind: 'postgres', name: 'primary', config: samplePostgresConfig('prod') })
  const sleepy = ctx.store.createResource({ projectId: blog.id, kind: 'postgres', name: 'primary', config: samplePostgresConfig('blog') })
  const asleep = ctx.store.createResource({ projectId: blog.id, kind: 'postgres', name: 'replica', config: samplePostgresConfig('blog2') })
  ctx.store.setResourceState(pinned.id, 'running')
  ctx.store.setResourceState(sleepy.id, 'running')
  ctx.store.setResourceState(asleep.id, 'sleeping')
  return { pinned, sleepy, asleep }
}

test('a pinned project is left running; a running resource that can sleep is stopped', () => {
  const ctx = buildContext()
  const { pinned, sleepy, asleep } = seed(ctx)
  try {
    const ids = resourcesToStopOnShutdown(ctx).map((resource) => resource.id)
    assert.deepEqual(ids, [sleepy.id])
    assert.ok(!ids.includes(pinned.id))
    assert.ok(!ids.includes(asleep.id))
  } finally {
    ctx.store.close()
  }
})

test('unpinning a project puts it back on the shutdown list', () => {
  const ctx = buildContext()
  const { pinned } = seed(ctx)
  try {
    ctx.store.setProjectSleepAfterSeconds(pinned.projectId, 600)
    assert.ok(resourcesToStopOnShutdown(ctx).some((resource) => resource.id === pinned.id))
  } finally {
    ctx.store.close()
  }
})

// Through the real performShutdown, not just the selector: this is what fails
// if the loop in server.ts ever goes back to filtering on state alone.
test('daemon close() stops the sleepy project and never calls stop on the pinned one', async () => {
  const stopped: string[] = []
  const ctx = buildContext(recordingKinds(stopped))
  const { pinned, sleepy } = seed(ctx)
  // Kept short: unix socket paths are capped well under 104 bytes on macOS.
  const socketPath = join(mkdtempSync(join(tmpdir(), 'hobby-sd-')), 'd.sock')

  const daemon = await startDaemon(ctx, { socketPath, apiPort: null })
  try {
    await daemon.close()
    assert.deepEqual(stopped, [sleepy.id])
    assert.equal(ctx.store.getResource(pinned.id)?.state, 'running')
  } finally {
    ctx.store.close()
  }
})
