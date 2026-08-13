// cmdNew, cmdCreate and cmdDeploy against a fake Api. Nothing here touches
// the daemon, Docker or a socket: each command is a handful of API calls and
// the decisions it makes between them, and those decisions are what these
// pin.

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { HobbyError } from '@hobby.sh/core'
import { cmdConnect, cmdCreate, cmdDeploy, cmdNew, cmdPg, type Ctx } from '../src/index.js'
import type { Api } from '../src/cli/client.js'

interface Recorded {
  created: string[]
  resources: string[]
  // The exact body handed to createResource, kept alongside `resources`
  // above (a display-string projection the existing tests already pin)
  // rather than replacing it, so a body-shape assertion (does `hobby
  // create` send neither a source nor an image?) can be made without
  // touching what those tests already check.
  resourceBodies: Array<{ project: string; body: { kind: string; name: string } }>
  deleted: string[]
}

// Only the methods cmdNew, cmdCreate and cmdDeploy reach for. Casting a
// partial through unknown rather than stubbing all of Api keeps the fake
// honest about what these commands actually depend on: a new call to any of
// them fails loudly rather than silently returning undefined.
//
// `existingResources` seeds getProject's resource list, which is what lets
// the kind-conflict test below exercise cmdDeploy's refusal without any
// real filesystem or Docker in the loop.
function fakeCtx(
  opts: {
    failResource?: Error
    failDelete?: Error
    tailnetConnectionString?: string
    existingResources?: Array<{ id: string; name: string; kind: string }>
    cwd?: string
  } = {}
): {
  ctx: Ctx
  recorded: Recorded
  out: string[]
  err: string[]
} {
  const recorded: Recorded = { created: [], resources: [], resourceBodies: [], deleted: [] }
  const out: string[] = []
  const err: string[] = []

  const api = {
    async createProject(name: string) {
      recorded.created.push(name)
      return { project: { id: 'p1', name, networkName: `hobby-${name}`, sleepAfterSeconds: 300, createdAt: new Date() } }
    },
    async createResource(projectName: string, body: { kind: string; name: string }) {
      recorded.resources.push(`${projectName}/${body.name}`)
      recorded.resourceBodies.push({ project: projectName, body })
      if (opts.failResource !== undefined) throw opts.failResource
      return { resource: { id: 'r1', kind: body.kind, name: body.name, state: 'undeployed' } }
    },
    async getProject(name: string) {
      return {
        project: { id: 'p1', name, networkName: `hobby-${name}`, sleepAfterSeconds: 300, createdAt: new Date() },
        resources: opts.existingResources ?? [],
      }
    },
    async getConnection(_id: string) {
      return {
        connectionString: 'postgres://postgres:secret@127.0.0.1:5432/blog',
        tailnetConnectionString: opts.tailnetConnectionString ?? null,
      }
    },
    async deleteProject(name: string) {
      recorded.deleted.push(name)
      if (opts.failDelete !== undefined) throw opts.failDelete
      return { deleted: true as const }
    },
  }

  const ctx = {
    io: {
      out: (s: string) => out.push(s),
      err: (s: string) => err.push(s),
      env: {},
      cwd: opts.cwd ?? '/tmp',
      readLine: async () => '',
    },
    api: api as unknown as Api,
    paths: {} as Ctx['paths'],
    config: {} as Ctx['config'],
  } as Ctx

  return { ctx, recorded, out, err }
}

test('hobby new prints the connection string and leaves the project in place', async () => {
  const { ctx, recorded, out } = fakeCtx()

  const code = await cmdNew(ctx, ['blog'], {})

  assert.equal(code, 0)
  assert.deepEqual(recorded.created, ['blog'])
  assert.deepEqual(recorded.resources, ['blog/primary'])
  assert.deepEqual(recorded.deleted, [], 'a successful create rolls back nothing')
  assert.deepEqual(out, ['postgres://postgres:secret@127.0.0.1:5432/blog'])
})

// The failure this exists for: without the rollback, the project survived its
// own failed creation and the obvious retry got 409 name_taken, with no hint
// that `hobby rm` was the way out of a project the user never created.
test('hobby new rolls the project back when the database fails to come up', async () => {
  const boom = new HobbyError('wake_failed', 'postgres did not become ready during initial boot')
  const { ctx, recorded } = fakeCtx({ failResource: boom })

  await assert.rejects(cmdNew(ctx, ['blog'], {}), (err: unknown) => err === boom)

  assert.deepEqual(recorded.deleted, ['blog'], 'the half-created project is removed')
})

test('hobby new reports a failed rollback without hiding the original failure', async () => {
  const boom = new HobbyError('wake_failed', 'postgres did not become ready during initial boot')
  const { ctx, err } = fakeCtx({ failResource: boom, failDelete: new Error('docker is unreachable') })

  // The original failure is what propagates: it is the one that explains why
  // nothing works. The cleanup failure is on stderr, because a project that
  // neither works nor was removed is something the user has to know about.
  await assert.rejects(cmdNew(ctx, ['blog'], {}), (thrown: unknown) => thrown === boom)

  assert.equal(err.length, 1)
  assert.match(err[0] as string, /could not roll back/)
  assert.match(err[0] as string, /hobby rm blog/)
})

// The tailnet line: when the daemon reports a tailnet connection string
// (docs/proxy/research/2026-08-13-postgres-over-tailnet.md), the human
// output carries it on its own labelled second line, and the first line
// stays the plain local string so existing pipes keep working. A daemon
// that reports none (older daemon, no tailscaled) produces exactly the old
// single-line output, which the first cmdNew test above keeps pinned.
test('hobby new prints the tailnet connection string on its own labelled line', async () => {
  const { ctx, out } = fakeCtx({
    tailnetConnectionString: 'postgres://postgres:secret@box.tail1234.ts.net:5432/blog',
  })

  const code = await cmdNew(ctx, ['blog'], {})

  assert.equal(code, 0)
  assert.deepEqual(out, [
    'postgres://postgres:secret@127.0.0.1:5432/blog',
    'tailnet: postgres://postgres:secret@box.tail1234.ts.net:5432/blog',
  ])
})

test('hobby connect --json passes tailnetConnectionString through', async () => {
  const out: string[] = []
  const api = {
    async getProject(_name: string) {
      return {
        project: { id: 'p1', name: 'blog' },
        resources: [{ id: 'r1', kind: 'postgres', name: 'primary' }],
      }
    },
    async getConnection(_id: string) {
      return {
        connectionString: 'postgres://postgres:secret@127.0.0.1:5432/blog',
        tailnetConnectionString: 'postgres://postgres:secret@box.tail1234.ts.net:5432/blog',
      }
    },
  }
  const ctx = {
    io: { out: (s: string) => out.push(s), err: () => {}, env: {}, cwd: '/tmp', readLine: async () => '' },
    api: api as unknown as Api,
    paths: {} as Ctx['paths'],
    config: {} as Ctx['config'],
  } as Ctx

  const code = await cmdConnect(ctx, ['blog'], { json: true })

  assert.equal(code, 0)
  assert.deepEqual(JSON.parse(out[0] as string), {
    connectionString: 'postgres://postgres:secret@127.0.0.1:5432/blog',
    tailnetConnectionString: 'postgres://postgres:secret@box.tail1234.ts.net:5432/blog',
  })
})

// A project is a namespace holding typed resources (root CLAUDE.md's
// Scope), not a database with a name: `--empty` is the door to that, a bare
// project with nothing created past it. Nothing here for cmdCreate to roll
// back if the project itself fails, since nothing else is attempted.
test('hobby new --empty creates a project with zero resources', async () => {
  const { ctx, recorded, out } = fakeCtx()

  const code = await cmdNew(ctx, ['blog'], { empty: true })

  assert.equal(code, 0)
  assert.deepEqual(recorded.created, ['blog'])
  assert.deepEqual(recorded.resources, [])
  assert.ok(out.some((line) => line.includes('no resources yet')))
})

// The headline ergonomic root CLAUDE.md sells: without --empty, `hobby new`
// still creates a postgres named `primary`, and the body it sends is
// exactly `{ kind: 'postgres', name: 'primary' }`, no source, no image,
// nothing `hobby create`'s general form does not also send for any other
// kind. This is what makes `hobby pg create` a true alias rather than a
// second implementation: both requests reach the daemon looking identical.
test('hobby new without --empty still creates a postgres named primary, unchanged', async () => {
  const { ctx, recorded } = fakeCtx()

  const code = await cmdNew(ctx, ['blog'], {})

  assert.equal(code, 0)
  assert.deepEqual(recorded.resourceBodies[0], { project: 'blog', body: { kind: 'postgres', name: 'primary' } })
})

// `hobby create <kind> <name> --project <p>`: a record, no container. The
// body sent to POST /v1/projects/:name/resources carries neither a source
// nor an image, which is exactly what tells the daemon (Task 4's
// createAppResource/createWorkerResource) to produce an `undeployed` row
// that builds nothing and starts nothing.
test('hobby create makes a record and no container', async () => {
  const { ctx, recorded } = fakeCtx()

  const code = await cmdCreate(ctx, ['app', 'site'], { project: 'blog', json: true })

  assert.equal(code, 0)
  assert.deepEqual(recorded.resourceBodies[0], { project: 'blog', body: { kind: 'app', name: 'site' } })
})

// Two optional positionals (a path and a resource name) cannot be
// disambiguated, so `hobby deploy` only ever takes one; a name is decided by
// looking at what already exists in the target project. Landing on a name
// already held by a resource of a different kind (here, a postgres named
// `site`) refuses outright rather than silently discarding it: nothing a
// deploy does should ever delete someone's database because an app wanted
// its name. Deliberately no --kind flag and no Dockerfile on disk: the
// refusal is decidable before kind detection ever touches the filesystem,
// see cmdDeploy's own comment on why that check runs first.
test('deploying onto a name held by another kind refuses rather than replacing', async () => {
  const { ctx } = fakeCtx({ existingResources: [{ id: 'x1', name: 'site', kind: 'postgres' }] })

  await assert.rejects(() => cmdDeploy(ctx, ['./site'], { project: 'blog' }), /is a postgres/)
})

// `hobby pg create` is an alias for cmdCreate's general form, not a second
// implementation: this pins that both send the exact same body to the exact
// same route, `{ kind: 'postgres', name }` with nothing else, the same
// property the "hobby new without --empty" test above pins for cmdNew.
test('hobby pg create sends the same body cmdCreate would for kind postgres', async () => {
  const { ctx: pgCtx, recorded: pgRecorded } = fakeCtx()
  const { ctx: createCtx, recorded: createRecorded } = fakeCtx()

  const pgCode = await cmdPg(pgCtx, ['create', 'analytics'], { project: 'blog', json: true })
  const createCode = await cmdCreate(createCtx, ['postgres', 'analytics'], { project: 'blog', json: true })

  assert.equal(pgCode, 0)
  assert.equal(createCode, 0)
  assert.deepEqual(pgRecorded.resourceBodies[0], createRecorded.resourceBodies[0])
  assert.deepEqual(pgRecorded.resourceBodies[0], { project: 'blog', body: { kind: 'postgres', name: 'analytics' } })
})
