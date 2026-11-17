// The daemon's side of copying and removing container-owned trees
// (packages/cli/src/daemon/tree-ops.ts): which images the root-container
// fallback may use, and that project removal and snapshots actually reach
// the fallback when the native operation is refused. The refusals are real
// (chmod), standing in for a PGDATA owned by the postgres image's uid on
// Linux; the fallback is injected through DaemonContext.elevatedTreeOps, so
// no Docker runs. root ignores directory modes, so those cases skip as root.

import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { chmod, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import {
  cloneTree,
  createFakeRuntime,
  openStore,
  resolvePaths,
  type ElevatedTreeOps,
  type HobbyConfig,
  type PostgresConfig,
} from '@hobby.sh/core'
import { ActivityTracker } from '@hobby.sh/proxy'
import { NODE_IMAGE } from '@hobby.sh/worker'
import { CADDY_IMAGE } from '../src/daemon/caddy.js'
import { createDefaultKindRegistry, type DaemonContext } from '../src/daemon/context.js'
import { deleteProject } from '../src/daemon/routes.js'
import { snapshotDir, takeSnapshot } from '../src/daemon/snapshots.js'
import { fallbackImages } from '../src/daemon/tree-ops.js'

const asRoot = typeof process.getuid === 'function' && process.getuid() === 0

const homes: string[] = []
const locked: string[] = []
async function unlockAll(): Promise<void> {
  for (const dir of locked) {
    await chmod(dir, 0o755).catch(() => undefined)
  }
}
after(async () => {
  await unlockAll()
  for (const home of homes) {
    await rm(home, { recursive: true, force: true })
  }
})

function testConfig(): HobbyConfig {
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
    wakeTimeoutMs: 150,
    readinessPollMs: 20,
    queuePort: 0,
    caddyEnabled: false,
    caddyAdminPort: 2019,
    caddyStudioHost: null,
    project: null,
  }
}

interface Recorder {
  images: string[][]
  clones: Array<[string, string]>
  removes: string[]
}

// Unlocks what the test locked, then does the operation natively: the
// stand-in for a root container, which is not refused.
function buildContext(): { ctx: DaemonContext; seen: Recorder } {
  const home = join(tmpdir(), `hobby-tree-ops-${randomUUID()}`)
  homes.push(home)
  const seen: Recorder = { images: [], clones: [], removes: [] }
  const ctx: DaemonContext = {
    store: openStore(':memory:'),
    runtime: createFakeRuntime(),
    paths: resolvePaths({ HOBBY_HOME: home }),
    config: testConfig(),
    activity: new ActivityTracker(),
    kinds: createDefaultKindRegistry(),
    elevatedTreeOps: (images): ElevatedTreeOps => {
      seen.images.push(images)
      return {
        async clone(src, dst) {
          seen.clones.push([src, dst])
          await unlockAll()
          return cloneTree(src, dst)
        },
        async remove(path) {
          seen.removes.push(path)
          await unlockAll()
          await rm(path, { recursive: true, force: true })
        },
      }
    },
  }
  return { ctx, seen }
}

function postgresConfig(ctx: DaemonContext, project: string, name: string, image = 'postgres:18-alpine'): PostgresConfig {
  return {
    image,
    containerName: `hobby-${project}-${name}`,
    hostPort: 15432,
    dataDir: ctx.paths.resourcePath(project, name, 'pgdata'),
    superuser: 'postgres',
    password: 'secret',
    database: 'app',
  }
}

test('fallback images: the resources\' own postgres images first, then theirs, then images that stay local', () => {
  const { ctx } = buildContext()
  const other = ctx.store.createProject({ name: 'other', sleepAfterSeconds: null })
  ctx.store.createResource({ projectId: other.id, kind: 'postgres', name: 'db', config: postgresConfig(ctx, 'other', 'db', 'postgres:16') })

  const images = fallbackImages(ctx, [
    { kind: 'worker', config: { image: 'hobby/blog-api:3' } },
    { kind: 'postgres', config: { image: 'postgres:17-alpine' } },
    { kind: 'app', config: { image: null } },
    { kind: 'queue', config: {} },
  ])

  assert.deepEqual(images, ['postgres:17-alpine', 'hobby/blog-api:3', 'postgres:18-alpine', 'postgres:16', CADDY_IMAGE, NODE_IMAGE])
})

test('hobby rm finishes a project directory the daemon is refused, through the fallback', { skip: asRoot }, async () => {
  const { ctx, seen } = buildContext()
  ctx.store.createProject({ name: 'blog', sleepAfterSeconds: null })
  // A worker's state directory after its container wrote a cache as root.
  const cache = join(ctx.paths.projectsDir, 'blog', 'consumer', 'state', 'cache', 'miniflare-CacheObject')
  await mkdir(cache, { recursive: true })
  await writeFile(join(cache, 'blob'), 'x')
  locked.push(cache)
  await chmod(cache, 0o555)

  await deleteProject(ctx, 'blog')

  assert.deepEqual(seen.removes, [join(ctx.paths.projectsDir, 'blog')])
  assert.deepEqual(await readdir(ctx.paths.projectsDir), [])
  assert.equal(ctx.store.getProjectByName('blog'), null)
  // Nothing in the project had an image, so the candidates are the ones
  // that outlive it.
  assert.deepEqual(seen.images, [['postgres:18-alpine', CADDY_IMAGE, NODE_IMAGE]])
})

test('hobby rm of a directory the daemon owns runs no fallback at all', async () => {
  const { ctx, seen } = buildContext()
  ctx.store.createProject({ name: 'blog', sleepAfterSeconds: null })
  await mkdir(join(ctx.paths.projectsDir, 'blog', 'consumer', 'state'), { recursive: true })

  await deleteProject(ctx, 'blog')

  assert.deepEqual(seen, { images: [], clones: [], removes: [] })
})

test('a snapshot of an unreadable PGDATA is taken through the fallback with the resource\'s image', { skip: asRoot }, async () => {
  const { ctx, seen } = buildContext()
  const project = ctx.store.createProject({ name: 'blog', sleepAfterSeconds: null })
  const resource = ctx.store.createResource({
    projectId: project.id,
    kind: 'postgres',
    name: 'primary',
    config: postgresConfig(ctx, 'blog', 'primary', 'postgres:17-alpine'),
  })
  ctx.store.setResourceState(resource.id, 'sleeping')
  const docker = join(ctx.paths.resourcePath('blog', 'primary', 'pgdata'), '18', 'docker')
  await mkdir(docker, { recursive: true })
  await writeFile(join(docker, 'PG_VERSION'), '18\n')
  locked.push(docker)
  await chmod(docker, 0o000)

  const manifest = await takeSnapshot(ctx, 'blog', { now: () => Date.UTC(2026, 10, 17), suffix: () => 'aaaaaa' })

  const dir = snapshotDir(ctx.paths, 'blog', manifest.snapshotId)
  assert.deepEqual(seen.clones, [[join(ctx.paths.projectsDir, 'blog'), join(`${dir}.partial`, 'data')]])
  assert.equal(seen.images[0]?.[0], 'postgres:17-alpine')
  assert.equal(await readFile(join(dir, 'data', 'primary', 'pgdata', '18', 'docker', 'PG_VERSION'), 'utf8'), '18\n')
})
