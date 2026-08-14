// Which namespaces the alarm mirror is handed each tick.
//
// The mirror itself is tested in @hobby.sh/do against a temp directory. What
// is tested here is the join to the store, and specifically its three
// exclusions, because each one is a wake that would otherwise happen and be
// wrong.

import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import {
  createFakeRuntime,
  openStore,
  resolvePaths,
  type HobbyConfig,
  type Resource,
  type ResourceState,
  type Store,
  type WorkerConfig,
} from '@hobby.sh/core'
import { ActivityTracker } from '@hobby.sh/proxy'
import { durableObjectNamespaces } from '../src/daemon/alarms.js'
import { createDefaultKindRegistry, type DaemonContext } from '../src/daemon/context.js'

const homes: string[] = []
after(() => {
  for (const home of homes) {
    rmSync(home, { recursive: true, force: true })
  }
})

function testConfig(): HobbyConfig {
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
  }
}

function buildContext(): DaemonContext {
  const home = join(tmpdir(), `hobby-alarm-ns-${randomUUID()}`)
  homes.push(home)
  const store: Store = openStore(':memory:')
  return {
    store,
    runtime: createFakeRuntime(),
    paths: resolvePaths({ HOBBY_HOME: home }),
    config: testConfig(),
    activity: new ActivityTracker(),
    kinds: createDefaultKindRegistry(),
  }
}

function workerConfig(): WorkerConfig {
  return {
    image: 'hobby/api-worker:1',
    containerName: 'hobby-chat-api',
    hostPort: 35433,
    controlPort: 35434,
    queueToken: 'test-queue-token',
    containerPort: 8787,
    hostname: 'api.chat.localhost',
    durableObjectUniqueKeyModifier: 'unused-here',
    databaseResourceId: null,
    manifest: {
      source: { path: '/code/api', manifest: 'wrangler.toml' },
      compatibilityDate: '2026-08-01',
      compatibilityFlags: [],
      vars: {},
      kvNamespaces: [],
      r2Buckets: [],
      d1Databases: [],
      queues: { producers: [], consumers: [] },
      durableObjects: [{ binding: 'ROOM', className: 'Room' }],
    },
  }
}

// Creates the on-disk namespace directories a deployed worker would have, so
// the enumerator has something real to find. Their contents do not matter:
// this function answers "which directories", not "what is scheduled".
function seedWorker(
  ctx: DaemonContext,
  opts: { project?: string; name?: string; state?: ResourceState; released?: boolean; classes?: string[] } = {}
): Resource {
  const projectName = opts.project ?? 'chat'
  const existing = ctx.store.listProjects().find((candidate) => candidate.name === projectName)
  const project = existing ?? ctx.store.createProject({ name: projectName, sleepAfterSeconds: 300 })

  const resource = ctx.store.createResource({
    projectId: project.id,
    kind: 'worker',
    name: opts.name ?? 'api',
    config: workerConfig(),
  })
  ctx.store.setResourceState(resource.id, opts.state ?? 'sleeping')

  for (const className of opts.classes ?? ['Room']) {
    mkdirSync(join(ctx.paths.resourcePath(project.name, resource.name, 'do'), `${resource.id}-${className}`), {
      recursive: true,
    })
  }

  if (opts.released === true) {
    ctx.store.setProjectReleased(project.id, new Date())
  }

  return resource
}

test('a sleeping worker contributes one entry per namespace directory', () => {
  const ctx = buildContext()
  try {
    const resource = seedWorker(ctx, { classes: ['Room', 'Presence'] })
    const namespaces = durableObjectNamespaces(ctx)

    assert.equal(namespaces.length, 2)
    assert.deepEqual(new Set(namespaces.map((entry) => entry.resourceId)), new Set([resource.id]))
    assert.deepEqual(
      namespaces.map((entry) => entry.namespaceDir.split('/').pop()).sort(),
      [`${resource.id}-Presence`, `${resource.id}-Room`].sort()
    )
  } finally {
    ctx.store.close()
  }
})

// A live workerd holds its own timer and fires its own alarms, deleting each
// row as it goes. Waking a running resource is a harmless no-op, but it is one
// repeated every tick for every alarm a busy worker has pending.
test('a running worker is skipped, because it can fire its own alarms', () => {
  const ctx = buildContext()
  try {
    seedWorker(ctx, { state: 'running' })
    assert.deepEqual(durableObjectNamespaces(ctx), [])
  } finally {
    ctx.store.close()
  }
})

test('a starting worker is skipped too', () => {
  const ctx = buildContext()
  try {
    seedWorker(ctx, { state: 'starting' })
    assert.deepEqual(durableObjectNamespaces(ctx), [])
  } finally {
    ctx.store.close()
  }
})

// The rule the hibernator already applies, for the same reason: `hobby eject
// --release` handed this project's data to the user's own compose stack, and
// waking it would start a container hobby no longer owns.
test('a released project is skipped', () => {
  const ctx = buildContext()
  try {
    seedWorker(ctx, { released: true })
    assert.deepEqual(durableObjectNamespaces(ctx), [])
  } finally {
    ctx.store.close()
  }
})

test('postgres resources contribute nothing, having no alarms', () => {
  const ctx = buildContext()
  try {
    const project = ctx.store.createProject({ name: 'blog', sleepAfterSeconds: 300 })
    ctx.store.createResource({
      projectId: project.id,
      kind: 'postgres',
      name: 'primary',
      config: {
        image: 'postgres:18-alpine',
        containerName: 'hobby-blog-primary',
        hostPort: 15432,
        dataDir: join(ctx.paths.projectsDir, 'blog', 'primary', 'pgdata'),
        superuser: 'postgres',
        password: 'secret',
        database: 'blog',
      },
    })

    assert.deepEqual(durableObjectNamespaces(ctx), [])
  } finally {
    ctx.store.close()
  }
})

test('a worker that has never been deployed has no directories and contributes nothing', () => {
  const ctx = buildContext()
  try {
    seedWorker(ctx, { classes: [] })
    assert.deepEqual(durableObjectNamespaces(ctx), [])
  } finally {
    ctx.store.close()
  }
})
