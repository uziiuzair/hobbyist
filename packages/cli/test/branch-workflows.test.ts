// Branch workflows (2026-11-17): reset to parent, expiry, and schema diff,
// against the fake runtime and a real temporary HOBBY_HOME, the setup
// branch.test.ts uses. Data directories are real files, so "the branch now
// holds the parent's data" is checked on disk.

import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { existsSync, rmSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
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
  type HobbyConfig,
  type PostgresResource,
  type Project,
} from '@hobby.sh/core'
import { createPostgres } from '@hobby.sh/pg'
import { ActivityTracker } from '@hobby.sh/proxy'
import { createDefaultKindRegistry, holdProjectAsleep, type DaemonContext } from '../src/daemon/context.js'
import { branchProject } from '../src/daemon/branch.js'
import { resetBranch, type ResetOptions } from '../src/daemon/reset.js'
import { parseExpiresInSeconds, setBranchExpiry, sweepExpiredBranches } from '../src/daemon/expiry.js'
import { diffSchemas, normalizeDump, pgDumpSchemaCommand } from '../src/daemon/schema-diff.js'
import { diffLines, renderUnified, toHunks } from '../src/daemon/unified-diff.js'
import { deleteProject } from '../src/daemon/routes.js'
import { branchTrailer, cmdDiff, cmdExpire, cmdReset, createApp, parseDuration, renderDuration, UsageError, type Ctx } from '../src/index.js'
import type { Api } from '../src/cli/client.js'

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

type FakeRuntime = ReturnType<typeof createFakeRuntime>

function buildContext(): DaemonContext & { runtime: FakeRuntime } {
  const home = join(tmpdir(), `hobby-branchwf-${randomUUID()}`)
  homes.push(home)
  return {
    store: openStore(':memory:'),
    runtime: createFakeRuntime(),
    paths: resolvePaths({ HOBBY_HOME: home }),
    config: testConfig(),
    activity: new ActivityTracker(),
    kinds: createDefaultKindRegistry(),
    probeFactory: () => async (): Promise<boolean> => true,
  }
}

const IDLE: ResetOptions = { quiesce: { guard: async () => 'idle' } }

async function makeSource(ctx: DaemonContext, name: string, opts: { pinned?: boolean } = {}): Promise<{ project: Project; resource: PostgresResource }> {
  const project = ctx.store.createProject({ name, sleepAfterSeconds: opts.pinned === true ? null : 300 })
  const resource = await createPostgres(ctx, { project, name: 'primary' })
  const pgdata = resolvePgdataPath(resource.config.dataDir)
  await mkdir(join(pgdata, 'base'), { recursive: true })
  await writeFile(join(pgdata, 'PG_VERSION'), '18\n')
  await writeFile(join(pgdata, 'base', 'row'), 'parent v1')
  return { project, resource }
}

function pg(ctx: DaemonContext, project: string): PostgresResource {
  const p = ctx.store.getProjectByName(project)
  assert.ok(p !== null)
  const [resource] = ctx.store.listResources(p.id)
  assert.ok(resource !== undefined && resource.kind === 'postgres')
  return resource
}

async function rowOf(resource: PostgresResource): Promise<string> {
  return readFile(join(resolvePgdataPath(resource.config.dataDir), 'base', 'row'), 'utf8')
}

async function setRow(resource: PostgresResource, value: string): Promise<void> {
  await writeFile(join(resolvePgdataPath(resource.config.dataDir), 'base', 'row'), value)
}

async function wakeRes(ctx: DaemonContext, resource: PostgresResource): Promise<void> {
  const current = ctx.store.getResource(resource.id)
  assert.ok(current !== null)
  await ctx.kinds.get('postgres').start(ctx, current)
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

async function post(ctx: DaemonContext, path: string, body: unknown): Promise<{ status: number; body: any }> {
  const server = createServer(createApp(ctx))
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
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

// ---------------------------------------------------------------- parent link

test('a branch records its parent by id, and an expiry only when asked', async () => {
  const ctx = buildContext()
  const { project: blog } = await makeSource(ctx, 'blog')
  const plain = await branchProject(ctx, 'blog', 'blog-a')
  assert.equal(plain.project.parentId, blog.id)
  assert.equal(plain.project.expiresAt, null)
  assert.equal(ctx.store.getProjectByName('blog-a')?.parentId, blog.id)

  const at = new Date(Date.now() + 3600_000)
  const expiring = await branchProject(ctx, 'blog', 'blog-b', { expiresAt: at })
  assert.deepEqual(ctx.store.getProject(expiring.project.id)?.expiresAt, at)
})

test('POST /v1/projects/:name/branch takes expiresInSeconds on the daemon clock and validates it', async () => {
  const ctx = buildContext()
  await makeSource(ctx, 'blog')
  const before = Date.now()
  const ok = await post(ctx, '/v1/projects/blog/branch', { name: 'blog-exp', expiresInSeconds: 7 * 86400 })
  assert.equal(ok.status, 201)
  const expiresAt = new Date(ok.body.project.expiresAt).getTime()
  assert.ok(expiresAt >= before + 7 * 86400_000 && expiresAt <= Date.now() + 7 * 86400_000)

  for (const bad of [0, -5, 1.5, '7d', 20 * 365 * 86400]) {
    const res = await post(ctx, '/v1/projects/blog/branch', { name: 'blog-bad', expiresInSeconds: bad })
    assert.equal(res.status, 400, `expiresInSeconds ${String(bad)} must be refused`)
  }
  assert.equal(ctx.store.getProjectByName('blog-bad'), null, 'a refused expiry creates no branch')
})

// ---------------------------------------------------------------- reset

test('reset replaces the branch data with the parent current data, keeping name, port, ids and container', async () => {
  const ctx = buildContext()
  const { resource: parent } = await makeSource(ctx, 'blog')
  await branchProject(ctx, 'blog', 'blog-exp')
  const before = pg(ctx, 'blog-exp')
  await setRow(before, 'branch edit')
  await setRow(parent, 'parent v2')

  const result = await resetBranch(ctx, 'blog-exp', IDLE)

  const after = pg(ctx, 'blog-exp')
  assert.equal(await rowOf(after), 'parent v2')
  assert.equal(await rowOf(parent), 'parent v2', 'the parent is only read')
  assert.equal(after.id, before.id)
  assert.equal(after.config.hostPort, before.config.hostPort)
  assert.equal(after.config.containerName, before.config.containerName)
  assert.equal(after.config.dataDir, before.config.dataDir)
  assert.equal(after.config.password, parent.config.password)
  assert.equal(after.state, 'sleeping')
  assert.ok(ctx.runtime._specs.has(after.config.containerName), 'the container exists again, stopped')
  assert.equal(result.parent.name, 'blog')
  assert.deepEqual(result.paused, [])
  assert.deepEqual(result.parentPaused, [])
  assert.deepEqual(result.preResetDirs, [])
  assert.equal(existsSync(`${after.config.dataDir}.pre-reset`), false, 'the replaced data is removed on success')
  assert.equal(existsSync(`${after.config.dataDir}.reset-staging`), false)
})

test('reset takes the parent credentials and image when they changed since the branch', async () => {
  const ctx = buildContext()
  const { resource: parent } = await makeSource(ctx, 'blog')
  await branchProject(ctx, 'blog', 'blog-exp')
  ctx.store.updateResourceConfig(parent.id, { ...parent.config, password: 'rotated', image: 'postgres:18.1-alpine' })

  await resetBranch(ctx, 'blog-exp', IDLE)

  const after = pg(ctx, 'blog-exp')
  assert.equal(after.config.password, 'rotated')
  assert.equal(after.config.image, 'postgres:18.1-alpine')
  assert.equal(ctx.runtime._specs.get(after.config.containerName)?.image, 'postgres:18.1-alpine')
})

test('an awake branch is quiesced, swapped, resumed, and its pause reported', async () => {
  const ctx = buildContext()
  await makeSource(ctx, 'blog')
  await branchProject(ctx, 'blog', 'blog-exp')
  await wakeRes(ctx, pg(ctx, 'blog-exp'))

  const result = await resetBranch(ctx, 'blog-exp', IDLE)

  assert.deepEqual(result.paused, ['primary'])
  assert.equal(typeof result.pausedMs, 'number')
  assert.equal(pg(ctx, 'blog-exp').state, 'running', 'what was running is running again, on the new data')
  assert.deepEqual(result.restartFailures, [])
})

test('an awake parent is paused for the clone and resumed, as hobby branch does', async () => {
  const ctx = buildContext()
  const { resource: parent } = await makeSource(ctx, 'blog')
  await branchProject(ctx, 'blog', 'blog-exp')
  await wakeRes(ctx, parent)

  const result = await resetBranch(ctx, 'blog-exp', IDLE)
  assert.deepEqual(result.parentPaused, ['primary'])
  assert.equal(typeof result.parentPausedMs, 'number')
  assert.equal(pg(ctx, 'blog').state, 'running')
})

test('a pinned awake parent or branch is refused without allowPause, and allowed with it', async () => {
  const ctx = buildContext()
  const { resource: parent, project } = await makeSource(ctx, 'blog')
  await branchProject(ctx, 'blog', 'blog-exp')
  ctx.store.setProjectSleepAfterSeconds(project.id, null)
  await wakeRes(ctx, parent)
  await assertRejectsCode(resetBranch(ctx, 'blog-exp', IDLE), 'conflict', /pinned awake/)
  assert.equal(pg(ctx, 'blog').state, 'running', 'nothing was paused by the refusal')
  await resetBranch(ctx, 'blog-exp', { ...IDLE, allowPause: true })

  // Now the other side: an unpinned parent, a pinned awake branch.
  ctx.store.setProjectSleepAfterSeconds(project.id, 300)
  const branch = ctx.store.getProjectByName('blog-exp') as Project
  ctx.store.setProjectSleepAfterSeconds(branch.id, null)
  await wakeRes(ctx, pg(ctx, 'blog-exp'))
  await assertRejectsCode(resetBranch(ctx, 'blog-exp', IDLE), 'conflict', /blog-exp is pinned awake/)
})

test('reset refuses a project with no parent, a parent that is gone, and mismatched resources', async () => {
  const ctx = buildContext()
  const { project: blog } = await makeSource(ctx, 'blog')
  await assertRejectsCode(resetBranch(ctx, 'blog', IDLE), 'conflict', /no recorded parent/)
  await assertRejectsCode(resetBranch(ctx, 'nope', IDLE), 'project_not_found')

  await branchProject(ctx, 'blog', 'blog-exp')
  const branch = ctx.store.getProjectByName('blog-exp') as Project
  await createPostgres(ctx, { project: branch, name: 'extra' })
  await assertRejectsCode(resetBranch(ctx, 'blog-exp', IDLE), 'conflict', /only in blog-exp: extra/)

  await branchProject(ctx, 'blog', 'blog-two')
  await deleteProject(ctx, 'blog')
  assert.equal(ctx.store.getProject(blog.id), null)
  await assertRejectsCode(resetBranch(ctx, 'blog-two', IDLE), 'conflict', /no longer exists/)
})

test('a busy branch (activity guard) is refused, and its data is left untouched', async () => {
  const ctx = buildContext()
  const { resource: parent } = await makeSource(ctx, 'blog')
  await branchProject(ctx, 'blog', 'blog-exp')
  await setRow(pg(ctx, 'blog-exp'), 'branch edit')
  await setRow(parent, 'parent v2')
  await wakeRes(ctx, pg(ctx, 'blog-exp'))

  await assertRejectsCode(
    resetBranch(ctx, 'blog-exp', { quiesce: { guard: async () => 'active', attempts: 2, sleepFor: async () => {} } }),
    'conflict',
    /still active/
  )
  assert.equal(await rowOf(pg(ctx, 'blog-exp')), 'branch edit')
  assert.equal(pg(ctx, 'blog-exp').state, 'running')
  assert.equal(existsSync(`${pg(ctx, 'blog-exp').config.dataDir}.reset-staging`), false, 'staging is removed')
})

test('a failed clone leaves the branch untouched and no staging behind', async () => {
  const ctx = buildContext()
  await makeSource(ctx, 'blog')
  await branchProject(ctx, 'blog', 'blog-exp')
  await setRow(pg(ctx, 'blog-exp'), 'branch edit')
  await assert.rejects(
    resetBranch(ctx, 'blog-exp', {
      ...IDLE,
      clone: async (_src, dst) => {
        await mkdir(dst, { recursive: true })
        throw new Error('disk full')
      },
    }),
    /disk full/
  )
  assert.equal(await rowOf(pg(ctx, 'blog-exp')), 'branch edit')
  assert.equal(existsSync(`${pg(ctx, 'blog-exp').config.dataDir}.reset-staging`), false)
})

test('a leftover pre-reset directory is refused and never deleted', async () => {
  const ctx = buildContext()
  await makeSource(ctx, 'blog')
  await branchProject(ctx, 'blog', 'blog-exp')
  const aside = `${pg(ctx, 'blog-exp').config.dataDir}.pre-reset`
  await mkdir(aside, { recursive: true })
  await writeFile(join(aside, 'keep'), 'only copy')
  await assertRejectsCode(resetBranch(ctx, 'blog-exp', IDLE), 'conflict', /already exists/)
  assert.equal(await readFile(join(aside, 'keep'), 'utf8'), 'only copy')
})

test('a branch held by a snapshot or restore is refused', async () => {
  const ctx = buildContext()
  await makeSource(ctx, 'blog')
  await branchProject(ctx, 'blog', 'blog-exp')
  const branch = ctx.store.getProjectByName('blog-exp') as Project
  const release = holdProjectAsleep(ctx, branch.id, branch.name)
  try {
    await assertRejectsCode(resetBranch(ctx, 'blog-exp', IDLE), 'conflict', /already in progress/)
  } finally {
    release()
  }
})

test('POST /v1/projects/:name/reset resets and enforces a boolean allowPause', async () => {
  const ctx = buildContext()
  const { resource: parent } = await makeSource(ctx, 'blog')
  await branchProject(ctx, 'blog', 'blog-exp')
  await setRow(parent, 'parent v2')
  const res = await post(ctx, '/v1/projects/blog-exp/reset', {})
  assert.equal(res.status, 200)
  assert.equal(res.body.parent, 'blog')
  assert.equal('password' in res.body.resources[0].config, false)
  assert.equal(await rowOf(pg(ctx, 'blog-exp')), 'parent v2')

  const loose = await post(ctx, '/v1/projects/blog-exp/reset', { allowPause: 'yes' })
  assert.equal(loose.status, 400)
})

// ---------------------------------------------------------------- expiry

function collectLog(): { lines: string[]; log: (line: string) => void } {
  const lines: string[] = []
  return { lines, log: (line) => lines.push(line) }
}

test('the sweep deletes an expired sleeping branch, with one log line, and leaves the rest', async () => {
  const ctx = buildContext()
  await makeSource(ctx, 'blog')
  await branchProject(ctx, 'blog', 'gone', { expiresAt: new Date(1000) })
  await branchProject(ctx, 'blog', 'later', { expiresAt: new Date(Date.now() + 86400_000) })
  await branchProject(ctx, 'blog', 'never')
  // A project that is not a branch is never deleted by a timer, even with
  // an expiry somehow in the store.
  const odd = ctx.store.createProject({ name: 'odd', sleepAfterSeconds: 300, expiresAt: new Date(1000) })

  const { lines, log } = collectLog()
  const result = await sweepExpiredBranches(ctx, Date.now(), { remove: deleteProject, log })

  assert.deepEqual(result.deleted, ['gone'])
  assert.equal(ctx.store.getProjectByName('gone'), null)
  assert.equal(existsSync(join(ctx.paths.projectsDir, 'gone')), false)
  for (const kept of ['blog', 'later', 'never', 'odd']) {
    assert.ok(ctx.store.getProjectByName(kept) !== null, `${kept} must survive`)
  }
  assert.equal(ctx.store.getProject(odd.id)?.name, 'odd')
  assert.equal(lines.length, 1)
  assert.match(lines[0] as string, /^expiry: deleted branch gone \(expired at 1970-01-01T00:00:01.000Z\)$/)
})

test('an expired branch that is pinned or awake is skipped, logged once, and deleted once it is neither', async () => {
  const ctx = buildContext()
  await makeSource(ctx, 'blog')
  await branchProject(ctx, 'blog', 'pinned', { expiresAt: new Date(1000) })
  await branchProject(ctx, 'blog', 'awake', { expiresAt: new Date(1000) })
  const pinned = ctx.store.getProjectByName('pinned') as Project
  ctx.store.setProjectSleepAfterSeconds(pinned.id, null)
  await wakeRes(ctx, pg(ctx, 'awake'))
  const starts = ctx.runtime._state.size

  const logged = new Map()
  const { lines, log } = collectLog()
  const first = await sweepExpiredBranches(ctx, Date.now(), { remove: deleteProject, log, logged })
  const second = await sweepExpiredBranches(ctx, Date.now(), { remove: deleteProject, log, logged })

  assert.deepEqual(first.deleted, [])
  assert.deepEqual(
    first.skipped.map((s) => `${s.name}:${s.reason}`).sort(),
    ['awake:awake', 'pinned:pinned']
  )
  assert.equal(second.skipped.length, 2)
  assert.equal(lines.length, 2, 'each skip is logged once, not every sweep')
  assert.equal(pg(ctx, 'awake').state, 'running', 'nothing was stopped')
  assert.equal(ctx.runtime._state.size, starts)

  await ctx.kinds.get('postgres').stop(ctx, pg(ctx, 'awake'))
  const third = await sweepExpiredBranches(ctx, Date.now(), { remove: deleteProject, log, logged })
  assert.deepEqual(third.deleted, ['awake'])
})

test('the sweep never wakes anything, and skips a branch with an open proxied connection', async () => {
  const ctx = buildContext()
  await makeSource(ctx, 'blog')
  await branchProject(ctx, 'blog', 'busy', { expiresAt: new Date(1000) })
  const handle = ctx.activity.open(pg(ctx, 'busy').id)
  let started = 0
  const originalStart = ctx.runtime.start.bind(ctx.runtime)
  ctx.runtime.start = async (name: string) => {
    started += 1
    await originalStart(name)
  }
  const result = await sweepExpiredBranches(ctx, Date.now(), { remove: deleteProject, log: () => {} })
  assert.deepEqual(result.skipped, [{ name: 'busy', reason: 'awake' }])
  ctx.activity.close(handle)
  const again = await sweepExpiredBranches(ctx, Date.now(), { remove: deleteProject, log: () => {} })
  assert.deepEqual(again.deleted, ['busy'])
  assert.equal(started, 0)
})

test('a held expired branch is skipped rather than deleted under a snapshot', async () => {
  const ctx = buildContext()
  await makeSource(ctx, 'blog')
  await branchProject(ctx, 'blog', 'held', { expiresAt: new Date(1000) })
  const held = ctx.store.getProjectByName('held') as Project
  const release = holdProjectAsleep(ctx, held.id, held.name)
  try {
    const result = await sweepExpiredBranches(ctx, Date.now(), { remove: deleteProject, log: () => {} })
    assert.deepEqual(result.skipped, [{ name: 'held', reason: 'held' }])
  } finally {
    release()
  }
})

test('setting and clearing an expiry: branches only, and a required field', async () => {
  const ctx = buildContext()
  await makeSource(ctx, 'blog')
  await branchProject(ctx, 'blog', 'blog-exp')

  assert.throws(() => setBranchExpiry(ctx, 'blog', 60, Date.now()), /not created as a branch/)
  const set = setBranchExpiry(ctx, 'blog-exp', 60, 1_000_000)
  assert.equal(set.expiresAt?.getTime(), 1_060_000)
  assert.equal(setBranchExpiry(ctx, 'blog-exp', null, 0).expiresAt, null)

  const viaRoute = await post(ctx, '/v1/projects/blog-exp/expiry', { expiresInSeconds: 3600 })
  assert.equal(viaRoute.status, 200)
  assert.ok(viaRoute.body.project.expiresAt !== null)
  assert.equal((await post(ctx, '/v1/projects/blog-exp/expiry', {})).status, 400)
  assert.equal((await post(ctx, '/v1/projects/blog/expiry', { expiresInSeconds: 60 })).status, 400)
  const cleared = await post(ctx, '/v1/projects/blog-exp/expiry', { expiresInSeconds: null })
  assert.equal(cleared.body.project.expiresAt, null)
  assert.equal(parseExpiresInSeconds(undefined, 'r'), undefined)
})

// ---------------------------------------------------------------- diff

const SCHEMA_A = [
  '--',
  '-- PostgreSQL database dump',
  '--',
  '',
  '\\restrict AAAA',
  '-- Dumped from database version 18.0',
  '-- Dumped by pg_dump version 18.0',
  'CREATE TABLE public.posts (',
  '    id integer NOT NULL,',
  '    title text',
  ');',
  '',
  '\\unrestrict AAAA',
  '',
].join('\n')

const SCHEMA_B = SCHEMA_A.replace('AAAA', 'BBBB').replace('AAAA', 'BBBB').replace('    title text', '    title text,\n    body text')

function dumpsBy(ctx: DaemonContext & { runtime: FakeRuntime }, byContainer: Record<string, string>): void {
  ctx.runtime._exec.handler = (call) => ({ stdout: Buffer.from(byContainer[call.name] ?? '') })
}

test('diff wakes sleeping databases, dumps them as hobby, and diffs the normalized schemas', async () => {
  const ctx = buildContext()
  await makeSource(ctx, 'blog')
  await branchProject(ctx, 'blog', 'blog-exp')
  dumpsBy(ctx, { 'hobby-blog-primary': SCHEMA_A, 'hobby-blog-exp-primary': SCHEMA_B })

  const result = await diffSchemas(ctx, 'blog-exp', undefined)

  assert.deepEqual(result.woke.sort(), ['blog-exp/primary', 'blog/primary'])
  assert.equal(result.identical, false)
  assert.equal(result.old.project, 'blog')
  assert.equal(result.new.project, 'blog-exp')
  const [primary] = result.resources
  assert.ok(primary !== undefined)
  assert.equal(primary.status, 'changed')
  assert.equal(
    primary.diff,
    [
      '--- blog/primary',
      '+++ blog-exp/primary',
      '@@ -4,5 +4,6 @@',
      ' ',
      ' CREATE TABLE public.posts (',
      '     id integer NOT NULL,',
      '-    title text',
      '+    title text,',
      '+    body text',
      ' );',
      '',
    ].join('\n')
  )
  // The dump session is the one the activity guard ignores, and nothing
  // touched the proxy's connection count.
  for (const call of ctx.runtime._exec.calls) {
    assert.equal(call.command[0], 'pg_dump')
    assert.ok(call.command.includes('--schema-only'))
    assert.match(call.command.join(' '), /application_name='hobby'/)
    assert.match(call.command.join(' '), /host='\/var\/run\/postgresql'/)
  }
  assert.equal(ctx.activity.count(pg(ctx, 'blog').id), 0)
})

test('identical schemas differ only in pg_dump noise, and report no difference', async () => {
  const ctx = buildContext()
  await makeSource(ctx, 'blog')
  await branchProject(ctx, 'blog', 'blog-exp')
  dumpsBy(ctx, { 'hobby-blog-primary': SCHEMA_A, 'hobby-blog-exp-primary': SCHEMA_A.replace(/AAAA/g, 'CCCC').replace('18.0', '18.1') })
  const result = await diffSchemas(ctx, 'blog-exp', undefined)
  assert.equal(result.identical, true)
  assert.equal(result.resources[0]?.status, 'same')
  assert.equal(result.resources[0]?.diff, '')
})

test('diff between two named projects, a missing resource, and the refusals', async () => {
  const ctx = buildContext()
  await makeSource(ctx, 'one')
  const { project: two } = await makeSource(ctx, 'two')
  await createPostgres(ctx, { project: two, name: 'extra' })
  dumpsBy(ctx, { 'hobby-one-primary': SCHEMA_A, 'hobby-two-primary': SCHEMA_A })

  const result = await diffSchemas(ctx, 'two', 'one')
  assert.deepEqual(
    result.resources.map((r) => `${r.name}:${r.status}`),
    ['extra:only-new', 'primary:same']
  )
  assert.equal(result.identical, false)
  assert.ok(!result.woke.includes('two/extra'), 'a resource with nothing to compare against is not woken')

  await assertRejectsCode(diffSchemas(ctx, 'one', undefined), 'usage', /no recorded parent/)
  await assertRejectsCode(diffSchemas(ctx, 'one', 'one'), 'usage')
  await assertRejectsCode(diffSchemas(ctx, 'one', 'nope'), 'project_not_found')
})

test('a failing pg_dump fails the diff with its stderr', async () => {
  const ctx = buildContext()
  await makeSource(ctx, 'blog')
  await branchProject(ctx, 'blog', 'blog-exp')
  ctx.runtime._exec.handler = () => ({ stdout: Buffer.from(''), error: 'pg_dump: error: connection failed' })
  await assert.rejects(diffSchemas(ctx, 'blog-exp', undefined), (err: unknown) => {
    assert.ok(err instanceof HobbyError)
    assert.match(err.message, /pg_dump of primary failed/)
    return true
  })
})

test('POST /v1/projects/:name/diff takes an optional against', async () => {
  const ctx = buildContext()
  await makeSource(ctx, 'blog')
  await branchProject(ctx, 'blog', 'blog-exp')
  dumpsBy(ctx, { 'hobby-blog-primary': SCHEMA_A, 'hobby-blog-exp-primary': SCHEMA_B })
  const res = await post(ctx, '/v1/projects/blog-exp/diff', {})
  assert.equal(res.status, 200)
  assert.equal(res.body.resources[0].status, 'changed')
  assert.equal((await post(ctx, '/v1/projects/blog-exp/diff', { against: 5 })).status, 400)
})

test('pgDumpSchemaCommand quotes conninfo values and normalizeDump drops only the noise', () => {
  const cmd = pgDumpSchemaCommand({ superuser: "o'brien", database: 'blog' })
  assert.equal(cmd.at(-1), `--dbname=host='/var/run/postgresql' user='o\\'brien' dbname='blog' application_name='hobby'`)
  assert.deepEqual(normalizeDump('a\r\n\\restrict x\n-- Dumped by pg_dump version 18\nb\n\n'), ['a', 'b'])
})

// ---------------------------------------------------------------- unified diff

test('the line diff reconstructs both inputs and finds a minimal edit', () => {
  let seed = 7
  const rand = (n: number): number => {
    seed = (seed * 1103515245 + 12345) % 2147483648
    return seed % n
  }
  for (let round = 0; round < 200; round++) {
    const a = Array.from({ length: rand(12) }, () => String.fromCharCode(97 + rand(4)))
    const b = Array.from({ length: rand(12) }, () => String.fromCharCode(97 + rand(4)))
    const edit = diffLines(a, b)
    assert.deepEqual(edit.filter((l) => l.op !== '+').map((l) => l.text), a)
    assert.deepEqual(edit.filter((l) => l.op !== '-').map((l) => l.text), b)
  }
  assert.equal(diffLines(['x', 'y', 'z'], ['x', 'q', 'z']).filter((l) => l.op !== ' ').length, 2)
  assert.deepEqual(toHunks(diffLines(['a'], ['a'])), [])
  assert.equal(renderUnified('o', 'n', []), '')
})

test('hunks carry three lines of context, merge when close, and number lines like diff -u', () => {
  const a = Array.from({ length: 20 }, (_, i) => `l${i + 1}`)
  const b = [...a]
  b[1] = 'changed2'
  b[16] = 'changed17'
  const far = toHunks(diffLines(a, b))
  assert.equal(far.length, 2)
  assert.deepEqual([far[0]?.oldStart, far[0]?.oldLines, far[0]?.newStart, far[0]?.newLines], [1, 5, 1, 5])
  assert.deepEqual([far[1]?.oldStart, far[1]?.oldLines], [14, 7])

  const near = [...a]
  near[4] = 'x'
  near[8] = 'y'
  assert.equal(toHunks(diffLines(a, near)).length, 1)

  // Pure insertion into an empty file: the old side starts at 0.
  const inserted = toHunks(diffLines([], ['new']))
  assert.deepEqual([inserted[0]?.oldStart, inserted[0]?.oldLines, inserted[0]?.newStart, inserted[0]?.newLines], [0, 0, 1, 1])
})

// ---------------------------------------------------------------- CLI

test('parseDuration reads what renderDuration writes, and refuses everything else', () => {
  for (const seconds of [1, 59, 60, 90, 3600, 5400, 86400, 345600, 604800]) {
    assert.equal(parseDuration(renderDuration(seconds)), seconds)
  }
  assert.equal(parseDuration('7d'), 604800)
  assert.equal(parseDuration('1d12h'), 129600)
  assert.equal(parseDuration('2w'), 1209600)
  assert.equal(parseDuration('120'), 120)
  for (const bad of ['', '0', '0d', '7 days', '-1d', '1.5h', 'd', '7x']) {
    assert.equal(parseDuration(bad), null, `${bad} must not parse`)
  }
})

test('branchTrailer names the parent and the expiry, and nothing for a plain project', () => {
  const now = Date.parse('2026-11-17T00:00:00Z')
  assert.equal(branchTrailer({ parentId: null, expiresAt: null }, null, now), '')
  assert.equal(branchTrailer({}, null, now), '', 'an older daemon sends neither field')
  assert.equal(branchTrailer({ parentId: 'p', expiresAt: null }, 'blog', now), '  (branch of blog)')
  assert.equal(
    branchTrailer({ parentId: 'p', expiresAt: '2026-11-24T00:00:00Z' }, null, now),
    '  (branch, parent removed, expires in 7d)'
  )
  assert.match(branchTrailer({ parentId: 'p', expiresAt: '2026-11-16T00:00:00Z' }, 'blog', now), /expired/)
})

function cliCtx(api: Partial<Api>, typed = ''): { ctx: Ctx; out: string[]; err: string[] } {
  const out: string[] = []
  const err: string[] = []
  const ctx = {
    io: { out: (s: string) => out.push(s), err: (s: string) => err.push(s), env: {}, cwd: '/tmp', readLine: async () => typed },
    api: api as Api,
    paths: {} as Ctx['paths'],
    config: {} as Ctx['config'],
  } as Ctx
  return { ctx, out, err }
}

test('hobby reset asks for the branch name, and makes no request when it does not match', async () => {
  const calls: unknown[] = []
  const resetBranchFake = async (name: string, opts?: { allowPause?: boolean }) => {
    calls.push({ name, opts })
    return {
      project: {} as Project,
      parent: 'blog',
      resources: [],
      clone: 'reflink' as const,
      parentPaused: [],
      parentPausedMs: null,
      parentResumeFailures: [],
      paused: [],
      pausedMs: null,
      restartFailures: [],
      preResetDirs: [],
    }
  }
  const wrong = cliCtx({ resetBranch: resetBranchFake }, 'blog')
  assert.equal(await cmdReset(wrong.ctx, ['blog-exp'], {}), 1)
  assert.deepEqual(calls, [])

  const right = cliCtx({ resetBranch: resetBranchFake }, 'blog-exp')
  assert.equal(await cmdReset(right.ctx, ['blog-exp'], {}), 0)
  const yes = cliCtx({ resetBranch: resetBranchFake })
  assert.equal(await cmdReset(yes.ctx, ['blog-exp'], { yes: true, 'allow-pause': true }), 0)
  assert.deepEqual(calls, [
    { name: 'blog-exp', opts: { allowPause: false } },
    { name: 'blog-exp', opts: { allowPause: true } },
  ])
  await assert.rejects(cmdReset(yes.ctx, [], {}), UsageError)
})

test('hobby diff maps <a> <b> to b against a, and hobby expire parses durations', async () => {
  const diffCalls: unknown[] = []
  const response = { old: { project: 'a' }, new: { project: 'b' }, resources: [], woke: [], identical: true }
  const d = cliCtx({
    diffSchemas: async (name: string, against?: string) => {
      diffCalls.push([name, against])
      return response
    },
  })
  await cmdDiff(d.ctx, ['blog-exp'], {})
  await cmdDiff(d.ctx, ['a', 'b'], {})
  assert.deepEqual(diffCalls, [['blog-exp', undefined], ['b', 'a']])
  assert.ok(d.out.some((line) => line.includes('no schema differences')))
  await assert.rejects(cmdDiff(d.ctx, [], {}), UsageError)

  const expireCalls: unknown[] = []
  const e = cliCtx({
    setExpiry: async (name: string, seconds: number | null) => {
      expireCalls.push([name, seconds])
      return { project: { expiresAt: seconds === null ? null : new Date(0) } as Project }
    },
  })
  await cmdExpire(e.ctx, ['blog-exp', '7d'], {})
  await cmdExpire(e.ctx, ['blog-exp'], { never: true })
  assert.deepEqual(expireCalls, [['blog-exp', 604800], ['blog-exp', null]])
  await assert.rejects(cmdExpire(e.ctx, ['blog-exp'], {}), UsageError)
  await assert.rejects(cmdExpire(e.ctx, ['blog-exp', '7d'], { never: true }), UsageError)
  await assert.rejects(cmdExpire(e.ctx, ['blog-exp', 'soon'], {}), UsageError)
})
