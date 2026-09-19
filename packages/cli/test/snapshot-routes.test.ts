// The snapshot routes (packages/cli/src/daemon/routes.ts, "Snapshot routes"),
// driven over loopback HTTP the same way routes.test.ts drives every other
// route. Thin on purpose: quiesce, resume, the clone and the restore
// rewrites have their own tests in snapshots.test.ts and
// snapshot-restore.test.ts, and nothing here re-proves them. What these pin
// is what the routes add: the pinned-project refusal, the wake fence, the
// redaction of a manifest on its way out, and a restore that is shown to
// bring the bytes back rather than assumed to.
//
// The fake runtime, not Docker, but a real HOBBY_HOME in a temp directory,
// because the clone and the swap are real filesystem operations and a
// "PGDATA" here is a real directory holding a real file.

import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { rmSync } from 'node:fs'
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import {
  createFakeRuntime,
  createKindRegistry,
  HobbyError,
  openStore,
  resolvePaths,
  type HobbyConfig,
  type PostgresConfig,
  type PostgresResource,
  type Project,
  type Resource,
  type ResourceKindHandler,
  type Store,
} from '@hobby.sh/core'
import { appKindHandler } from '@hobby.sh/app'
import { postgresKindHandler } from '@hobby.sh/pg'
import { ActivityTracker } from '@hobby.sh/proxy'
import { queueKindHandler } from '@hobby.sh/queue'
import { workerKindHandler } from '@hobby.sh/worker'
import { getOrCreateWake, holdProjectAsleep } from '../src/daemon/context.js'
import { createApp, type DaemonContext } from '../src/index.js'
import { createQueueResource } from '../src/daemon/routes.js'
import { projectSnapshotsDir } from '../src/daemon/snapshots.js'

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
    queuePort: 0,
    caddyEnabled: false,
    caddyAdminPort: 2019,
    caddyStudioHost: null,
    project: null,
  }
}

// The one substitution: postgres's real guard is a pg_stat_activity query
// (packages/pg/src/activity-guard.ts), which against the fake runtime can
// only ever answer `unreachable`, and quiesce correctly refuses on that.
// Standing in `idle` is what lets a route test reach the part it is about.
// start, stop and destroy are the real handler's, so states move exactly as
// they do in production.
function buildContext(postgres: ResourceKindHandler<PostgresResource> = idleGuardPostgres()): DaemonContext {
  const home = join(tmpdir(), `hobby-snapshot-routes-${randomUUID()}`)
  homes.push(home)
  const store: Store = openStore(':memory:')
  return {
    store,
    runtime: createFakeRuntime(),
    paths: resolvePaths({ HOBBY_HOME: home }),
    config: testConfig(),
    activity: new ActivityTracker(),
    kinds: createKindRegistry([postgres, appKindHandler, workerKindHandler, queueKindHandler]),
    // Nothing listens behind the fake runtime, so a real readiness probe
    // would land every resume on `failed`. Same seam snapshots.test.ts uses.
    probeFactory: () => async (): Promise<boolean> => true,
  }
}

function idleGuardPostgres(): ResourceKindHandler<PostgresResource> {
  return { ...postgresKindHandler, guard: async () => 'idle' }
}

function postgresConfig(ctx: DaemonContext, project: string, name: string): PostgresConfig {
  return {
    image: 'postgres:18-alpine',
    containerName: `hobby-${project}-${name}`,
    hostPort: 15432,
    dataDir: ctx.paths.resourcePath(project, name, 'pgdata'),
    superuser: 'postgres',
    password: 'the-real-password',
    database: 'app',
  }
}

// A project holding postgres resources, each with a "PGDATA" holding one
// file whose contents stand in for a row.
async function seed(
  ctx: DaemonContext,
  opts: { name?: string; pinned?: boolean; resources: Array<{ name: string; state: Resource['state']; row: string }> }
): Promise<{ project: Project; resources: Resource[] }> {
  const name = opts.name ?? 'blog'
  const project = ctx.store.createProject({ name, sleepAfterSeconds: opts.pinned === true ? null : 300 })
  const resources: Resource[] = []
  for (const spec of opts.resources) {
    const resource = ctx.store.createResource({
      projectId: project.id,
      kind: 'postgres',
      name: spec.name,
      config: postgresConfig(ctx, name, spec.name),
    })
    ctx.store.setResourceState(resource.id, spec.state)
    await writeRow(ctx, name, spec.name, spec.row)
    resources.push(resource)
  }
  return { project, resources }
}

async function writeRow(ctx: DaemonContext, project: string, resource: string, row: string): Promise<void> {
  const dir = ctx.paths.resourcePath(project, resource, 'pgdata')
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'row'), row, 'utf8')
}

function readRow(ctx: DaemonContext, project: string, resource: string): Promise<string> {
  return readFile(join(ctx.paths.resourcePath(project, resource, 'pgdata'), 'row'), 'utf8')
}

function stateOf(ctx: DaemonContext, id: string): string | undefined {
  return ctx.store.getResource(id)?.state
}

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
    // Same forced close as routes.test.ts's withServer, for the same reason.
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

interface TakeBody {
  snapshot: { snapshotId: string; resources: Array<{ name: string; stateAtSnapshot: string; config: Record<string, unknown> }> }
  dir: string
  resources: Array<{ id: string; state: string }>
}

function errorCode(res: JsonResponse): string | undefined {
  return (res.body as { error?: { code?: string } }).error?.code
}

test('POST /v1/projects/:name/snapshots quiesces both, resumes only what was running, and says where it landed', async () => {
  const ctx = buildContext()
  const { resources } = await seed(ctx, {
    resources: [
      { name: 'primary', state: 'running', row: 'v1' },
      { name: 'archive', state: 'sleeping', row: 'old' },
    ],
  })
  const [running, sleeping] = resources as [Resource, Resource]

  await withServer(ctx, async (baseUrl) => {
    const res = await call(baseUrl, 'POST', '/v1/projects/blog/snapshots')
    assert.equal(res.status, 201)
    const body = res.body as TakeBody

    // Both were at rest when the copy was taken, whichever state they
    // started in: that is the whole consistency story (ADR 0016).
    for (const entry of body.snapshot.resources) {
      assert.equal(entry.stateAtSnapshot, 'sleeping', `${entry.name} was not quiesced`)
    }
    assert.equal(stateOf(ctx, running.id), 'running')
    assert.equal(stateOf(ctx, sleeping.id), 'sleeping')
    assert.deepEqual(
      Object.fromEntries(body.resources.map((r) => [r.id, r.state])),
      { [running.id]: 'running', [sleeping.id]: 'sleeping' }
    )

    assert.equal(body.dir, join(projectSnapshotsDir(ctx.paths, 'blog'), body.snapshot.snapshotId))
    assert.equal(await readFile(join(body.dir, 'data', 'primary', 'pgdata', 'row'), 'utf8'), 'v1')
  })
})

test('a snapshot or a listing never carries a password over the wire, though the manifest on disk keeps it', async () => {
  const ctx = buildContext()
  await seed(ctx, { resources: [{ name: 'primary', state: 'sleeping', row: 'v1' }] })

  await withServer(ctx, async (baseUrl) => {
    const taken = await call(baseUrl, 'POST', '/v1/projects/blog/snapshots')
    const listed = await call(baseUrl, 'GET', '/v1/projects/blog/snapshots')
    assert.equal(listed.status, 200)

    for (const res of [taken, listed]) {
      assert.ok(!JSON.stringify(res.body).includes('the-real-password'), 'a password crossed the wire')
    }
    const body = taken.body as TakeBody
    assert.equal('password' in (body.snapshot.resources[0]?.config ?? {}), false)

    // Restore needs it, so the file keeps it.
    const onDisk = await readFile(join(body.dir, 'manifest.json'), 'utf8')
    assert.ok(onDisk.includes('the-real-password'))
  })
})

test('GET /v1/projects/:name/snapshots lists newest first, and still answers after the project is deleted', async () => {
  const ctx = buildContext()
  const { project } = await seed(ctx, { resources: [{ name: 'primary', state: 'sleeping', row: 'v1' }] })

  await withServer(ctx, async (baseUrl) => {
    const first = (await call(baseUrl, 'POST', '/v1/projects/blog/snapshots')).body as TakeBody
    // snapshotId is second-resolution; two in the same second would still be
    // distinct (the random suffix) but not ordered.
    await new Promise((resolve) => setTimeout(resolve, 1100))
    const second = (await call(baseUrl, 'POST', '/v1/projects/blog/snapshots')).body as TakeBody

    ctx.store.deleteProject(project.id)

    const res = await call(baseUrl, 'GET', '/v1/projects/blog/snapshots')
    assert.equal(res.status, 200)
    const ids = (res.body as { snapshots: Array<{ snapshotId: string }> }).snapshots.map((s) => s.snapshotId)
    assert.deepEqual(ids, [second.snapshot.snapshotId, first.snapshot.snapshotId])
  })
})

test('a snapshot that fails partway resumes what it stopped and leaves every state truthful', async () => {
  const ctx = buildContext()
  const { resources } = await seed(ctx, {
    resources: [
      { name: 'primary', state: 'running', row: 'v1' },
      { name: 'replica', state: 'running', row: 'v1' },
    ],
  })
  // quiesce stops in the store's listing order; fail whichever comes second.
  const [first, second] = ctx.store.listResources(resources[0]?.projectId)
  assert.ok(first !== undefined && second !== undefined)
  const realStop = ctx.runtime.stop
  ctx.runtime.stop = async (name: string, opts: { timeoutSec: number }): Promise<void> => {
    if (name === second.config.containerName) {
      throw new HobbyError('runtime_unavailable', 'docker stop timed out')
    }
    return realStop(name, opts)
  }

  await withServer(ctx, async (baseUrl) => {
    const res = await call(baseUrl, 'POST', '/v1/projects/blog/snapshots')
    assert.equal(res.status, 503)
    assert.equal(errorCode(res), 'runtime_unavailable')

    // The one that stopped is back; the one whose stop threw says so rather
    // than claiming to be running or asleep.
    assert.equal(stateOf(ctx, first.id), 'running')
    assert.equal(stateOf(ctx, second.id), 'failed')

    const listed = await call(baseUrl, 'GET', '/v1/projects/blog/snapshots')
    assert.deepEqual((listed.body as { snapshots: unknown[] }).snapshots, [])
  })
})

test('POST /v1/projects/:name/snapshots for an unknown project is 404', async () => {
  const ctx = buildContext()
  await withServer(ctx, async (baseUrl) => {
    const res = await call(baseUrl, 'POST', '/v1/projects/nope/snapshots')
    assert.equal(res.status, 404)
    assert.equal(errorCode(res), 'project_not_found')
  })
})

// ---------------------------------------------------------------------------
// The pinned-project guard: three cases, one each.
// ---------------------------------------------------------------------------

test('a pinned project with something running is refused without allowPause, and nothing is stopped', async () => {
  const ctx = buildContext()
  const { resources } = await seed(ctx, { pinned: true, resources: [{ name: 'primary', state: 'running', row: 'v1' }] })
  const primary = resources[0] as Resource

  await withServer(ctx, async (baseUrl) => {
    const refused = await call(baseUrl, 'POST', '/v1/projects/blog/snapshots')
    assert.equal(refused.status, 409)
    assert.equal(errorCode(refused), 'conflict')
    assert.match((refused.body as { error: { hint: string } }).error.hint, /--allow-pause/)
    assert.equal(stateOf(ctx, primary.id), 'running')
    const listed = await call(baseUrl, 'GET', '/v1/projects/blog/snapshots')
    assert.deepEqual((listed.body as { snapshots: unknown[] }).snapshots, [])

    const allowed = await call(baseUrl, 'POST', '/v1/projects/blog/snapshots', { allowPause: true })
    assert.equal(allowed.status, 201)
    assert.equal(stateOf(ctx, primary.id), 'running')
  })
})

test('a pinned project whose resources are all asleep needs no flag', async () => {
  const ctx = buildContext()
  await seed(ctx, { pinned: true, resources: [{ name: 'primary', state: 'sleeping', row: 'v1' }] })

  await withServer(ctx, async (baseUrl) => {
    const res = await call(baseUrl, 'POST', '/v1/projects/blog/snapshots')
    assert.equal(res.status, 201)
  })
})

test('an unpinned project with something running needs no flag', async () => {
  const ctx = buildContext()
  const { resources } = await seed(ctx, { resources: [{ name: 'primary', state: 'running', row: 'v1' }] })

  await withServer(ctx, async (baseUrl) => {
    const res = await call(baseUrl, 'POST', '/v1/projects/blog/snapshots')
    assert.equal(res.status, 201)
    assert.equal(stateOf(ctx, (resources[0] as Resource).id), 'running')
  })
})

test('an in-place restore over a pinned, running project needs allowPause too', async () => {
  const ctx = buildContext()
  await seed(ctx, { pinned: true, resources: [{ name: 'primary', state: 'sleeping', row: 'v1' }] })

  await withServer(ctx, async (baseUrl) => {
    const taken = (await call(baseUrl, 'POST', '/v1/projects/blog/snapshots')).body as TakeBody
    const primary = ctx.store.listResources()[0] as Resource
    ctx.store.setResourceState(primary.id, 'running')
    await writeRow(ctx, 'blog', 'primary', 'v2')

    const refused = await call(baseUrl, 'POST', `/v1/snapshots/${taken.snapshot.snapshotId}/restore`, { inPlace: true })
    assert.equal(refused.status, 409)
    assert.equal(await readRow(ctx, 'blog', 'primary'), 'v2')

    const allowed = await call(baseUrl, 'POST', `/v1/snapshots/${taken.snapshot.snapshotId}/restore`, {
      inPlace: true,
      allowPause: true,
    })
    assert.equal(allowed.status, 200)
    assert.equal(await readRow(ctx, 'blog', 'primary'), 'v1')
  })
})

test('a pinned project whose only running resource is a queue needs no flag: stopping a queue pauses nothing', async () => {
  const ctx = buildContext()
  const { project } = await seed(ctx, { pinned: true, resources: [{ name: 'primary', state: 'sleeping', row: 'v1' }] })
  const queue = await createQueueResource(ctx, project, 'jobs')
  assert.equal(queue.state, 'running')

  await withServer(ctx, async (baseUrl) => {
    const res = await call(baseUrl, 'POST', '/v1/projects/blog/snapshots')
    assert.equal(res.status, 201)
    assert.equal(stateOf(ctx, queue.id), 'running')
  })
})

test('a released project is refused: its data belongs to a stack hobby cannot quiesce', async () => {
  const ctx = buildContext()
  const { project } = await seed(ctx, { resources: [{ name: 'primary', state: 'sleeping', row: 'v1' }] })
  ctx.store.setProjectReleased(project.id, new Date())

  await withServer(ctx, async (baseUrl) => {
    const res = await call(baseUrl, 'POST', '/v1/projects/blog/snapshots')
    assert.equal(res.status, 409)
    assert.match((res.body as { error: { message: string } }).error.message, /released/)
  })
})

test('allowPause that is not a boolean is a usage error, never a truthy coercion', async () => {
  const ctx = buildContext()
  await seed(ctx, { pinned: true, resources: [{ name: 'primary', state: 'running', row: 'v1' }] })
  await withServer(ctx, async (baseUrl) => {
    const res = await call(baseUrl, 'POST', '/v1/projects/blog/snapshots', { allowPause: 'yes' })
    assert.equal(res.status, 400)
  })
})

// ---------------------------------------------------------------------------
// Restore. A snapshot nobody has ever restored from is not a backup.
// ---------------------------------------------------------------------------

test('an in-place restore brings the data back, keeps the resource ids, and resumes what was running', async () => {
  const ctx = buildContext()
  const { resources } = await seed(ctx, { resources: [{ name: 'primary', state: 'running', row: 'v1' }] })
  const primary = resources[0] as Resource

  await withServer(ctx, async (baseUrl) => {
    const taken = (await call(baseUrl, 'POST', '/v1/projects/blog/snapshots')).body as TakeBody
    await writeRow(ctx, 'blog', 'primary', 'v2')

    const res = await call(baseUrl, 'POST', `/v1/snapshots/${taken.snapshot.snapshotId}/restore`, { inPlace: true })
    assert.equal(res.status, 200)
    const body = res.body as {
      project: { name: string }
      resources: Array<{ id: string; state: string }>
      restartFailures: string[]
      preRestoreDir: string | null
    }

    assert.equal(await readRow(ctx, 'blog', 'primary'), 'v1')
    assert.equal(body.project.name, 'blog')
    assert.deepEqual(body.resources.map((r) => r.id), [primary.id])
    assert.equal(stateOf(ctx, primary.id), 'running')
    assert.deepEqual(body.restartFailures, [])

    // Everything came back, so the replaced data is gone, and so is staging.
    assert.equal(body.preRestoreDir, null)
    assert.deepEqual(await readdir(ctx.paths.projectsDir), ['blog'])
  })
})

test('an in-place restore that cannot restart what was running keeps the replaced data and says where', async () => {
  const ctx = buildContext()
  const { resources } = await seed(ctx, { resources: [{ name: 'primary', state: 'running', row: 'v1' }] })
  const primary = resources[0] as Resource

  await withServer(ctx, async (baseUrl) => {
    const taken = (await call(baseUrl, 'POST', '/v1/projects/blog/snapshots')).body as TakeBody
    await writeRow(ctx, 'blog', 'primary', 'v2')

    // From here on, nothing answers readiness: the restored data "does not
    // start".
    ctx.probeFactory = () => async (): Promise<boolean> => false

    const res = await call(baseUrl, 'POST', `/v1/snapshots/${taken.snapshot.snapshotId}/restore`, { inPlace: true })
    assert.equal(res.status, 200)
    const body = res.body as { restartFailures: string[]; preRestoreDir: string | null }

    assert.equal(body.restartFailures.length, 1)
    assert.equal(stateOf(ctx, primary.id), 'failed')
    assert.equal(await readRow(ctx, 'blog', 'primary'), 'v1')
    assert.ok(body.preRestoreDir !== null)
    assert.equal(await readFile(join(body.preRestoreDir, 'primary', 'pgdata', 'row'), 'utf8'), 'v2')
  })
})

test('an in-place restore whose clone fails touches nothing: same data, still running, no leftovers', async () => {
  const ctx = buildContext()
  const { resources } = await seed(ctx, { resources: [{ name: 'primary', state: 'running', row: 'v1' }] })
  const primary = resources[0] as Resource

  await withServer(ctx, async (baseUrl) => {
    const taken = (await call(baseUrl, 'POST', '/v1/projects/blog/snapshots')).body as TakeBody
    await writeRow(ctx, 'blog', 'primary', 'v2')
    // The manifest is still there, so the snapshot is found; its data is not,
    // so the clone into staging throws.
    await rm(join(taken.dir, 'data'), { recursive: true, force: true })

    const res = await call(baseUrl, 'POST', `/v1/snapshots/${taken.snapshot.snapshotId}/restore`, { inPlace: true })
    assert.ok(res.status >= 400)

    assert.equal(await readRow(ctx, 'blog', 'primary'), 'v2')
    assert.equal(stateOf(ctx, primary.id), 'running')
    assert.deepEqual(await readdir(ctx.paths.projectsDir), ['blog'])
  })
})

test('an in-place restore that cannot quiesce leaves the data as it was and no staging copy behind', async () => {
  let guardAnswer: 'idle' | 'unreachable' = 'idle'
  const ctx = buildContext({ ...postgresKindHandler, guard: async () => guardAnswer })
  const { resources } = await seed(ctx, { resources: [{ name: 'primary', state: 'running', row: 'v1' }] })
  const primary = resources[0] as Resource

  await withServer(ctx, async (baseUrl) => {
    const taken = (await call(baseUrl, 'POST', '/v1/projects/blog/snapshots')).body as TakeBody
    await writeRow(ctx, 'blog', 'primary', 'v2')
    // The staging clone has already happened by the time quiesce asks.
    guardAnswer = 'unreachable'

    const res = await call(baseUrl, 'POST', `/v1/snapshots/${taken.snapshot.snapshotId}/restore`, { inPlace: true })
    assert.equal(res.status, 409)
    assert.equal(await readRow(ctx, 'blog', 'primary'), 'v2')
    assert.equal(stateOf(ctx, primary.id), 'running')
    assert.deepEqual(await readdir(ctx.paths.projectsDir), ['blog'])
  })
})

test('an in-place restore is refused when the project has gained a resource since the snapshot', async () => {
  const ctx = buildContext()
  const { project } = await seed(ctx, { resources: [{ name: 'primary', state: 'sleeping', row: 'v1' }] })

  await withServer(ctx, async (baseUrl) => {
    const taken = (await call(baseUrl, 'POST', '/v1/projects/blog/snapshots')).body as TakeBody
    ctx.store.createResource({
      projectId: project.id,
      kind: 'postgres',
      name: 'added',
      config: postgresConfig(ctx, 'blog', 'added'),
    })
    await writeRow(ctx, 'blog', 'added', 'new data')
    await writeRow(ctx, 'blog', 'primary', 'v2')

    const res = await call(baseUrl, 'POST', `/v1/snapshots/${taken.snapshot.snapshotId}/restore`, { inPlace: true })
    assert.equal(res.status, 409)
    assert.match((res.body as { error: { message: string } }).error.message, /added since: added/)
    assert.equal(await readRow(ctx, 'blog', 'primary'), 'v2')
    assert.equal(await readRow(ctx, 'blog', 'added'), 'new data')
  })
})

test('a restore into a new project carries the data and leaves the original alone', async () => {
  const ctx = buildContext()
  await seed(ctx, { resources: [{ name: 'primary', state: 'running', row: 'v1' }] })

  await withServer(ctx, async (baseUrl) => {
    const taken = (await call(baseUrl, 'POST', '/v1/projects/blog/snapshots')).body as TakeBody
    await writeRow(ctx, 'blog', 'primary', 'v2')

    const res = await call(baseUrl, 'POST', `/v1/snapshots/${taken.snapshot.snapshotId}/restore`, { as: 'blog-copy' })
    assert.equal(res.status, 201)
    const body = res.body as { project: { name: string }; resources: Array<{ state: string }> }
    assert.equal(body.project.name, 'blog-copy')
    assert.deepEqual(body.resources.map((r) => r.state), ['sleeping'])

    assert.equal(await readRow(ctx, 'blog-copy', 'primary'), 'v1')
    assert.equal(await readRow(ctx, 'blog', 'primary'), 'v2')
  })
})

test('as and inPlace together are a usage error', async () => {
  const ctx = buildContext()
  await seed(ctx, { resources: [{ name: 'primary', state: 'sleeping', row: 'v1' }] })
  await withServer(ctx, async (baseUrl) => {
    const taken = (await call(baseUrl, 'POST', '/v1/projects/blog/snapshots')).body as TakeBody
    const res = await call(baseUrl, 'POST', `/v1/snapshots/${taken.snapshot.snapshotId}/restore`, {
      as: 'other',
      inPlace: true,
    })
    assert.equal(res.status, 400)
  })
})

test('a snapshot id that walks out of snapshots/ is not found, and deletes nothing', async () => {
  const ctx = buildContext()
  await seed(ctx, { resources: [{ name: 'primary', state: 'sleeping', row: 'v1' }] })
  // A directory outside snapshots/ that looks exactly like a snapshot, so
  // the only thing standing between a crafted id and an rm -rf of it is the
  // id check in findSnapshot, not a missing or malformed manifest.
  const bait = join(ctx.paths.home, 'bait')
  await mkdir(bait, { recursive: true })
  await writeFile(join(bait, 'manifest.json'), JSON.stringify(manifestShaped('bait')), 'utf8')

  await withServer(ctx, async (baseUrl) => {
    // snapshots/blog/ must exist for the walk to resolve: take one.
    await call(baseUrl, 'POST', '/v1/projects/blog/snapshots')
    const res = await call(baseUrl, 'DELETE', `/v1/snapshots/${encodeURIComponent('../../bait')}`)
    assert.equal(res.status, 404)
    await stat(join(bait, 'manifest.json'))
  })
})

function manifestShaped(id: string): Record<string, unknown> {
  return { version: 1, snapshotId: id, createdAt: new Date().toISOString(), resources: [] }
}

test('DELETE /v1/snapshots/:id removes it from the listing', async () => {
  const ctx = buildContext()
  await seed(ctx, { resources: [{ name: 'primary', state: 'sleeping', row: 'v1' }] })
  await withServer(ctx, async (baseUrl) => {
    const taken = (await call(baseUrl, 'POST', '/v1/projects/blog/snapshots')).body as TakeBody
    const res = await call(baseUrl, 'DELETE', `/v1/snapshots/${taken.snapshot.snapshotId}`)
    assert.equal(res.status, 200)
    await assert.rejects(stat(taken.dir))
  })
})

// ---------------------------------------------------------------------------
// The wake fence (holdProjectAsleep, packages/cli/src/daemon/context.ts).
// ---------------------------------------------------------------------------

test('a wake that lands between quiesce and the clone waits, so the snapshot is of a stopped resource', async () => {
  // The ordinary case the fence exists for: quiesce stops the database, and
  // an application's pool reconnects through the proxy straight away. Here
  // the "reconnect" is a wake fired from inside stop itself, the earliest
  // moment it could possibly arrive.
  let wakes: Array<Promise<void>> = []
  let starts = 0
  const reconnecting: ResourceKindHandler<PostgresResource> = {
    ...idleGuardPostgres(),
    async stop(kctx, resource) {
      await postgresKindHandler.stop(kctx, resource)
      wakes = [...wakes, getOrCreateWake(ctx)(resource.id)]
    },
    async start(kctx, resource) {
      starts += 1
      await postgresKindHandler.start(kctx, resource)
    },
  }
  const ctx = buildContext(reconnecting)
  const { resources } = await seed(ctx, { resources: [{ name: 'primary', state: 'running', row: 'v1' }] })

  await withServer(ctx, async (baseUrl) => {
    const res = await call(baseUrl, 'POST', '/v1/projects/blog/snapshots')
    assert.equal(res.status, 201)
    await Promise.all(wakes)

    assert.equal((res.body as TakeBody).snapshot.resources[0]?.stateAtSnapshot, 'sleeping')
    // Resume started it once; the waiting wake found it running and did not
    // start it a second time.
    assert.equal(starts, 1)
    assert.equal(stateOf(ctx, (resources[0] as Resource).id), 'running')
  })
})

test('an explicit wake waits for the fence, and a second hold on the same project is refused', async () => {
  const ctx = buildContext()
  const { project, resources } = await seed(ctx, { resources: [{ name: 'primary', state: 'sleeping', row: 'v1' }] })
  const primary = resources[0] as Resource

  await withServer(ctx, async (baseUrl) => {
    const release = holdProjectAsleep(ctx, project.id, project.name)

    const concurrent = await call(baseUrl, 'POST', '/v1/projects/blog/snapshots')
    assert.equal(concurrent.status, 409)
    assert.match((concurrent.body as { error: { message: string } }).error.message, /already in progress/)

    let settled = false
    const woke = call(baseUrl, 'POST', `/v1/resources/${primary.id}/start`).then((res) => {
      settled = true
      return res
    })
    await new Promise((resolve) => setTimeout(resolve, 100))
    assert.equal(settled, false)
    assert.equal(stateOf(ctx, primary.id), 'sleeping')

    release()
    assert.equal((await woke).status, 200)
    assert.equal(stateOf(ctx, primary.id), 'running')
  })
})
