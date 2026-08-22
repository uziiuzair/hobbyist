import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { rmSync } from 'node:fs'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import {
  createFakeRuntime,
  HobbyError,
  openStore,
  resolvePaths,
  validateName,
  type ActivityGuardResult,
  type HobbyConfig,
  type PostgresConfig,
  type Resource,
  type Store,
} from '@hobby.sh/core'
import { ActivityTracker } from '@hobby.sh/proxy'
import { createDefaultKindRegistry, type DaemonContext } from '../src/daemon/context.js'
import {
  deleteSnapshot,
  findSnapshot,
  listSnapshots,
  projectSnapshotsDir,
  quiesce,
  resume,
  snapshotDir,
  snapshotId,
  takeSnapshot,
  verifyProjectName,
} from '../src/daemon/snapshots.js'

test('snapshotId is lowercase, sortable, and safe inside a project name', () => {
  const id = snapshotId(Date.UTC(2026, 7, 16, 14, 30, 0), 'a1b2c3')
  assert.equal(id, '20260816t143000z-a1b2c3')
  assert.equal(id, id.toLowerCase())
  // The whole reason for lowercase: verify names are built from this.
  assert.doesNotThrow(() => validateName(verifyProjectName(id)))
})

test('snapshotIds sort chronologically as strings', () => {
  const earlier = snapshotId(Date.UTC(2026, 7, 16, 9, 0, 0), 'aaaaaa')
  const later = snapshotId(Date.UTC(2026, 7, 16, 14, 0, 0), 'aaaaaa')
  assert.equal([later, earlier].sort()[0], earlier)
})

test('verify project names stay inside the 63 character limit', () => {
  const id = snapshotId(Date.UTC(2026, 7, 16, 14, 30, 0), 'a1b2c3')
  assert.equal(verifyProjectName(id), 'verify-a1b2c3')
  assert.ok(verifyProjectName(id).length <= 63)
})

test('snapshot paths hang off the hobby home, not the project directory', () => {
  const paths = resolvePaths({ HOBBY_HOME: '/tmp/hobby-test-home' })
  assert.equal(projectSnapshotsDir(paths, 'blog'), '/tmp/hobby-test-home/snapshots/blog')
  assert.equal(snapshotDir(paths, 'blog', '20260816t143000z-a1b2c3'), '/tmp/hobby-test-home/snapshots/blog/20260816t143000z-a1b2c3')
})

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
  proxyHost: '127.0.0.1',
    studioPort: 8443,
    apiPort: 7432,
    httpPort: 7433,
    domain: 'localhost',
    sleepAfterSeconds: 300,
    wakeTimeoutMs: 150,
    readinessPollMs: 20,
    // 0 means "do not bind". The snapshots tests never enqueue, and this
    // branch predates queuePort becoming required, so the field arrives here
    // by way of the merge rather than because these tests want a broker.
    queuePort: 0,
    caddyEnabled: false,
    caddyAdminPort: 2019,
    caddyStudioHost: null,
  }
}

function buildContext(): DaemonContext {
  const home = join(tmpdir(), `hobby-snapshots-${randomUUID()}`)
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

function postgresConfig(name: string): PostgresConfig {
  return {
    image: 'postgres:18-alpine',
    containerName: `hobby-test-${name}`,
    hostPort: 15432,
    dataDir: `/tmp/hobby-test/${name}/pgdata`,
    superuser: 'postgres',
    password: 'secret',
    database: 'app',
  }
}

test('quiesce stops running resources and reports them', async () => {
  const ctx = buildContext()
  const project = ctx.store.createProject({ name: 'blog', sleepAfterSeconds: null })
  const running = ctx.store.createResource({
    projectId: project.id,
    kind: 'postgres',
    name: 'primary',
    config: postgresConfig('primary'),
  })
  ctx.store.setResourceState(running.id, 'running')

  const stopped = await quiesce(ctx, project, { guard: async () => 'idle' })

  assert.deepEqual(stopped, [running.id])
})

test('quiesce leaves an already sleeping resource alone', async () => {
  const ctx = buildContext()
  const project = ctx.store.createProject({ name: 'blog', sleepAfterSeconds: null })
  const asleep = ctx.store.createResource({
    projectId: project.id,
    kind: 'postgres',
    name: 'primary',
    config: postgresConfig('primary'),
  })
  ctx.store.setResourceState(asleep.id, 'sleeping')

  const stopped = await quiesce(ctx, project, { guard: async () => 'idle' })

  assert.deepEqual(stopped, [])
  assert.equal(ctx.store.getResource(asleep.id)?.state, 'sleeping')
})

test('quiesce refuses when the guard cannot answer', async () => {
  const ctx = buildContext()
  const project = ctx.store.createProject({ name: 'blog', sleepAfterSeconds: null })
  const running = ctx.store.createResource({
    projectId: project.id,
    kind: 'postgres',
    name: 'primary',
    config: postgresConfig('primary'),
  })
  ctx.store.setResourceState(running.id, 'running')

  await assert.rejects(
    quiesce(ctx, project, { guard: async () => 'unreachable' }),
    /could not confirm/
  )
  // And it must not have stopped anything on its way to failing.
  assert.equal(ctx.store.getResource(running.id)?.state, 'running')
})

test('quiesce retries an active resource, then fails rather than snapshotting it', async () => {
  const ctx = buildContext()
  const project = ctx.store.createProject({ name: 'blog', sleepAfterSeconds: null })
  const running = ctx.store.createResource({
    projectId: project.id,
    kind: 'postgres',
    name: 'primary',
    config: postgresConfig('primary'),
  })
  ctx.store.setResourceState(running.id, 'running')

  let calls = 0
  const guard = async (): Promise<ActivityGuardResult> => {
    calls += 1
    return 'active'
  }

  await assert.rejects(
    quiesce(ctx, project, { guard, attempts: 3, waitMs: 1, sleepFor: async () => {} }),
    /still active/
  )
  assert.equal(calls, 3)
})

test('quiesce proceeds when a retry finds the resource gone idle', async () => {
  const ctx = buildContext()
  const project = ctx.store.createProject({ name: 'blog', sleepAfterSeconds: null })
  const running = ctx.store.createResource({
    projectId: project.id,
    kind: 'postgres',
    name: 'primary',
    config: postgresConfig('primary'),
  })
  ctx.store.setResourceState(running.id, 'running')

  let calls = 0
  const guard = async (): Promise<ActivityGuardResult> => {
    calls += 1
    return calls === 1 ? 'active' : 'idle'
  }

  const stopped = await quiesce(ctx, project, { guard, attempts: 3, waitMs: 1, sleepFor: async () => {} })
  assert.deepEqual(stopped, [running.id])
})

test('takeSnapshot clones the project directory and writes a manifest', async () => {
  const ctx = buildContext()
  const project = ctx.store.createProject({ name: 'blog', sleepAfterSeconds: 900 })
  const resource = ctx.store.createResource({
    projectId: project.id,
    kind: 'postgres',
    name: 'primary',
    config: postgresConfig('primary'),
  })
  ctx.store.setResourceState(resource.id, 'sleeping')

  // A stand-in for a PGDATA: what matters here is that the bytes travel.
  await mkdir(ctx.paths.resourcePath('blog', 'primary', 'pgdata'), { recursive: true })
  await writeFile(join(ctx.paths.resourcePath('blog', 'primary', 'pgdata'), 'PG_VERSION'), '18\n', 'utf8')

  const manifest = await takeSnapshot(ctx, 'blog', {
    now: () => Date.UTC(2026, 7, 16, 14, 30, 0),
    suffix: () => 'a1b2c3',
  })

  assert.equal(manifest.snapshotId, '20260816t143000z-a1b2c3')
  assert.equal(manifest.project.name, 'blog')
  assert.equal(manifest.project.sleepAfterSeconds, 900)
  assert.equal(manifest.resources.length, 1)
  assert.equal(manifest.resources[0]?.name, 'primary')
  assert.equal(manifest.resources[0]?.stateAtSnapshot, 'sleeping')
  assert.equal(manifest.verification.status, 'unverified')

  const dir = snapshotDir(ctx.paths, 'blog', manifest.snapshotId)
  assert.equal(await readFile(join(dir, 'data', 'primary', 'pgdata', 'PG_VERSION'), 'utf8'), '18\n')
  const written: unknown = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8'))
  assert.deepEqual(written, manifest)
})

test('takeSnapshot restarts what it stopped', async () => {
  const ctx = buildContext()
  const project = ctx.store.createProject({ name: 'blog', sleepAfterSeconds: null })
  const resource = ctx.store.createResource({
    projectId: project.id,
    kind: 'postgres',
    name: 'primary',
    config: postgresConfig('primary'),
  })
  ctx.store.setResourceState(resource.id, 'running')
  await mkdir(ctx.paths.resourcePath('blog', 'primary', 'pgdata'), { recursive: true })
  // Against the fake runtime nothing is actually listening, so the real
  // readiness probe would time out and land the resource on `failed`. The
  // seam this daemon already ships for exactly that case is
  // DaemonContext.probeFactory (packages/cli/src/daemon/context.ts:67),
  // used the same way by hibernator.test.ts:558 and routes.test.ts:989.
  ctx.probeFactory = () => async (): Promise<boolean> => true

  await takeSnapshot(ctx, 'blog', {
    now: () => Date.UTC(2026, 7, 16, 14, 30, 0),
    suffix: () => 'a1b2c3',
    quiesce: { guard: async () => 'idle' },
  })

  assert.equal(ctx.store.getResource(resource.id)?.state, 'running')
})

test('takeSnapshot restarts a resource quiesce already stopped, even when a later stop throws', async () => {
  const ctx = buildContext()
  const project = ctx.store.createProject({ name: 'blog', sleepAfterSeconds: null })
  const a = ctx.store.createResource({
    projectId: project.id,
    kind: 'postgres',
    name: 'primary',
    config: postgresConfig('primary'),
  })
  const b = ctx.store.createResource({
    projectId: project.id,
    kind: 'postgres',
    name: 'replica',
    config: postgresConfig('replica'),
  })
  ctx.store.setResourceState(a.id, 'running')
  ctx.store.setResourceState(b.id, 'running')
  await mkdir(ctx.paths.resourcePath('blog', 'primary', 'pgdata'), { recursive: true })
  await mkdir(ctx.paths.resourcePath('blog', 'replica', 'pgdata'), { recursive: true })
  ctx.probeFactory = () => async (): Promise<boolean> => true

  // quiesce stops resources in the store's own listing order (its `running`
  // array, packages/cli/src/daemon/snapshots.ts:133), so read that order
  // here rather than assume it, and fail the second one to stop, whichever
  // resource that turns out to be.
  const [first, second] = ctx.store.listResources(project.id)
  assert.ok(first !== undefined && second !== undefined)

  const realStop = ctx.runtime.stop
  ctx.runtime.stop = async (name: string, opts: { timeoutSec: number }): Promise<void> => {
    if (name === second.config.containerName) {
      throw new HobbyError('runtime_unavailable', 'docker stop timed out')
    }
    return realStop(name, opts)
  }

  await assert.rejects(
    takeSnapshot(ctx, 'blog', {
      now: () => Date.UTC(2026, 7, 16, 14, 30, 0),
      suffix: () => 'a1b2c3',
      quiesce: { guard: async () => 'idle' },
    })
  )

  // The first resource's stop genuinely succeeded before the second one
  // threw. It must come back up anyway: a failed snapshot that leaves it
  // stopped is worse than the failed snapshot itself.
  assert.equal(ctx.store.getResource(first.id)?.state, 'running')
})

test('takeSnapshot leaves nothing listable when the clone fails', async () => {
  const ctx = buildContext()
  ctx.store.createProject({ name: 'blog', sleepAfterSeconds: null })
  // No project directory on disk at all, so the clone throws.

  await assert.rejects(
    takeSnapshot(ctx, 'blog', { now: () => Date.UTC(2026, 7, 16, 14, 30, 0), suffix: () => 'a1b2c3' })
  )

  await assert.rejects(stat(snapshotDir(ctx.paths, 'blog', '20260816t143000z-a1b2c3')))
})

async function seedProject(ctx: DaemonContext, name: string): Promise<void> {
  ctx.store.createProject({ name, sleepAfterSeconds: null })
  await mkdir(ctx.paths.resourcePath(name, 'primary', 'pgdata'), { recursive: true })
}

test('listSnapshots returns newest first and skips partials', async () => {
  const ctx = buildContext()
  await seedProject(ctx, 'blog')

  await takeSnapshot(ctx, 'blog', { now: () => Date.UTC(2026, 7, 16, 9, 0, 0), suffix: () => 'aaaaaa' })
  await takeSnapshot(ctx, 'blog', { now: () => Date.UTC(2026, 7, 16, 14, 0, 0), suffix: () => 'bbbbbb' })
  await mkdir(join(projectSnapshotsDir(ctx.paths, 'blog'), '20260816t150000z-cccccc.partial'), { recursive: true })

  const listed = await listSnapshots(ctx, 'blog')

  assert.deepEqual(
    listed.map((manifest) => manifest.snapshotId),
    ['20260816t140000z-bbbbbb', '20260816t090000z-aaaaaa']
  )
})

test('findSnapshot resolves an id without being told the project', async () => {
  const ctx = buildContext()
  await seedProject(ctx, 'blog')
  const taken = await takeSnapshot(ctx, 'blog', { now: () => Date.UTC(2026, 7, 16, 9, 0, 0), suffix: () => 'aaaaaa' })

  const found = await findSnapshot(ctx, taken.snapshotId)

  assert.equal(found?.project, 'blog')
  assert.equal(found?.manifest.snapshotId, taken.snapshotId)
})

test('findSnapshot returns null for an id that does not exist', async () => {
  const ctx = buildContext()
  assert.equal(await findSnapshot(ctx, '20260816t090000z-zzzzzz'), null)
})

test('deleteSnapshot removes the directory', async () => {
  const ctx = buildContext()
  await seedProject(ctx, 'blog')
  const taken = await takeSnapshot(ctx, 'blog', { now: () => Date.UTC(2026, 7, 16, 9, 0, 0), suffix: () => 'aaaaaa' })

  await deleteSnapshot(ctx, taken.snapshotId)

  assert.equal(await findSnapshot(ctx, taken.snapshotId), null)
})
