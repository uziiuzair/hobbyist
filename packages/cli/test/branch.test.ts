// `hobby branch` against a fake runtime and a real temporary HOBBY_HOME. No
// Docker: the fake runtime records container specs and running state, and
// the data directories are real files, so "the data was cloned" and "the
// branch does not share the source's directory" are checked on disk rather
// than inferred from config.

import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { existsSync, rmSync } from 'node:fs'
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import {
  createFakeRuntime,
  HobbyError,
  openStore,
  resolvePaths,
  resolvePgdataPath,
  type CloneResult,
  type HobbyConfig,
  type PostgresResource,
  type Project,
} from '@hobby.sh/core'
import { createPostgres } from '@hobby.sh/pg'
import { ActivityTracker } from '@hobby.sh/proxy'
import { createDefaultKindRegistry, type DaemonContext } from '../src/daemon/context.js'
import { branchProject, type BranchOptions } from '../src/daemon/branch.js'
import { branchCopyNote, cmdBranch, createApp, UsageError, type Ctx } from '../src/index.js'
import type { Api, BranchResponse } from '../src/cli/client.js'

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

type FakeRuntime = ReturnType<typeof createFakeRuntime>

function buildContext(): DaemonContext & { runtime: FakeRuntime } {
  const home = join(tmpdir(), `hobby-branch-${randomUUID()}`)
  homes.push(home)
  return {
    store: openStore(':memory:'),
    runtime: createFakeRuntime(),
    paths: resolvePaths({ HOBBY_HOME: home }),
    config: testConfig(),
    activity: new ActivityTracker(),
    kinds: createDefaultKindRegistry(),
    // Every start in these tests (the source's own, and resume after a
    // quiesce) needs a Postgres that answers; the fake runtime has none.
    probeFactory: () => async (): Promise<boolean> => true,
  }
}

// Never the real pg_stat_activity guard: there is no Postgres to ask.
const IDLE: BranchOptions = { quiesce: { guard: async () => 'idle' } }

async function makeSource(
  ctx: DaemonContext,
  name: string,
  opts: { pinned?: boolean; awake?: boolean } = {}
): Promise<{ project: Project; resource: PostgresResource; pgdata: string }> {
  const project = ctx.store.createProject({ name, sleepAfterSeconds: opts.pinned === true ? null : 300 })
  // The real creation path, so the source's config (port, container name,
  // data dir, password) is exactly what a `hobby new` would have stored.
  let resource = await createPostgres(ctx, { project, name: 'primary' })
  // The fake runtime writes nothing to disk, so stand in for initdb: a file
  // at the true PGDATA (resolvePgdataPath's <mount>/18/docker) and a nested
  // one, which is what a clone has to reproduce.
  const pgdata = resolvePgdataPath(resource.config.dataDir)
  await mkdir(join(pgdata, 'base', '5'), { recursive: true })
  await writeFile(join(pgdata, 'PG_VERSION'), '18\n')
  await writeFile(join(pgdata, 'base', '5', '16384'), 'source row')
  if (opts.awake === true) {
    await ctx.kinds.get('postgres').start(ctx, resource)
    const reloaded = ctx.store.getResource(resource.id)
    assert.ok(reloaded !== null && reloaded.kind === 'postgres')
    resource = reloaded
    assert.equal(resource.state, 'running')
  }
  return { project, resource, pgdata }
}

function branchPostgres(ctx: DaemonContext, name: string): PostgresResource {
  const project = ctx.store.getProjectByName(name)
  assert.ok(project !== null, `project ${name} should exist`)
  const [resource] = ctx.store.listResources(project.id)
  assert.ok(resource !== undefined && resource.kind === 'postgres')
  return resource
}

async function assertRejectsCode(promise: Promise<unknown>, code: string, message?: RegExp): Promise<void> {
  await assert.rejects(promise, (err: unknown) => {
    assert.ok(err instanceof HobbyError, `expected a HobbyError, got ${String(err)}`)
    assert.equal(err.code, code)
    if (message !== undefined) {
      assert.match(err.message, message)
    }
    return true
  })
}

// Nothing was created: no row, no directory, no container, no network.
function assertNoBranch(ctx: DaemonContext & { runtime: FakeRuntime }, name: string): void {
  assert.equal(ctx.store.getProjectByName(name), null)
  assert.equal(existsSync(join(ctx.paths.projectsDir, name)), false)
  assert.equal(ctx.runtime._state.has(`hobby-${name}-primary`), false)
  assert.equal(ctx.runtime._networks.has(`hobby-${name}`), false)
}

test('branching a sleeping source clones its data without starting or stopping it', async () => {
  const ctx = buildContext()
  const { resource: source } = await makeSource(ctx, 'blog')
  const starts: string[] = []
  const originalStart = ctx.runtime.start.bind(ctx.runtime)
  ctx.runtime.start = async (name: string) => {
    starts.push(name)
    await originalStart(name)
  }

  const result = await branchProject(ctx, 'blog', 'blog-exp', IDLE)

  assert.deepEqual(starts, [], 'neither the source nor the branch is started')
  assert.deepEqual(result.paused, [])
  assert.equal(result.pausedMs, null)
  assert.equal(ctx.store.getResource(source.id)?.state, 'sleeping')

  const branch = branchPostgres(ctx, 'blog-exp')
  assert.equal(branch.state, 'sleeping')
  const clonedFile = join(resolvePgdataPath(branch.config.dataDir), 'base', '5', '16384')
  assert.equal(await readFile(clonedFile, 'utf8'), 'source row')
  assert.equal(await readFile(join(resolvePgdataPath(branch.config.dataDir), 'PG_VERSION'), 'utf8'), '18\n')
})

test('a branch is independent: its own container, port, network and data directory', async () => {
  const ctx = buildContext()
  const { resource: source, pgdata: sourcePgdata } = await makeSource(ctx, 'blog')

  await branchProject(ctx, 'blog', 'blog-exp', IDLE)

  const branch = branchPostgres(ctx, 'blog-exp')
  const branchProjectRow = ctx.store.getProjectByName('blog-exp')
  assert.ok(branchProjectRow !== null)

  assert.notEqual(branch.config.containerName, source.config.containerName)
  assert.equal(branch.config.containerName, 'hobby-blog-exp-primary')
  assert.notEqual(branch.config.hostPort, source.config.hostPort)
  assert.notEqual(branch.config.dataDir, source.config.dataDir)
  assert.equal(branch.config.dataDir, ctx.paths.resourcePath('blog-exp', 'primary', 'pgdata'))
  assert.equal(branchProjectRow.networkName, 'hobby-blog-exp')

  // The container the branch will wake into is already created, pointed at
  // the branch's own directory, port and network, and not running.
  const spec = ctx.runtime._specs.get('hobby-blog-exp-primary')
  assert.ok(spec !== undefined)
  assert.equal(spec.binds[0]?.host, branch.config.dataDir)
  assert.equal(spec.ports[0]?.host, branch.config.hostPort)
  assert.equal(spec.network, 'hobby-blog-exp')
  assert.equal(ctx.runtime._state.get('hobby-blog-exp-primary')?.running, false)

  // Credentials and database name are the cluster's own, which the clone
  // carries with it; a new password here would be one Postgres never saw.
  assert.equal(branch.config.password, source.config.password)
  assert.equal(branch.config.superuser, source.config.superuser)
  assert.equal(branch.config.database, source.config.database)

  // And the bytes are separate: writing to the branch leaves the source alone.
  await writeFile(join(resolvePgdataPath(branch.config.dataDir), 'base', '5', '16384'), 'branch row')
  assert.equal(await readFile(join(sourcePgdata, 'base', '5', '16384'), 'utf8'), 'source row')
})

test('branching an awake source quiesces it, clones while stopped, resumes it, and reports the pause', async () => {
  const ctx = buildContext()
  const { resource: source } = await makeSource(ctx, 'blog', { awake: true })

  let runningDuringClone: boolean | undefined
  let clock = 1000
  const result = await branchProject(ctx, 'blog', 'blog-exp', {
    ...IDLE,
    now: () => {
      clock += 250
      return clock
    },
    clone: async (src, dst): Promise<CloneResult> => {
      runningDuringClone = ctx.runtime._state.get(source.config.containerName)?.running
      await cp(src, dst, { recursive: true })
      return { mechanism: 'reflink', files: 0, bytes: 0 }
    },
  })

  assert.equal(runningDuringClone, false, 'the source was stopped while its data was copied')
  assert.equal(ctx.store.getResource(source.id)?.state, 'running', 'and running again afterwards')
  assert.equal(ctx.runtime._state.get(source.config.containerName)?.running, true)
  assert.deepEqual(result.paused, ['primary'])
  assert.equal(result.pausedMs, 250)
  assert.deepEqual(result.resumeFailures, [])
  assert.equal(branchPostgres(ctx, 'blog-exp').state, 'sleeping')
})

test('pinned and awake: refused without allowPause, and nothing is paused or created', async () => {
  const ctx = buildContext()
  const { resource: source } = await makeSource(ctx, 'prod', { pinned: true, awake: true })

  await assertRejectsCode(branchProject(ctx, 'prod', 'prod-exp', IDLE), 'conflict', /pinned awake/)

  assert.equal(ctx.store.getResource(source.id)?.state, 'running')
  assert.equal(ctx.runtime._state.get(source.config.containerName)?.running, true)
  assertNoBranch(ctx, 'prod-exp')
})

test('pinned and awake: allowed with allowPause, and the branch is not pinned', async () => {
  const ctx = buildContext()
  const { resource: source } = await makeSource(ctx, 'prod', { pinned: true, awake: true })

  const result = await branchProject(ctx, 'prod', 'prod-exp', { ...IDLE, allowPause: true })

  assert.deepEqual(result.paused, ['primary'])
  assert.equal(ctx.store.getResource(source.id)?.state, 'running')
  assert.equal(result.project.sleepAfterSeconds, 300)
  assert.equal(ctx.store.getProjectByName('prod-exp')?.sleepAfterSeconds, 300)
  // The source's own pin is untouched.
  assert.equal(ctx.store.getProjectByName('prod')?.sleepAfterSeconds, null)
})

test('pinned but fully asleep: no flag needed, nothing to pause', async () => {
  const ctx = buildContext()
  await makeSource(ctx, 'prod', { pinned: true })

  const result = await branchProject(ctx, 'prod', 'prod-exp', IDLE)

  assert.deepEqual(result.paused, [])
  assert.equal(result.project.sleepAfterSeconds, 300)
})

test('unpinned and awake: no flag needed', async () => {
  const ctx = buildContext()
  await makeSource(ctx, 'blog', { awake: true })

  const result = await branchProject(ctx, 'blog', 'blog-exp', IDLE)

  assert.deepEqual(result.paused, ['primary'])
})

test('a name that is already a project is refused before anything happens', async () => {
  const ctx = buildContext()
  const { resource: source } = await makeSource(ctx, 'blog', { awake: true })
  await makeSource(ctx, 'taken')
  const takenDir = join(ctx.paths.projectsDir, 'taken')

  await assertRejectsCode(branchProject(ctx, 'blog', 'taken', IDLE), 'name_taken')

  assert.equal(ctx.store.getResource(source.id)?.state, 'running', 'the source was not paused')
  assert.equal(existsSync(join(resolvePgdataPath(ctx.paths.resourcePath('taken', 'primary', 'pgdata')), 'PG_VERSION')), true)
  assert.equal(existsSync(takenDir), true, "the existing project's directory is untouched")
})

test('a leftover directory with the branch name is refused and left alone', async () => {
  const ctx = buildContext()
  await makeSource(ctx, 'blog')
  const orphan = join(ctx.paths.projectsDir, 'blog-exp', 'keep.txt')
  await mkdir(join(ctx.paths.projectsDir, 'blog-exp'), { recursive: true })
  await writeFile(orphan, 'not ours')

  await assertRejectsCode(branchProject(ctx, 'blog', 'blog-exp', IDLE), 'conflict', /already exists/)

  assert.equal(await readFile(orphan, 'utf8'), 'not ours')
  assert.equal(ctx.store.getProjectByName('blog-exp'), null)
})

test('an invalid branch name and a missing source are refused', async () => {
  const ctx = buildContext()
  await makeSource(ctx, 'blog')
  await assertRejectsCode(branchProject(ctx, 'blog', 'Not_Valid', IDLE), 'invalid_name')
  await assertRejectsCode(branchProject(ctx, 'nope', 'blog-exp', IDLE), 'project_not_found')
})

test('a failed clone leaves no project, no directory, and the source running again', async () => {
  const ctx = buildContext()
  const { resource: source } = await makeSource(ctx, 'blog', { awake: true })

  await assert.rejects(
    branchProject(ctx, 'blog', 'blog-exp', {
      ...IDLE,
      clone: async (_src, dst) => {
        // Half a clone on disk, then the failure: the cleanup has to remove
        // what landed, not only what finished.
        await mkdir(dst, { recursive: true })
        await writeFile(join(dst, 'partial'), 'x')
        throw new Error('disk full')
      },
    }),
    /disk full/
  )

  assertNoBranch(ctx, 'blog-exp')
  assert.equal(ctx.store.getResource(source.id)?.state, 'running')
  assert.equal(ctx.runtime._state.get(source.config.containerName)?.running, true)
})

test('a failure creating the branch container cleans up the rows, network and cloned files', async () => {
  const ctx = buildContext()
  const { resource: source } = await makeSource(ctx, 'blog')
  const originalEnsureCreated = ctx.runtime.ensureCreated.bind(ctx.runtime)
  ctx.runtime.ensureCreated = async (spec) => {
    if (spec.name === 'hobby-blog-exp-primary') {
      throw new HobbyError('runtime_unavailable', 'docker went away')
    }
    return originalEnsureCreated(spec)
  }

  await assertRejectsCode(branchProject(ctx, 'blog', 'blog-exp', IDLE), 'runtime_unavailable')

  assertNoBranch(ctx, 'blog-exp')
  assert.equal(ctx.store.getResource(source.id)?.state, 'sleeping')
  // The port allocated to the discarded branch is free again, because the
  // row that held it is gone.
  assert.equal(ctx.store.listResources(ctx.store.getProjectByName('blog')!.id).length, 1)
})

test('a source whose container is running despite a sleeping row is refused before cloning', async () => {
  const ctx = buildContext()
  const { resource: source } = await makeSource(ctx, 'blog')
  await ctx.runtime.start(source.config.containerName)
  let cloned = false

  await assertRejectsCode(
    branchProject(ctx, 'blog', 'blog-exp', {
      ...IDLE,
      clone: async () => {
        cloned = true
        return { mechanism: 'reflink', files: 0, bytes: 0 }
      },
    }),
    'conflict',
    /not stopped/
  )
  assert.equal(cloned, false)
  assertNoBranch(ctx, 'blog-exp')
})

test('a source woken while it was being cloned discards the branch', async () => {
  const ctx = buildContext()
  const { resource: source } = await makeSource(ctx, 'blog')

  await assertRejectsCode(
    branchProject(ctx, 'blog', 'blog-exp', {
      ...IDLE,
      clone: async (src, dst) => {
        await cp(src, dst, { recursive: true })
        // A proxy connection arriving mid-copy: the real wake path.
        await ctx.kinds.get('postgres').start(ctx, source)
        return { mechanism: 'reflink', files: 0, bytes: 0 }
      },
    }),
    'conflict',
    /woken while it was being cloned/
  )
  assertNoBranch(ctx, 'blog-exp')
  assert.equal(ctx.store.getResource(source.id)?.state, 'running', 'the wake itself is left alone')
})

test('a wake that came and went during the clone is still caught by lastActiveAt', async () => {
  const ctx = buildContext()
  const { resource: source } = await makeSource(ctx, 'blog')

  await assertRejectsCode(
    branchProject(ctx, 'blog', 'blog-exp', {
      ...IDLE,
      clone: async (src, dst) => {
        await cp(src, dst, { recursive: true })
        const handler = ctx.kinds.get('postgres')
        await handler.start(ctx, source)
        await handler.stop(ctx, source)
        return { mechanism: 'reflink', files: 0, bytes: 0 }
      },
    }),
    'conflict',
    /woken/
  )
  assertNoBranch(ctx, 'blog-exp')
})

test('a source holding anything but postgres is refused, naming what it holds', async () => {
  const ctx = buildContext()
  const { project } = await makeSource(ctx, 'blog')
  ctx.store.createResource({
    projectId: project.id,
    kind: 'queue',
    name: 'jobs',
    config: {
      image: null,
      containerName: '',
      hostPort: 0,
      retentionSeconds: 345600,
      consumerResourceId: null,
      maxBatchSize: null,
      maxBatchTimeoutSeconds: null,
      maxRetries: null,
      retryDelaySeconds: null,
      deadLetterQueue: null,
    },
  })

  await assertRejectsCode(branchProject(ctx, 'blog', 'blog-exp', IDLE), 'usage', /jobs \(queue\)/)
  assertNoBranch(ctx, 'blog-exp')
})

test('a source mid-transition is refused', async () => {
  const ctx = buildContext()
  const { resource } = await makeSource(ctx, 'blog')
  ctx.store.setResourceState(resource.id, 'starting')

  await assertRejectsCode(branchProject(ctx, 'blog', 'blog-exp', IDLE), 'conflict', /primary is starting/)
  assertNoBranch(ctx, 'blog-exp')
})

test('a released source is refused', async () => {
  const ctx = buildContext()
  const { project } = await makeSource(ctx, 'blog')
  ctx.store.setProjectReleased(project.id, new Date())

  await assertRejectsCode(branchProject(ctx, 'blog', 'blog-exp', IDLE), 'conflict', /released/)
  assertNoBranch(ctx, 'blog-exp')
})

test('the ext4 path: a byte-copy clone is reported as copy', async () => {
  const ctx = buildContext()
  await makeSource(ctx, 'blog')

  const result = await branchProject(ctx, 'blog', 'blog-exp', {
    ...IDLE,
    clone: async (src, dst): Promise<CloneResult> => {
      await cp(src, dst, { recursive: true })
      return { mechanism: 'copy', files: 2, bytes: 13 }
    },
  })

  assert.equal(result.clone, 'copy')
  const branch = branchPostgres(ctx, 'blog-exp')
  assert.equal(await readFile(join(resolvePgdataPath(branch.config.dataDir), 'base', '5', '16384'), 'utf8'), 'source row')
})

// The route: body parsing and the pinned guard over HTTP, the shape Studio
// and MCP both reach it through.
async function post(ctx: DaemonContext, path: string, body: unknown): Promise<{ status: number; body: any }> {
  const server = createServer(createApp(ctx))
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const { port } = server.address() as AddressInfo
  try {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    return { status: res.status, body: await res.json() }
  } finally {
    const closed = new Promise<void>((resolve) => server.close(() => resolve()))
    server.closeAllConnections()
    await closed
  }
}

test('POST /v1/projects/:name/branch creates the branch and reports it', async () => {
  const ctx = buildContext()
  await makeSource(ctx, 'blog')

  const res = await post(ctx, '/v1/projects/blog/branch', { name: 'blog-exp' })

  assert.equal(res.status, 201)
  assert.equal(res.body.project.name, 'blog-exp')
  assert.equal(res.body.resources.length, 1)
  assert.equal(res.body.resources[0].state, 'sleeping')
  assert.equal('password' in res.body.resources[0].config, false, 'the wire shape never carries the password')
  assert.deepEqual(res.body.paused, [])
  assert.equal(res.body.pausedMs, null)
})

test('POST /v1/projects/:name/branch enforces the pinned guard and a boolean allowPause', async () => {
  const ctx = buildContext()
  await makeSource(ctx, 'prod', { pinned: true, awake: true })

  const refused = await post(ctx, '/v1/projects/prod/branch', { name: 'prod-exp' })
  assert.equal(refused.status, 409)
  assert.equal(refused.body.error.code, 'conflict')
  assert.match(refused.body.error.hint, /--allow-pause/)

  const loose = await post(ctx, '/v1/projects/prod/branch', { name: 'prod-exp', allowPause: 'true' })
  assert.equal(loose.status, 400)

  const missing = await post(ctx, '/v1/projects/prod/branch', {})
  assert.equal(missing.status, 400)
  assert.equal(ctx.store.getProjectByName('prod-exp'), null)
})

// The CLI verb against a fake Api.
function cliCtx(response: BranchResponse): { ctx: Ctx; calls: unknown[]; out: string[]; err: string[] } {
  const calls: unknown[] = []
  const out: string[] = []
  const err: string[] = []
  const api = {
    async branchProject(source: string, name: string, opts?: { allowPause?: boolean }) {
      calls.push({ source, name, opts })
      return response
    },
  }
  const ctx = {
    io: { out: (s: string) => out.push(s), err: (s: string) => err.push(s), env: {}, cwd: '/tmp', readLine: async () => '' },
    api: api as unknown as Api,
    paths: {} as Ctx['paths'],
    config: {} as Ctx['config'],
  } as Ctx
  return { ctx, calls, out, err }
}

function response(overrides: Partial<BranchResponse> = {}): BranchResponse {
  return {
    project: { id: 'p2', name: 'blog-exp', networkName: 'hobby-blog-exp', sleepAfterSeconds: 300, createdAt: new Date(), releasedAt: null },
    resources: [],
    clone: 'reflink',
    paused: [],
    pausedMs: null,
    resumeFailures: [],
    ...overrides,
  }
}

test('hobby branch passes --allow-pause through only when given', async () => {
  const plain = cliCtx(response())
  await cmdBranch(plain.ctx, ['blog', 'blog-exp'], {})
  assert.deepEqual(plain.calls, [{ source: 'blog', name: 'blog-exp', opts: { allowPause: false } }])

  const allowed = cliCtx(response())
  await cmdBranch(allowed.ctx, ['blog', 'blog-exp'], { 'allow-pause': true })
  assert.deepEqual(allowed.calls, [{ source: 'blog', name: 'blog-exp', opts: { allowPause: true } }])
})

test('hobby branch prints the ext4 note on a copy, and the pause when there was one', async () => {
  const copied = cliCtx(response({ clone: 'copy', paused: ['primary'], pausedMs: 812 }))
  await cmdBranch(copied.ctx, ['blog', 'blog-exp'], {})
  assert.deepEqual(copied.err, [branchCopyNote()])
  assert.ok(copied.out.some((line) => line.includes('paused for 812ms')))

  const instant = cliCtx(response())
  await cmdBranch(instant.ctx, ['blog', 'blog-exp'], {})
  assert.deepEqual(instant.err, [])
})

test('hobby branch needs exactly two names', async () => {
  const { ctx } = cliCtx(response())
  await assert.rejects(cmdBranch(ctx, ['blog'], {}), UsageError)
  await assert.rejects(cmdBranch(ctx, ['blog', 'a', 'b'], {}), UsageError)
})
