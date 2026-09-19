// `hobby snapshot --online` (takeOnlineSnapshot, packages/cli/src/daemon/snapshots.ts,
// and basebackupPostgres, packages/cli/src/daemon/basebackup.ts), against the
// fake runtime with no Docker. The fake's execStream is handed a real tar,
// built byte by byte below, and the system tar unpacks it into a real
// HOBBY_HOME, so the layout restore depends on is checked on disk rather
// than assumed.
//
// What these pin, in the order of the risks: nothing is ever stopped or
// fenced; pg_basebackup is asked for exactly what basebackup.ts documents;
// a failure of any kind, including a stream that ends early with every
// process reporting success, leaves nothing in snapshots/; the hibernator
// cannot sleep a database mid-backup; the mutual exclusion with every other
// snapshot and restore still holds; and the result restores through the
// existing restore paths untouched.

import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { rmSync } from 'node:fs'
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { after, test } from 'node:test'
import {
  createFakeRuntime,
  createKindRegistry,
  openStore,
  resolvePaths,
  resolvePgdataPath,
  type FakeExecCall,
  type FakeExecResult,
  type HobbyConfig,
  type PostgresConfig,
  type PostgresResource,
  type Project,
  type Resource,
  type ResourceKindHandler,
} from '@hobby.sh/core'
import { appKindHandler } from '@hobby.sh/app'
import { postgresKindHandler } from '@hobby.sh/pg'
import { ActivityTracker } from '@hobby.sh/proxy'
import { queueKindHandler } from '@hobby.sh/queue'
import { workerKindHandler } from '@hobby.sh/worker'
import { basebackupCommand, unpackExecTar } from '../src/daemon/basebackup.js'
import { getOrCreateWake, holdProjectAsleep, waitForProjectAwakeable } from '../src/daemon/context.js'
import { startHibernator } from '../src/daemon/hibernator.js'
import { createQueueResource } from '../src/daemon/routes.js'
import {
  findSnapshot,
  listSnapshots,
  projectSnapshotsDir,
  restoreSnapshot,
  takeOnlineSnapshot,
  takeSnapshot,
} from '../src/daemon/snapshots.js'
import { createApp, type DaemonContext } from '../src/index.js'

const homes: string[] = []
after(() => {
  for (const home of homes) {
    rmSync(home, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// A minimal ustar writer. Enough for files and directories, which is all a
// pg_basebackup base archive holds for a cluster with no tablespaces, and
// small enough that a test can cut the result wherever it likes.
// ---------------------------------------------------------------------------

function octal(value: number, width: number): string {
  return `${value.toString(8).padStart(width - 1, '0')}\0`
}

function tarHeader(name: string, size: number, type: '0' | '5', mode: number): Buffer {
  const header = Buffer.alloc(512)
  header.write(name, 0, 100, 'utf8')
  header.write(octal(mode, 8), 100)
  header.write(octal(0, 8), 108)
  header.write(octal(0, 8), 116)
  header.write(octal(size, 12), 124)
  header.write(octal(1758283200, 12), 136)
  header.write('        ', 148)
  header.write(type, 156)
  header.write('ustar\0', 257)
  header.write('00', 263)
  let sum = 0
  for (const byte of header) {
    sum += byte
  }
  header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148)
  return header
}

interface TarEntry {
  name: string
  content?: string
}

function tarOf(entries: TarEntry[], opts: { endMarker?: boolean } = {}): Buffer {
  const blocks: Buffer[] = []
  for (const entry of entries) {
    if (entry.content === undefined) {
      blocks.push(tarHeader(entry.name, 0, '5', 0o700))
      continue
    }
    const body = Buffer.from(entry.content, 'utf8')
    blocks.push(tarHeader(entry.name, body.length, '0', 0o600))
    const padded = Buffer.alloc(Math.ceil(body.length / 512) * 512)
    body.copy(padded)
    blocks.push(padded)
  }
  if (opts.endMarker !== false) {
    blocks.push(Buffer.alloc(1024))
  }
  return Buffer.concat(blocks)
}

// Shaped like pg_basebackup's base archive: backup_label first, pg_control
// last among the data files, then the fetched WAL. `row` stands in for a
// table's contents, the way snapshot-routes.test.ts's PGDATA does.
function basebackupEntries(row: string): TarEntry[] {
  return [
    { name: 'backup_label', content: 'START WAL LOCATION: 0/2000028 (file 000000010000000000000002)\nLABEL: test\n' },
    { name: 'PG_VERSION', content: '18\n' },
    { name: 'row', content: row },
    { name: 'global/' },
    { name: 'global/pg_control', content: 'control' },
    { name: 'pg_wal/' },
    { name: 'pg_wal/000000010000000000000002', content: 'wal' },
  ]
}

function basebackupTar(row: string): Buffer {
  return tarOf(basebackupEntries(row))
}

// ---------------------------------------------------------------------------
// Context, same shape as snapshot-routes.test.ts's.
// ---------------------------------------------------------------------------

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
    project: null,
  }
}

type FakeRuntime = ReturnType<typeof createFakeRuntime>

interface Counts {
  stops: number
  starts: number
}

function buildContext(): { ctx: DaemonContext; runtime: FakeRuntime; counts: Counts } {
  const home = join(tmpdir(), `hobby-snapshot-online-${randomUUID()}`)
  homes.push(home)
  const runtime = createFakeRuntime()
  const counts: Counts = { stops: 0, starts: 0 }
  // The real handler's start and stop, counted: "never stops anything" is
  // the claim, so every stop is visible. The guard is `idle` for the same
  // reason snapshot-routes.test.ts gives: the real one is a pg_stat_activity
  // query that can only answer `unreachable` against the fake runtime.
  const counting: ResourceKindHandler<PostgresResource> = {
    ...postgresKindHandler,
    guard: async () => 'idle',
    async stop(kctx, resource) {
      counts.stops += 1
      await postgresKindHandler.stop(kctx, resource)
    },
    async start(kctx, resource) {
      counts.starts += 1
      await postgresKindHandler.start(kctx, resource)
    },
  }
  const ctx: DaemonContext = {
    store: openStore(':memory:'),
    runtime,
    paths: resolvePaths({ HOBBY_HOME: home }),
    config: testConfig(),
    activity: new ActivityTracker(),
    kinds: createKindRegistry([counting, appKindHandler, workerKindHandler, queueKindHandler]),
    probeFactory: () => async (): Promise<boolean> => true,
  }
  return { ctx, runtime, counts }
}

function postgresConfig(ctx: DaemonContext, project: string, name: string): PostgresConfig {
  return {
    image: 'postgres:18-alpine',
    containerName: `hobby-${project}-${name}`,
    hostPort: 15432,
    dataDir: ctx.paths.resourcePath(project, name, 'pgdata'),
    superuser: 'app_owner',
    password: 'the-real-password',
    database: 'app',
  }
}

// A project of postgres resources. A running one has a running fake
// container (execStream refuses anything else, as docker exec does) and a
// live PGDATA the snapshot must NOT read; a sleeping one has a PGDATA at
// rest the snapshot must clone.
async function seed(
  ctx: DaemonContext,
  runtime: FakeRuntime,
  opts: { name?: string; pinned?: boolean; resources: Array<{ name: string; state: Resource['state']; row: string }> }
): Promise<{ project: Project; resources: Resource[] }> {
  const name = opts.name ?? 'blog'
  const project = ctx.store.createProject({ name, sleepAfterSeconds: opts.pinned === true ? null : 300 })
  const resources: Resource[] = []
  for (const spec of opts.resources) {
    const config = postgresConfig(ctx, name, spec.name)
    const resource = ctx.store.createResource({ projectId: project.id, kind: 'postgres', name: spec.name, config })
    ctx.store.setResourceState(resource.id, spec.state)
    await runtime.ensureCreated({ name: config.containerName, image: config.image, env: {}, ports: [], binds: [] })
    if (spec.state === 'running') {
      await runtime.start(config.containerName)
    }
    const pgdata = resolvePgdataPath(config.dataDir)
    await mkdir(pgdata, { recursive: true })
    await writeFile(join(pgdata, 'row'), spec.row, 'utf8')
    resources.push(resource)
  }
  return { project, resources }
}

function snapshotPgdata(dir: string, resource: string): string {
  return resolvePgdataPath(join(dir, 'data', resource, 'pgdata'))
}

async function snapshotsOnDisk(ctx: DaemonContext, project: string): Promise<string[]> {
  try {
    return await readdir(projectSnapshotsDir(ctx.paths, project))
  } catch {
    return []
  }
}

async function until(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 500; i += 1) {
    if (condition()) {
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 2))
  }
  throw new Error('condition never became true')
}

function serve(handler: (call: FakeExecCall) => FakeExecResult): (call: FakeExecCall) => FakeExecResult {
  return handler
}

// ---------------------------------------------------------------------------
// The capture itself.
// ---------------------------------------------------------------------------

test('an online snapshot runs pg_basebackup in the container, stops nothing, and unpacks into the layout a clone would have', async () => {
  const { ctx, runtime, counts } = buildContext()
  const { resources } = await seed(ctx, runtime, { resources: [{ name: 'primary', state: 'running', row: 'live-bytes' }] })
  const primary = resources[0] as Resource
  runtime._exec.handler = serve(() => ({ stdout: basebackupTar('backed-up-row') }))

  const manifest = await takeOnlineSnapshot(ctx, 'blog', { suffix: () => 'aaaaaa' })

  assert.equal(runtime._exec.calls.length, 1)
  assert.deepEqual(runtime._exec.calls[0], {
    name: 'hobby-blog-primary',
    command: [
      'pg_basebackup',
      '--pgdata=-',
      '--format=tar',
      '--wal-method=fetch',
      '--checkpoint=fast',
      '--host=/var/run/postgresql',
      '--username=app_owner',
      '--no-password',
      `--label=hobby snapshot ${manifest.snapshotId}`,
    ],
  })
  assert.equal(counts.stops, 0)
  assert.equal(counts.starts, 0)
  assert.equal(ctx.store.getResource(primary.id)?.state, 'running')
  assert.equal((await runtime.inspect('hobby-blog-primary')).running, true)

  const found = await findSnapshot(ctx, manifest.snapshotId)
  assert.ok(found)
  const pgdata = snapshotPgdata(found.dir, 'primary')
  // The backup's bytes, not the live directory's: the live PGDATA of a
  // running database is exactly what must never be read.
  assert.equal(await readFile(join(pgdata, 'row'), 'utf8'), 'backed-up-row')
  assert.match(await readFile(join(pgdata, 'backup_label'), 'utf8'), /START WAL LOCATION/)
  assert.equal(await readFile(join(pgdata, 'pg_wal', '000000010000000000000002'), 'utf8'), 'wal')
  assert.equal((await stat(pgdata)).mode & 0o777, 0o700)
})

test('the manifest records how each resource was captured and the state it held', async () => {
  const { ctx, runtime } = buildContext()
  await seed(ctx, runtime, {
    resources: [
      { name: 'primary', state: 'running', row: 'live' },
      { name: 'archive', state: 'sleeping', row: 'at-rest' },
    ],
  })
  runtime._exec.handler = serve(() => ({ stdout: basebackupTar('backed-up') }))

  const manifest = await takeOnlineSnapshot(ctx, 'blog')

  const byName = Object.fromEntries(manifest.resources.map((entry) => [entry.name, entry]))
  assert.equal(byName['primary']?.method, 'basebackup')
  assert.equal(byName['primary']?.stateAtSnapshot, 'running')
  assert.equal(byName['archive']?.method, 'clone')
  assert.equal(byName['archive']?.stateAtSnapshot, 'sleeping')
  assert.equal(manifest.clone, 'copy')
  // And on disk, through the same reader restore uses.
  const found = await findSnapshot(ctx, manifest.snapshotId)
  assert.deepEqual(
    found?.manifest.resources.map((entry) => [entry.name, entry.method]),
    [
      ['primary', 'basebackup'],
      ['archive', 'clone'],
    ]
  )
})

test('a sleeping postgres is cloned, never exec-ed into', async () => {
  const { ctx, runtime, counts } = buildContext()
  await seed(ctx, runtime, { resources: [{ name: 'primary', state: 'sleeping', row: 'at-rest' }] })

  const manifest = await takeOnlineSnapshot(ctx, 'blog')

  assert.equal(runtime._exec.calls.length, 0)
  assert.equal(counts.starts + counts.stops, 0)
  assert.equal(manifest.resources[0]?.method, 'clone')
  const found = await findSnapshot(ctx, manifest.snapshotId)
  assert.ok(found)
  assert.equal(await readFile(join(snapshotPgdata(found.dir, 'primary'), 'row'), 'utf8'), 'at-rest')
})

test('a manifest written before online snapshots reads as all clones', async () => {
  const { ctx, runtime } = buildContext()
  await seed(ctx, runtime, { resources: [{ name: 'primary', state: 'sleeping', row: 'v1' }] })
  const manifest = await takeSnapshot(ctx, 'blog')
  const found = await findSnapshot(ctx, manifest.snapshotId)
  assert.ok(found)
  const onDisk = JSON.parse(await readFile(join(found.dir, 'manifest.json'), 'utf8')) as {
    resources: Array<Record<string, unknown>>
  }
  for (const entry of onDisk.resources) {
    delete entry['method']
  }
  await writeFile(join(found.dir, 'manifest.json'), JSON.stringify(onDisk), 'utf8')

  const [listed] = await listSnapshots(ctx, 'blog')
  assert.equal(listed?.resources[0]?.method, 'clone')
})

test('a project holding anything but postgres is refused before anything is touched', async () => {
  const { ctx, runtime } = buildContext()
  const { project } = await seed(ctx, runtime, { resources: [{ name: 'primary', state: 'running', row: 'v1' }] })
  await createQueueResource(ctx, project, 'jobs')

  await assert.rejects(takeOnlineSnapshot(ctx, 'blog'), (err: Error) => {
    assert.match(err.message, /jobs \(queue\)/)
    assert.match(err.message, /only postgres has an online copy mechanism/)
    return true
  })
  assert.equal(runtime._exec.calls.length, 0)
  assert.deepEqual(await snapshotsOnDisk(ctx, 'blog'), [])
})

test('a resource neither running nor asleep is refused before anything is copied', async () => {
  const { ctx, runtime } = buildContext()
  await seed(ctx, runtime, {
    resources: [
      { name: 'primary', state: 'running', row: 'live' },
      { name: 'broken', state: 'failed', row: 'unknown' },
    ],
  })
  runtime._exec.handler = serve(() => ({ stdout: basebackupTar('v1') }))

  await assert.rejects(takeOnlineSnapshot(ctx, 'blog'), /while broken is failed/)
  // Refused up front: primary, first in order, was never backed up.
  assert.equal(runtime._exec.calls.length, 0)
  assert.deepEqual(await snapshotsOnDisk(ctx, 'blog'), [])
})

test('a resource caught mid-transition at its turn is refused, and nothing is kept', async () => {
  const { ctx, runtime } = buildContext()
  const { resources } = await seed(ctx, runtime, {
    resources: [
      { name: 'primary', state: 'running', row: 'live' },
      { name: 'replica', state: 'sleeping', row: 'at-rest' },
    ],
  })
  const stdout = new PassThrough()
  runtime._exec.handler = serve(() => ({ stdout }))

  const taking = takeOnlineSnapshot(ctx, 'blog')
  await until(() => runtime._exec.calls.length === 1)
  // A wake of the sibling that is still in flight when its turn comes.
  ctx.store.setResourceState((resources[1] as Resource).id, 'starting')
  stdout.end(basebackupTar('v1'))

  await assert.rejects(taking, /cannot snapshot replica online while it is starting/)
  assert.deepEqual(await snapshotsOnDisk(ctx, 'blog'), [])
})

// ---------------------------------------------------------------------------
// Failure leaves nothing behind.
// ---------------------------------------------------------------------------

async function assertNothingLeft(ctx: DaemonContext, runtime: FakeRuntime, project: Project, primary: Resource): Promise<void> {
  assert.deepEqual(await snapshotsOnDisk(ctx, 'blog'), [])
  assert.equal(ctx.activity.count(primary.id), 0)
  // The hold was released: a snapshot right after is not refused as
  // "already in progress".
  runtime._exec.handler = serve(() => ({ stdout: basebackupTar('retry') }))
  const retried = await takeOnlineSnapshot(ctx, project.name)
  assert.equal(retried.resources[0]?.method, 'basebackup')
}

test('a pg_basebackup that exits non-zero fails the snapshot with its stderr and leaves nothing', async () => {
  const { ctx, runtime } = buildContext()
  const { project, resources } = await seed(ctx, runtime, { resources: [{ name: 'primary', state: 'running', row: 'v1' }] })
  const tar = basebackupTar('v1')
  runtime._exec.handler = serve(() => ({
    stdout: tar.subarray(0, 1024),
    error: 'pg_basebackup: error: could not get COPY data stream: server closed the connection',
  }))

  await assert.rejects(takeOnlineSnapshot(ctx, 'blog'), (err: Error & { hint?: string }) => {
    assert.match(err.message, /online backup of primary failed/)
    assert.match(err.hint ?? '', /server closed the connection/)
    return true
  })
  await assertNothingLeft(ctx, runtime, project, resources[0] as Resource)
})

test('a stream that ends early with every process reporting success is caught, and leaves nothing', async () => {
  // Cut on a block boundary, before pg_control, with no end marker: both
  // GNU tar and bsdtar accept this silently, so only the completeness check
  // in basebackupPostgres stands between it and a snapshot filed as good.
  const { ctx, runtime } = buildContext()
  const { project, resources } = await seed(ctx, runtime, { resources: [{ name: 'primary', state: 'running', row: 'v1' }] })
  const cut = tarOf(basebackupEntries('v1').slice(0, 4), { endMarker: false })
  runtime._exec.handler = serve(() => ({ stdout: cut }))

  await assert.rejects(takeOnlineSnapshot(ctx, 'blog'), /incomplete: global\/pg_control is missing/)
  await assertNothingLeft(ctx, runtime, project, resources[0] as Resource)
})

test('a tar cut mid-file fails the extractor, and leaves nothing', async () => {
  const { ctx, runtime } = buildContext()
  const { project, resources } = await seed(ctx, runtime, { resources: [{ name: 'primary', state: 'running', row: 'v1' }] })
  const tar = basebackupTar('v1')
  runtime._exec.handler = serve(() => ({ stdout: tar.subarray(0, 700) }))

  await assert.rejects(takeOnlineSnapshot(ctx, 'blog'))
  await assertNothingLeft(ctx, runtime, project, resources[0] as Resource)
})

test('a database put to sleep mid-backup fails the snapshot, and leaves nothing', async () => {
  const { ctx, runtime } = buildContext()
  const { project, resources } = await seed(ctx, runtime, { resources: [{ name: 'primary', state: 'running', row: 'v1' }] })
  const primary = resources[0] as Resource
  const stdout = new PassThrough()
  runtime._exec.handler = serve(() => ({ stdout }))

  const taking = takeOnlineSnapshot(ctx, 'blog')
  await until(() => runtime._exec.calls.length === 1)
  // `hobby sleep` mid-stream. Against Docker this also kills the session;
  // the fake stream carries on, so it is the state re-read after the
  // capture that has to catch it.
  const current = ctx.store.getResource(primary.id)
  assert.ok(current)
  await ctx.kinds.get('postgres').stop(ctx, current)
  stdout.end(basebackupTar('v1'))

  await assert.rejects(taking, /went from running to sleeping while it was being copied/)
  assert.deepEqual(await snapshotsOnDisk(ctx, 'blog'), [])
  await runtime.start('hobby-blog-primary')
  ctx.store.setResourceState(primary.id, 'running')
  await assertNothingLeft(ctx, runtime, project, primary)
})

test('an extractor that dies cancels the producer rather than leaving it blocked on the pipe', async () => {
  // A producer that never ends on its own, like a pg_basebackup whose
  // reader has gone: without the cancel, exec.done never settles and the
  // snapshot hangs holding the project forever.
  const { runtime } = buildContext()
  await runtime.ensureCreated({ name: 'c', image: 'i', env: {}, ports: [], binds: [] })
  await runtime.start('c')
  runtime._exec.handler = serve(() => ({ stdout: new PassThrough() }))
  const exec = runtime.execStream('c', ['pg_basebackup'])
  const dest = join(tmpdir(), `hobby-unpack-${randomUUID()}`)
  homes.push(dest)
  let killed = false
  const failing = Promise.reject(new Error('tar: unexpected EOF'))
  failing.catch(() => {})

  const outcome = await Promise.race([
    unpackExecTar(exec, dest, {
      spawnTar: () => ({
        stdin: new PassThrough(),
        done: failing,
        kill: () => {
          killed = true
        },
      }),
    }).then(
      () => 'resolved',
      () => 'rejected'
    ),
    new Promise((resolve) => setTimeout(() => resolve('hung'), 1000)),
  ])
  assert.equal(outcome, 'rejected')
  assert.equal(killed, true)
})

// ---------------------------------------------------------------------------
// No pause, and still exclusive.
// ---------------------------------------------------------------------------

test('mid-backup: the project is not fenced, a wake of a sleeping sibling goes straight through, and every other snapshot or restore is refused', async () => {
  const { ctx, runtime, counts } = buildContext()
  const { project, resources } = await seed(ctx, runtime, {
    resources: [
      { name: 'primary', state: 'running', row: 'live' },
      { name: 'replica', state: 'sleeping', row: 'at-rest' },
    ],
  })
  const [primary, replica] = resources as [Resource, Resource]
  const primaryOut = new PassThrough()
  runtime._exec.handler = serve((call) =>
    call.name === 'hobby-blog-primary' ? { stdout: primaryOut } : { stdout: basebackupTar('replica-backed-up') }
  )

  const taking = takeOnlineSnapshot(ctx, 'blog')
  await until(() => runtime._exec.calls.length === 1)

  // Not fenced: waitForProjectAwakeable resolves at once, and a real wake of
  // the sleeping sibling completes while the backup is still streaming.
  const settled = await Promise.race([
    waitForProjectAwakeable(ctx, project.id).then(() => 'open'),
    new Promise((resolve) => setTimeout(() => resolve('fenced'), 200)),
  ])
  assert.equal(settled, 'open')
  await getOrCreateWake(ctx)(replica.id)
  assert.equal(ctx.store.getResource(replica.id)?.state, 'running')

  // Still exclusive, against both kinds of hold.
  assert.throws(() => holdProjectAsleep(ctx, project.id, project.name), /already in progress/)
  await assert.rejects(takeOnlineSnapshot(ctx, 'blog'), /already in progress/)
  await assert.rejects(takeSnapshot(ctx, 'blog'), /already in progress/)

  primaryOut.end(basebackupTar('primary-backed-up'))
  const manifest = await taking

  // The sibling woke before its turn, so it was backed up online rather
  // than cloned hot.
  assert.deepEqual(
    manifest.resources.map((entry) => [entry.name, entry.method]),
    [
      ['primary', 'basebackup'],
      ['replica', 'basebackup'],
    ]
  )
  assert.equal(counts.stops, 0)
  assert.equal(ctx.store.getResource(primary.id)?.state, 'running')
})

test('the hibernator cannot sleep a database while its backup streams', async () => {
  const { ctx, runtime, counts } = buildContext()
  const { resources } = await seed(ctx, runtime, { resources: [{ name: 'primary', state: 'running', row: 'live' }] })
  const primary = resources[0] as Resource
  // An idle clock that started long ago: without the snapshot's activity
  // handle, this resource is exactly what the hibernator sleeps next tick.
  ctx.activity.touch(primary.id)
  const stdout = new PassThrough()
  runtime._exec.handler = serve(() => ({ stdout }))

  const taking = takeOnlineSnapshot(ctx, 'blog')
  await until(() => runtime._exec.calls.length === 1)
  assert.equal(ctx.activity.count(primary.id), 1)

  const hibernator = startHibernator(ctx, {
    intervalMs: 1,
    now: () => Date.now() + 24 * 60 * 60 * 1000,
    checkActiveQuery: async () => 'idle',
  })
  await new Promise((resolve) => setTimeout(resolve, 50))
  await hibernator.stop()

  stdout.end(basebackupTar('backed-up'))
  await taking
  assert.equal(counts.stops, 0)
  assert.equal(ctx.store.getResource(primary.id)?.state, 'running')
  assert.equal(ctx.activity.count(primary.id), 0)
})

// ---------------------------------------------------------------------------
// Restore, through the existing paths, unchanged.
// ---------------------------------------------------------------------------

test('an online snapshot restores into a new project with the backup, backup_label included', async () => {
  const { ctx, runtime } = buildContext()
  await seed(ctx, runtime, { resources: [{ name: 'primary', state: 'running', row: 'live' }] })
  runtime._exec.handler = serve(() => ({ stdout: basebackupTar('backed-up') }))
  const manifest = await takeOnlineSnapshot(ctx, 'blog')

  const result = await restoreSnapshot(ctx, manifest.snapshotId, { as: 'blog-copy' })

  const restored = result.resources[0]
  assert.ok(restored && restored.kind === 'postgres')
  assert.equal(restored.state, 'sleeping')
  const pgdata = resolvePgdataPath(restored.config.dataDir)
  assert.equal(pgdata, resolvePgdataPath(ctx.paths.resourcePath('blog-copy', 'primary', 'pgdata')))
  assert.equal(await readFile(join(pgdata, 'row'), 'utf8'), 'backed-up')
  // Kept, never stripped: the first start recovers from it.
  assert.match(await readFile(join(pgdata, 'backup_label'), 'utf8'), /START WAL LOCATION/)
  assert.equal(await readFile(join(pgdata, 'global', 'pg_control'), 'utf8'), 'control')
})

test('an online snapshot restores in place over the running project', async () => {
  const { ctx, runtime } = buildContext()
  const { resources } = await seed(ctx, runtime, { resources: [{ name: 'primary', state: 'running', row: 'live' }] })
  const primary = resources[0] as Resource
  runtime._exec.handler = serve(() => ({ stdout: basebackupTar('backed-up') }))
  const manifest = await takeOnlineSnapshot(ctx, 'blog')
  const livePgdata = resolvePgdataPath(ctx.paths.resourcePath('blog', 'primary', 'pgdata'))
  await writeFile(join(livePgdata, 'row'), 'written-after', 'utf8')

  const result = await restoreSnapshot(ctx, manifest.snapshotId, { inPlace: true })

  assert.deepEqual(result.restartFailures, [])
  assert.equal(result.preRestoreDir, null)
  assert.equal(await readFile(join(livePgdata, 'row'), 'utf8'), 'backed-up')
  assert.ok(await stat(join(livePgdata, 'backup_label')))
  assert.equal(ctx.store.getResource(primary.id)?.state, 'running')
})

// ---------------------------------------------------------------------------
// The route.
// ---------------------------------------------------------------------------

interface JsonResponse {
  status: number
  body: unknown
}

async function withServer(ctx: DaemonContext, fn: (baseUrl: string) => Promise<void>): Promise<void> {
  const server = createServer(createApp(ctx))
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const address = server.address() as AddressInfo
  try {
    await fn(`http://127.0.0.1:${address.port}`)
  } finally {
    const closed = new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())))
    server.closeAllConnections()
    await closed
    ctx.store.close()
  }
}

async function call(baseUrl: string, method: string, path: string, body?: unknown): Promise<JsonResponse> {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  return { status: res.status, body: text.length > 0 ? JSON.parse(text) : undefined }
}

function errorOf(res: JsonResponse): { code?: string; message?: string; hint?: string } {
  return (res.body as { error?: { code?: string; message?: string; hint?: string } }).error ?? {}
}

test('online and allowPause together are a 400, and nothing is taken', async () => {
  const { ctx, runtime } = buildContext()
  await seed(ctx, runtime, { resources: [{ name: 'primary', state: 'running', row: 'v1' }] })
  await withServer(ctx, async (baseUrl) => {
    const res = await call(baseUrl, 'POST', '/v1/projects/blog/snapshots', { online: true, allowPause: true })
    assert.equal(res.status, 400)
    assert.equal(errorOf(res).code, 'usage')
    assert.equal(runtime._exec.calls.length, 0)
    assert.deepEqual(await snapshotsOnDisk(ctx, 'blog'), [])
  })
})

test('online that is not a boolean is a usage error', async () => {
  const { ctx, runtime } = buildContext()
  await seed(ctx, runtime, { resources: [{ name: 'primary', state: 'running', row: 'v1' }] })
  await withServer(ctx, async (baseUrl) => {
    const res = await call(baseUrl, 'POST', '/v1/projects/blog/snapshots', { online: 'yes' })
    assert.equal(res.status, 400)
  })
})

test('a pinned, running project needs no flag with online, and nothing is stopped', async () => {
  const { ctx, runtime, counts } = buildContext()
  const { resources } = await seed(ctx, runtime, {
    pinned: true,
    resources: [{ name: 'primary', state: 'running', row: 'v1' }],
  })
  runtime._exec.handler = serve(() => ({ stdout: basebackupTar('v1') }))

  await withServer(ctx, async (baseUrl) => {
    const res = await call(baseUrl, 'POST', '/v1/projects/blog/snapshots', { online: true })
    assert.equal(res.status, 201)
    const body = res.body as { snapshot: { resources: Array<{ method: string; config: Record<string, unknown> }> } }
    assert.equal(body.snapshot.resources[0]?.method, 'basebackup')
    // Still redacted on the way out.
    assert.equal(body.snapshot.resources[0]?.config['password'], undefined)
    assert.equal(counts.stops, 0)
    assert.equal(ctx.store.getResource((resources[0] as Resource).id)?.state, 'running')
  })
})

test('the pinned refusal suggests --online only to a project that would be accepted', async () => {
  const { ctx, runtime } = buildContext()
  const { project } = await seed(ctx, runtime, { pinned: true, resources: [{ name: 'primary', state: 'running', row: 'v1' }] })

  await withServer(ctx, async (baseUrl) => {
    const qualifies = await call(baseUrl, 'POST', '/v1/projects/blog/snapshots')
    assert.equal(qualifies.status, 409)
    assert.match(errorOf(qualifies).hint ?? '', /--online/)
    assert.match(errorOf(qualifies).hint ?? '', /--allow-pause/)

    await createQueueResource(ctx, project, 'jobs')
    const doesNot = await call(baseUrl, 'POST', '/v1/projects/blog/snapshots')
    assert.equal(doesNot.status, 409)
    assert.doesNotMatch(errorOf(doesNot).hint ?? '', /--online/)
    assert.match(errorOf(doesNot).hint ?? '', /--allow-pause/)

    const online = await call(baseUrl, 'POST', '/v1/projects/blog/snapshots', { online: true })
    assert.equal(online.status, 409)
    assert.match(errorOf(online).message ?? '', /only postgres has an online copy mechanism/)
  })
})

test('an online snapshot of a released project is refused like any other', async () => {
  const { ctx, runtime } = buildContext()
  const { project } = await seed(ctx, runtime, { resources: [{ name: 'primary', state: 'sleeping', row: 'v1' }] })
  ctx.store.setProjectReleased(project.id, new Date())
  await withServer(ctx, async (baseUrl) => {
    const res = await call(baseUrl, 'POST', '/v1/projects/blog/snapshots', { online: true })
    assert.equal(res.status, 409)
    assert.match(errorOf(res).message ?? '', /released/)
  })
})

test('basebackupCommand never needs a shell: the role name is one argument, whatever it holds', () => {
  const command = basebackupCommand('odd; rm -rf /', 'label')
  assert.equal(command[0], 'pg_basebackup')
  assert.ok(command.includes('--username=odd; rm -rf /'))
})
