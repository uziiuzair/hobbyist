// cmdNew, cmdCreate and cmdDeploy against a fake Api. Nothing here touches
// the daemon, Docker or a socket: each command is a handful of API calls and
// the decisions it makes between them, and those decisions are what these
// pin.

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { HobbyError } from '@hobby.sh/core'
import {
  cmdConnect,
  cmdCreate,
  cmdCron,
  cmdDeploy,
  cmdEnv,
  cmdLogs,
  cmdNew,
  cmdPg,
  cmdPin,
  cmdQueueCreate,
  cmdQueueLs,
  cmdQueuePurge,
  cmdQueueRm,
  cmdQueueSend,
  cmdQueueSet,
  cmdUnpin,
  resolveTarget,
  UsageError,
  type Ctx,
} from '../src/index.js'
import type { Api, QueueListEntry } from '../src/cli/client.js'
import type { WireResource } from '../src/daemon/wire.js'

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
  // The second argument each createProject call received: undefined when
  // the command let the daemon's config default decide, null when it asked
  // for a pinned project. Same projection idea as resourceBodies above.
  createSleepPolicies: Array<number | null | undefined>
  // Every setSleepPolicy call, in order.
  sleepPolicies: Array<{ project: string; sleepAfterSeconds: number | null }>
  // Every deployResource call: the redeploy path of cmdDeploy.
  deploys: Array<{ id: string; input: unknown }>
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
    existingResources?: Array<{ id: string; name: string; kind: string; state?: string }>
    cwd?: string
    projectMissing?: boolean
  } = {}
): {
  ctx: Ctx
  recorded: Recorded
  out: string[]
  err: string[]
} {
  const recorded: Recorded = {
    created: [],
    resources: [],
    resourceBodies: [],
    deleted: [],
    createSleepPolicies: [],
    sleepPolicies: [],
    deploys: [],
  }
  const out: string[] = []
  const err: string[] = []

  const api = {
    async createProject(name: string, sleepAfterSeconds?: number | null) {
      recorded.created.push(name)
      recorded.createSleepPolicies.push(sleepAfterSeconds)
      return {
        project: {
          id: 'p1',
          name,
          networkName: `hobby-${name}`,
          sleepAfterSeconds: sleepAfterSeconds === undefined ? 300 : sleepAfterSeconds,
          createdAt: new Date(),
        },
      }
    },
    async setSleepPolicy(project: string, sleepAfterSeconds: number | null) {
      recorded.sleepPolicies.push({ project, sleepAfterSeconds })
      return { project: { id: 'p1', name: project, networkName: `hobby-${project}`, sleepAfterSeconds, createdAt: new Date() } }
    },
    async createResource(projectName: string, body: { kind: string; name: string }) {
      recorded.resources.push(`${projectName}/${body.name}`)
      recorded.resourceBodies.push({ project: projectName, body })
      if (opts.failResource !== undefined) throw opts.failResource
      return {
        resource: {
          id: 'r1',
          kind: body.kind,
          name: body.name,
          state: 'undeployed',
          config: { image: null, hostname: `${body.name}.${projectName}.localhost` },
        },
      }
    },
    async deployResource(id: string, input: unknown) {
      recorded.deploys.push({ id, input })
      return {
        resource: { id, kind: 'app', name: 'site', state: 'sleeping', config: { image: 'img:2', hostname: 'site.blog.localhost' } },
        image: 'img:2',
        logs: '',
      }
    },
    async getProject(name: string) {
      // `projectMissing`: the project does not exist until this fake's
      // createProject has been called for it, which is what lets a test
      // drive cmdDeploy's create-the-project-first path.
      if (opts.projectMissing === true && !recorded.created.includes(name)) {
        throw new HobbyError('project_not_found', `no project named ${name}`)
      }
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

// The sleep-policy surface: `--pin` at birth, pin/unpin afterward. What
// these pin is the argument each command actually sends, because the wire
// contract is three-valued (undefined defers to the daemon's config
// default, null pins, a number is a threshold) and a command that collapses
// undefined into null would silently pin every new project.
test('hobby new without --pin lets the daemon default decide', async () => {
  const { ctx, recorded } = fakeCtx()

  const code = await cmdNew(ctx, ['blog'], {})

  assert.equal(code, 0)
  assert.deepEqual(recorded.createSleepPolicies, [undefined])
})

test('hobby new --pin creates the project pinned awake', async () => {
  const { ctx, recorded } = fakeCtx()

  const code = await cmdNew(ctx, ['prod'], { pin: true })

  assert.equal(code, 0)
  assert.deepEqual(recorded.createSleepPolicies, [null])
})

test('hobby pin sets a null sleep policy and says so', async () => {
  const { ctx, recorded, out } = fakeCtx()

  const code = await cmdPin(ctx, ['prod'], {})

  assert.equal(code, 0)
  assert.deepEqual(recorded.sleepPolicies, [{ project: 'prod', sleepAfterSeconds: null }])
  assert.deepEqual(out, ['project prod: pinned awake, never sleeps'])
})

test('hobby unpin --sleep-after sends that threshold', async () => {
  const { ctx, recorded, out } = fakeCtx()

  const code = await cmdUnpin(ctx, ['prod'], { 'sleep-after': '120' })

  assert.equal(code, 0)
  assert.deepEqual(recorded.sleepPolicies, [{ project: 'prod', sleepAfterSeconds: 120 }])
  assert.deepEqual(out, ['project prod: sleeps after 120s idle'])
})

// Issue #110: no flag sends no value, so the daemon's box-wide default
// applies rather than whatever this process resolved from its own env and
// cwd. The CLI's own config is deliberately not consulted at all.
test('hobby unpin without a flag sends no threshold and lets the daemon default decide', async () => {
  const { ctx, recorded } = fakeCtx()
  ctx.config = { ...ctx.config, sleepAfterSeconds: 300 }

  const code = await cmdUnpin(ctx, ['prod'], {})

  assert.equal(code, 0)
  assert.deepEqual(recorded.sleepPolicies, [{ project: 'prod', sleepAfterSeconds: undefined }])
})

// Issue #111: pinning wakes nothing, so a project with anything asleep is
// told it will not sleep once woken, rather than "pinned awake".
test('hobby pin on a project with a sleeping resource says it will not sleep once woken', async () => {
  const { ctx, out } = fakeCtx({ existingResources: [{ id: 'r1', name: 'primary', kind: 'postgres', state: 'sleeping' }] })

  const code = await cmdPin(ctx, ['prod'], {})

  assert.equal(code, 0)
  assert.deepEqual(out, ['project prod: pinned: it will not sleep once woken'])
})

test('hobby unpin rejects a non-integer threshold', async () => {
  const { ctx, recorded } = fakeCtx()

  await assert.rejects(cmdUnpin(ctx, ['prod'], { 'sleep-after': '1.5' }), UsageError)
  await assert.rejects(cmdUnpin(ctx, ['prod'], { 'sleep-after': '0' }), UsageError)
  assert.deepEqual(recorded.sleepPolicies, [])
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

test('hobby connect --json passes tailnetConnectionString and publicConnectionString through', async () => {
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
        publicConnectionString: 'postgres://postgres:secret@db.example.com:5432/blog?sslmode=require',
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
    publicConnectionString: 'postgres://postgres:secret@db.example.com:5432/blog?sslmode=require',
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
  // A real Dockerfile, since the kind is detected before the daemon is
  // consulted: a directory with nothing to deploy is its own error.
  const cwd = mkdtempSync(join(tmpdir(), 'hobby-kind-conflict-'))
  mkdirSync(join(cwd, 'site'))
  writeFileSync(join(cwd, 'site', 'Dockerfile'), 'FROM scratch\n')
  const { ctx } = fakeCtx({ existingResources: [{ id: 'x1', name: 'site', kind: 'postgres' }], cwd })

  await assert.rejects(() => cmdDeploy(ctx, ['./site'], { project: 'blog' }), /is a postgres/)
})

// `hobby deploy --env-file`. The file is read on the client and sent as a
// JSON map, so these need a real file on disk and nothing else: `--kind app`
// skips Dockerfile detection, and the fake Api records what was sent.
function envFileDir(contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'hobby-env-'))
  writeFileSync(join(dir, '.env.production'), contents)
  return dir
}

test('hobby deploy --env-file sends env on first deploy and prints only a count', async () => {
  const dir = envFileDir('API_KEY=sk-very-secret\nNODE_ENV=production\n')
  const { ctx, recorded, out } = fakeCtx({ cwd: dir })

  const code = await cmdDeploy(ctx, ['./site'], { project: 'blog', kind: 'app', 'env-file': '.env.production' })

  assert.equal(code, 0)
  const body = recorded.resourceBodies[0]?.body as { env?: Record<string, string> }
  assert.deepEqual(body.env, { API_KEY: 'sk-very-secret', NODE_ENV: 'production' })
  assert.ok(out.includes('  env       2 variables'))
  assert.ok(!out.some((line) => line.includes('sk-very-secret')), 'a value is never printed')
})

test('hobby deploy --env-file on an existing app sends env with the redeploy', async () => {
  const dir = envFileDir('ONLY=one\n')
  const { ctx, recorded, out } = fakeCtx({ cwd: dir, existingResources: [{ id: 'a1', name: 'site', kind: 'app' }] })

  const code = await cmdDeploy(ctx, ['./site'], { project: 'blog', kind: 'app', 'env-file': '.env.production' })

  assert.equal(code, 0)
  assert.deepEqual(recorded.deploys, [{ id: 'a1', input: { source: { path: join(dir, 'site') }, env: { ONLY: 'one' } } }])
  assert.ok(out.includes('  env       1 variable'))
})

// No flag, no field: the daemon keeps the app's current env rather than
// replacing it with nothing.
test('hobby deploy without --env-file sends no env on a redeploy', async () => {
  const { ctx, recorded } = fakeCtx({ existingResources: [{ id: 'a1', name: 'site', kind: 'app' }] })

  await cmdDeploy(ctx, ['./site'], { project: 'blog', kind: 'app' })

  assert.equal(recorded.deploys.length, 1)
  assert.equal('env' in (recorded.deploys[0]?.input as object), false)
})

// Issue #74: a worker used to refuse --env-file with "use [vars]", which
// left it with no way to hold a secret outside the repository.
test('hobby deploy --env-file sends env for a worker too', async () => {
  const dir = envFileDir('A=1\n')
  const { ctx, recorded } = fakeCtx({ cwd: dir })

  const code = await cmdDeploy(ctx, ['./api'], { project: 'blog', kind: 'worker', 'env-file': '.env.production' })
  assert.equal(code, 0)
  const body = recorded.resourceBodies[0]?.body as { kind: string; env?: Record<string, string> }
  assert.equal(body.kind, 'worker')
  assert.deepEqual(body.env, { A: '1' })
})

test('hobby deploy --env K=V is repeatable and beats the same key in --env-file', async () => {
  const dir = envFileDir('A=file\nB=file\n')
  const { ctx, recorded, out } = fakeCtx({ cwd: dir })

  const code = await cmdDeploy(ctx, ['./site'], {
    project: 'blog',
    kind: 'app',
    'env-file': '.env.production',
    env: ['A=flag', 'C=x=y'],
  })
  assert.equal(code, 0)
  const body = recorded.resourceBodies[0]?.body as { env?: Record<string, string> }
  assert.deepEqual(body.env, { A: 'flag', B: 'file', C: 'x=y' })
  assert.ok(out.includes('  env       3 variables'))
  assert.ok(!out.some((line) => line.includes('flag') || line.includes('x=y')), 'values are never printed')
})

test('a worker deploy with no explicit variables reads .dev.vars beside the manifest', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hobby-devvars-'))
  const src = join(dir, 'api')
  mkdirSync(src)
  writeFileSync(join(src, 'wrangler.toml'), 'name = "api"\nmain = "src/index.ts"\ncompatibility_date = "2024-01-01"\n')
  writeFileSync(join(src, '.dev.vars'), 'SECRET=hunter2\n')
  const { ctx, recorded, out } = fakeCtx({ cwd: dir })

  assert.equal(await cmdDeploy(ctx, ['./api'], { project: 'blog' }), 0)
  const body = recorded.resourceBodies[0]?.body as { env?: Record<string, string> }
  assert.deepEqual(body.env, { SECRET: 'hunter2' })
  assert.ok(out.includes('  env       1 variable (from .dev.vars)'))
  assert.ok(!out.some((line) => line.includes('hunter2')))

  // An explicit --env wins outright rather than merging with the file, so
  // what was sent is one nameable thing.
  recorded.resourceBodies.length = 0
  assert.equal(await cmdDeploy(ctx, ['./api'], { project: 'blog', env: ['OTHER=1'] }), 0)
  assert.deepEqual((recorded.resourceBodies[0]?.body as { env?: Record<string, string> }).env, { OTHER: '1' })
})

test('hobby deploy --env with a bad assignment is a usage error naming it, before anything is created', async () => {
  const dir = envFileDir('A=1\n')
  const { ctx, recorded } = fakeCtx({ cwd: dir })
  await assert.rejects(
    () => cmdDeploy(ctx, ['./site'], { project: 'blog', kind: 'app', env: ['NOEQUALS'] }),
    (err: unknown) => err instanceof UsageError && /NOEQUALS/.test(err.message)
  )
  await assert.rejects(
    () => cmdDeploy(ctx, ['./site'], { project: 'blog', kind: 'app', env: ['9BAD=1'] }),
    (err: unknown) => err instanceof UsageError && /9BAD/.test(err.message)
  )
  assert.deepEqual(recorded.created, [])
})

test('hobby deploy --env-file with a missing file is a usage error', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hobby-env-'))
  const { ctx, recorded } = fakeCtx({ cwd: dir })

  await assert.rejects(
    () => cmdDeploy(ctx, ['./site'], { project: 'blog', kind: 'app', 'env-file': 'nope.env' }),
    (err: unknown) => err instanceof UsageError && err.message.includes(join(dir, 'nope.env'))
  )
  assert.deepEqual(recorded.created, [])
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

// ---------------------------------------------------------------------------
// `hobby queue <verb>` against a fake Api. Fixtures below are shaped like the
// real WireResource union (packages/cli/src/daemon/wire.ts) rather than
// loosely typed objects, since renderQueueLine/renderQueueConsumer
// (output.ts) narrow on `kind` and read real fields off `config`.
// ---------------------------------------------------------------------------

function queueResource(overrides: { name?: string; deadLetterQueue?: string | null } = {}): WireResource {
  return {
    id: `${overrides.name ?? 'jobs'}-id`,
    projectId: 'p1',
    kind: 'queue',
    name: overrides.name ?? 'jobs',
    state: 'running',
    config: {
      image: '',
      containerName: '',
      hostPort: 0,
      retentionSeconds: 345600,
      consumerResourceId: null,
      maxBatchSize: 5,
      maxBatchTimeoutSeconds: 1,
      maxRetries: 2,
      retryDelaySeconds: 0,
      deadLetterQueue: overrides.deadLetterQueue ?? null,
    },
    sizeBytes: null,
    connectionCount: 0,
    lastActiveAt: null,
    createdAt: new Date('2026-01-01'),
  }
}

function workerResource(opts: { name: string; deployed: boolean }): WireResource {
  return {
    id: `${opts.name}-id`,
    projectId: 'p1',
    kind: 'worker',
    name: opts.name,
    state: opts.deployed ? 'sleeping' : 'undeployed',
    config: {
      image: opts.deployed ? 'hobby/workerd:1' : null,
      containerName: `hobby-blog-${opts.name}`,
      hostPort: 15600,
      controlPort: 15601,
      queueToken: '<redacted>',
      containerPort: 8787,
      hostname: `${opts.name}.blog.localhost`,
      durableObjectUniqueKeyModifier: 'stable',
      databaseResourceId: null,
      manifest: opts.deployed
        ? {
            source: { path: '/src', manifest: 'wrangler.toml' },
            compatibilityDate: '2026-08-01',
            compatibilityFlags: [],
            vars: {},
            kvNamespaces: [],
            r2Buckets: [],
            d1Databases: [],
            queues: { producers: [], consumers: [{ queue: 'jobs', maxBatchSize: null, maxBatchTimeoutSeconds: null, maxRetries: null, retryDelaySeconds: null, deadLetterQueue: null }] },
            durableObjects: [],
          }
        : null,
    },
    sizeBytes: null,
    connectionCount: 0,
    lastActiveAt: null,
    createdAt: new Date('2026-01-01'),
  }
}

// `hobby queue ls`: depth and the consumer's name both make it into the
// human-rendered line, taken verbatim from what listQueues returned rather
// than re-derived.
test('hobby queue ls renders depth and a deployed consumer by name', async () => {
  const out: string[] = []
  const entry: QueueListEntry = {
    resource: queueResource(),
    depth: 3,
    oldestMessageAgeSeconds: 42,
    consumer: workerResource({ name: 'api', deployed: true }),
  }
  const api = {
    async listQueues(_project: string) {
      return { queues: [entry] }
    },
  }
  const ctx = {
    io: { out: (s: string) => out.push(s), err: () => {}, env: {}, cwd: '/tmp', readLine: async () => '' },
    api: api as unknown as Api,
    paths: {} as Ctx['paths'],
    config: {} as Ctx['config'],
  } as Ctx

  const code = await cmdQueueLs(ctx, ['blog'], {})

  assert.equal(code, 0)
  assert.ok(out.some((line) => line.includes('jobs') && line.includes('depth 3')))
  assert.ok(out.some((line) => line.includes('api') && !line.includes('no code yet')))
})

// The wording this task was told, in writing, to match: `hobby ls` already
// renders an `undeployed` resource with a "(no code yet)" trailer
// (packages/cli/src/cli/output.ts's renderResourceLine), and a queue whose
// consumer has never had code deployed to it (config.manifest === null)
// must read the same way here, not a second phrasing for the same fact.
test('hobby queue ls renders an undeployed consumer as "(no code yet)"', async () => {
  const out: string[] = []
  const entry: QueueListEntry = {
    resource: queueResource(),
    depth: 0,
    oldestMessageAgeSeconds: null,
    consumer: workerResource({ name: 'api', deployed: false }),
  }
  const api = {
    async listQueues(_project: string) {
      return { queues: [entry] }
    },
  }
  const ctx = {
    io: { out: (s: string) => out.push(s), err: () => {}, env: {}, cwd: '/tmp', readLine: async () => '' },
    api: api as unknown as Api,
    paths: {} as Ctx['paths'],
    config: {} as Ctx['config'],
  } as Ctx

  const code = await cmdQueueLs(ctx, ['blog'], {})

  assert.equal(code, 0)
  assert.ok(out.some((line) => line.includes('api (no code yet)')))
})

// `hobby queue create <name> --project <p>`: the same body shape cmdCreate
// already sends for every other kind, `{ kind, name }` with nothing else.
test('hobby queue create sends kind queue with no retention or consumer fields', async () => {
  const calls: Array<{ project: string; name: string }> = []
  const api = {
    async createQueue(project: string, name: string) {
      calls.push({ project, name })
      return { resource: queueResource({ name }) }
    },
  }
  const ctx = {
    io: { out: () => {}, err: () => {}, env: {}, cwd: '/tmp', readLine: async () => '' },
    api: api as unknown as Api,
    paths: {} as Ctx['paths'],
    config: {} as Ctx['config'],
  } as Ctx

  const code = await cmdQueueCreate(ctx, ['jobs'], { project: 'blog' })

  assert.equal(code, 0)
  assert.deepEqual(calls, [{ project: 'blog', name: 'jobs' }])
})

// `hobby queue send <target> <json>`: the positional is parsed client-side
// and the PARSED value, not the raw text, is what reaches the Api.
test('hobby queue send parses the json positional and sends the parsed value', async () => {
  const calls: Array<{ id: string; input: { body: unknown; delaySeconds?: number } }> = []
  const api = {
    async getProject(_name: string) {
      return { project: { id: 'p1', name: 'blog' }, resources: [queueResource()] }
    },
    async sendMessage(id: string, input: { body: unknown; delaySeconds?: number }) {
      calls.push({ id, input })
      return { id: 'msg-1' }
    },
  }
  const ctx = {
    io: { out: () => {}, err: () => {}, env: {}, cwd: '/tmp', readLine: async () => '' },
    api: api as unknown as Api,
    paths: {} as Ctx['paths'],
    config: {} as Ctx['config'],
  } as Ctx

  const code = await cmdQueueSend(ctx, ['blog/jobs', '{"n":1}'], {})

  assert.equal(code, 0)
  assert.deepEqual(calls, [{ id: 'jobs-id', input: { body: { n: 1 } } }])
})

test('hobby queue send refuses invalid json before making any Api call', async () => {
  const api = {
    async getProject(_name: string) {
      throw new Error('must not be called: invalid JSON should be rejected first')
    },
  }
  const ctx = {
    io: { out: () => {}, err: () => {}, env: {}, cwd: '/tmp', readLine: async () => '' },
    api: api as unknown as Api,
    paths: {} as Ctx['paths'],
    config: {} as Ctx['config'],
  } as Ctx

  await assert.rejects(() => cmdQueueSend(ctx, ['blog/jobs', '{not json'], {}), /not valid JSON/)
})

// The non-negotiable: purge requires the queue's own name typed back,
// exactly as `wrangler queues purge` does, because it is irreversible and
// reachable by tab completion. A mismatched confirmation must not call
// purgeQueue at all.
test('hobby queue purge refuses without a matching typed confirmation, and issues no purge call', async () => {
  let purgeCalls = 0
  const api = {
    async getProject(_name: string) {
      return { project: { id: 'p1', name: 'blog' }, resources: [queueResource()] }
    },
    async purgeQueue(_id: string) {
      purgeCalls += 1
      return { purged: 0 }
    },
  }
  const err: string[] = []
  const ctx = {
    io: { out: () => {}, err: (s: string) => err.push(s), env: {}, cwd: '/tmp', readLine: async () => 'not-jobs' },
    api: api as unknown as Api,
    paths: {} as Ctx['paths'],
    config: {} as Ctx['config'],
  } as Ctx

  const code = await cmdQueuePurge(ctx, ['blog/jobs'], {})

  assert.equal(code, 1)
  assert.equal(purgeCalls, 0)
  assert.ok(err.some((line) => line.includes('did not match')))
})

test('hobby queue purge proceeds and reports the count once the queue name is typed back', async () => {
  const purged: string[] = []
  const api = {
    async getProject(_name: string) {
      return { project: { id: 'p1', name: 'blog' }, resources: [queueResource()] }
    },
    async purgeQueue(id: string) {
      purged.push(id)
      return { purged: 5 }
    },
  }
  const out: string[] = []
  const ctx = {
    io: { out: (s: string) => out.push(s), err: () => {}, env: {}, cwd: '/tmp', readLine: async () => 'jobs' },
    api: api as unknown as Api,
    paths: {} as Ctx['paths'],
    config: {} as Ctx['config'],
  } as Ctx

  const code = await cmdQueuePurge(ctx, ['blog/jobs'], {})

  assert.equal(code, 0)
  assert.deepEqual(purged, ['jobs-id'])
  assert.ok(out.some((line) => line.includes('5') && line.includes('jobs')))
})

// `--yes` skips the prompt entirely, the same escape hatch `hobby rm`
// already offers, and is what lets this be scripted.
test('hobby queue purge --yes skips the prompt and purges directly', async () => {
  let purgeCalls = 0
  const api = {
    async getProject(_name: string) {
      return { project: { id: 'p1', name: 'blog' }, resources: [queueResource()] }
    },
    async purgeQueue(_id: string) {
      purgeCalls += 1
      return { purged: 0 }
    },
  }
  const ctx = {
    io: {
      out: () => {},
      err: () => {},
      env: {},
      cwd: '/tmp',
      readLine: async () => {
        throw new Error('must not prompt when --yes is set')
      },
    },
    api: api as unknown as Api,
    paths: {} as Ctx['paths'],
    config: {} as Ctx['config'],
  } as Ctx

  const code = await cmdQueuePurge(ctx, ['blog/jobs'], { yes: true })

  assert.equal(code, 0)
  assert.equal(purgeCalls, 1)
})

// `hobby queue rm`: the same typed-confirmation shape as purge, over
// deleteResource rather than purgeQueue. The binding refusal itself lives in
// the daemon route (routes.ts's destroyResourceRoute) and is exercised
// there, not here; this only pins that rm asks before it deletes.
test('hobby queue rm refuses without a matching typed confirmation, and deletes nothing', async () => {
  let deleteCalls = 0
  const api = {
    async getProject(_name: string) {
      return { project: { id: 'p1', name: 'blog' }, resources: [queueResource()] }
    },
    async deleteResource(_id: string) {
      deleteCalls += 1
      return { deleted: true as const }
    },
  }
  const err: string[] = []
  const ctx = {
    io: { out: () => {}, err: (s: string) => err.push(s), env: {}, cwd: '/tmp', readLine: async () => 'nope' },
    api: api as unknown as Api,
    paths: {} as Ctx['paths'],
    config: {} as Ctx['config'],
  } as Ctx

  const code = await cmdQueueRm(ctx, ['blog/jobs'], {})

  assert.equal(code, 1)
  assert.equal(deleteCalls, 0)
  assert.ok(err.some((line) => line.includes('did not match')))
})

// `hobby queue set <target> --retention <seconds>`: the number reaches the
// Api unchanged, and bounds are the daemon's job to enforce (pinned at the
// route level in routes.test.ts), not re-validated here.
test('hobby queue set sends the retention value to the resolved queue', async () => {
  const calls: Array<{ id: string; retentionSeconds: number }> = []
  const api = {
    async getProject(_name: string) {
      return { project: { id: 'p1', name: 'blog' }, resources: [queueResource()] }
    },
    async setRetention(id: string, retentionSeconds: number) {
      calls.push({ id, retentionSeconds })
      return { resource: queueResource({ }) }
    },
  }
  const ctx = {
    io: { out: () => {}, err: () => {}, env: {}, cwd: '/tmp', readLine: async () => '' },
    api: api as unknown as Api,
    paths: {} as Ctx['paths'],
    config: {} as Ctx['config'],
  } as Ctx

  const code = await cmdQueueSet(ctx, ['blog/jobs'], { retention: '3600' })

  assert.equal(code, 0)
  assert.deepEqual(calls, [{ id: 'jobs-id', retentionSeconds: 3600 }])
})

// Issue #98: `hobby link` wrote a hobby.json and then every verb but
// `create` ignored it. These pin the three behaviours that make a link
// useful: deploy goes into the linked project, a verb given no target acts
// on it, and a bare name next to a link is first a resource of that project.
function linkedCtx(
  projects: Record<string, Array<{ id: string; name: string; kind: string }>>,
  linked: string
): { ctx: Ctx; out: string[]; recorded: { resources: string[]; logs: string[] } } {
  const out: string[] = []
  const recorded = { resources: [] as string[], logs: [] as string[] }
  const api = {
    async getProject(name: string) {
      const resources = projects[name]
      if (resources === undefined) {
        throw new HobbyError('project_not_found', `no project named ${name}`)
      }
      return {
        project: { id: `p-${name}`, name, networkName: `hobby-${name}`, sleepAfterSeconds: 300, createdAt: new Date() },
        resources,
      }
    },
    async createProject(name: string) {
      projects[name] = []
      return { project: { id: `p-${name}`, name, networkName: `hobby-${name}`, sleepAfterSeconds: 300, createdAt: new Date() } }
    },
    async createResource(projectName: string, body: { kind: string; name: string }) {
      recorded.resources.push(`${projectName}/${body.name}`)
      return {
        resource: {
          id: 'r1',
          kind: body.kind,
          name: body.name,
          state: 'undeployed',
          config: { image: null, hostname: `${body.name}.${projectName}.localhost` },
        },
      }
    },
    async getLogs(id: string) {
      recorded.logs.push(id)
      return { logs: `logs of ${id}` }
    },
  }
  const ctx = {
    io: { out: (s: string) => out.push(s), err: () => {}, env: {}, cwd: '/tmp', readLine: async () => '' },
    api: api as unknown as Api,
    paths: {} as Ctx['paths'],
    config: { project: linked } as Ctx['config'],
  } as Ctx
  return { ctx, out, recorded }
}

test('hobby deploy in a linked directory deploys into the linked project, not one named after the directory', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hobby-linked-'))
  writeFileSync(join(dir, 'Dockerfile'), 'FROM scratch\n')
  const { ctx, recorded } = linkedCtx({ qacomp1: [] }, 'qacomp1')
  ctx.io.cwd = dir

  assert.equal(await cmdDeploy(ctx, ['.'], {}), 0)
  assert.deepEqual(recorded.resources, [`qacomp1/${basename(dir)}`])
})

test('--project still beats the link on deploy', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hobby-linked-'))
  writeFileSync(join(dir, 'Dockerfile'), 'FROM scratch\n')
  const { ctx, recorded } = linkedCtx({ qacomp1: [], other: [] }, 'qacomp1')
  ctx.io.cwd = dir

  assert.equal(await cmdDeploy(ctx, ['.'], { project: 'other' }), 0)
  assert.deepEqual(recorded.resources, [`other/${basename(dir)}`])
})

test('a target-taking verb given no target acts on the linked project', async () => {
  const { ctx, recorded } = linkedCtx({ qacomp1: [{ id: 'web-1', name: 'web', kind: 'app' }] }, 'qacomp1')
  assert.equal(await cmdLogs(ctx, [], {}), 0)
  assert.deepEqual(recorded.logs, ['web-1'])
})

test('a bare name in a linked directory is first a resource of the linked project, then a project', async () => {
  const { ctx } = linkedCtx(
    {
      qacomp1: [
        { id: 'web-1', name: 'web', kind: 'app' },
        { id: 'db-1', name: 'primary', kind: 'postgres' },
      ],
      blog: [{ id: 'blog-db', name: 'primary', kind: 'postgres' }],
    },
    'qacomp1'
  )
  const asResource = await resolveTarget(ctx.api, 'web', 'qacomp1')
  assert.equal(asResource.resource.id, 'web-1')
  const asProject = await resolveTarget(ctx.api, 'blog', 'qacomp1')
  assert.equal(asProject.resource.id, 'blog-db')
  // A slash never consults the link.
  const dotted = await resolveTarget(ctx.api, 'blog/primary', 'qacomp1')
  assert.equal(dotted.resource.id, 'blog-db')
})

test('without a link, a missing target is still the usage error', async () => {
  const { ctx } = fakeCtx()
  await assert.rejects(cmdLogs(ctx, [], {}), UsageError)
})

// Issue #76: the daemon reported ignored wrangler keys on its own stderr and
// nowhere the user could see. They ride on the response now, and the CLI
// prints them on create and on redeploy, and under --json.
test('hobby deploy prints every ignored wrangler key with its reason, and includes them under --json', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hobby-ignored-'))
  writeFileSync(join(dir, 'wrangler.toml'), 'name = "wk"\nmain = "src/index.ts"\ncompatibility_date = "2024-01-01"\n')
  const ignored = [
    { key: 'triggers', reason: 'scheduled workers are not built yet' },
    { key: 'ai', reason: 'Workers AI is not provided by hobby' },
  ]
  const out: string[] = []
  const api = {
    async getProject() {
      return { project: { id: 'p1', name: 'blog' }, resources: [{ id: 'w1', name: 'wk', kind: 'worker' }] }
    },
    async deployResource() {
      return {
        resource: { id: 'w1', kind: 'worker', name: 'wk', state: 'sleeping', config: { image: 'img:1', hostname: 'wk.blog.localhost' } },
        image: 'img:1',
        logs: '',
        ignored,
      }
    },
  }
  const ctx = {
    io: { out: (s: string) => out.push(s), err: () => {}, env: {}, cwd: dir, readLine: async () => '' },
    api: api as unknown as Api,
    paths: {} as Ctx['paths'],
    config: {} as Ctx['config'],
  } as Ctx

  assert.equal(await cmdDeploy(ctx, ['.'], { project: 'blog', name: 'wk' }), 0)
  assert.ok(out.includes('  ignoring  triggers: scheduled workers are not built yet'))
  assert.ok(out.includes('  ignoring  ai: Workers AI is not provided by hobby'))

  out.length = 0
  assert.equal(await cmdDeploy(ctx, ['.'], { project: 'blog', name: 'wk', json: true }), 0)
  const parsed = JSON.parse(out.join('\n')) as { ignored: unknown }
  assert.deepEqual(parsed.ignored, ignored)
})

// Issue #74: `hobby env set|ls|unset` over POST /v1/resources/:id/env.
function envCtx(opts: {
  kind?: string
  env?: Record<string, string>
  vars?: Record<string, string>
  linked?: string
  stopped?: boolean
} = {}): { ctx: Ctx; out: string[]; calls: Array<{ id: string; input: unknown }> } {
  const out: string[] = []
  const calls: Array<{ id: string; input: unknown }> = []
  const kind = opts.kind ?? 'app'
  const config: Record<string, unknown> = { image: 'img', hostname: 'web.blog.localhost', env: opts.env ?? {} }
  if (kind === 'worker') config['manifest'] = { vars: opts.vars ?? {} }
  const resource = { id: 'web-1', name: 'web', kind, state: 'running', config }
  // A linked project holds just the app, so a bare target resolves; the
  // explicit-target cases keep a postgres beside it to prove the kind check.
  const siblings = opts.linked === undefined ? [{ id: 'db-1', name: 'primary', kind: 'postgres', config: {} }] : []
  const api = {
    async getProject(name: string) {
      return { project: { id: 'p1', name }, resources: [resource, ...siblings] }
    },
    async setEnv(id: string, input: unknown) {
      calls.push({ id, input })
      const current = { ...(opts.env ?? {}) }
      const body = input as { set?: Record<string, string>; unset?: string[] }
      for (const key of body.unset ?? []) delete current[key]
      Object.assign(current, body.set ?? {})
      return { resource: { ...resource, state: 'sleeping' }, keys: Object.keys(current).sort(), stopped: opts.stopped ?? false }
    },
  }
  const ctx = {
    io: { out: (s: string) => out.push(s), err: () => {}, env: {}, cwd: '/tmp', readLine: async () => '' },
    api: api as unknown as Api,
    paths: {} as Ctx['paths'],
    config: { project: opts.linked ?? null } as Ctx['config'],
  } as Ctx
  return { ctx, out, calls }
}

test('hobby env set <target> K=V sends set over the env route and prints keys, never values', async () => {
  const { ctx, out, calls } = envCtx({ stopped: true })
  assert.equal(await cmdEnv(ctx, ['set', 'blog/web', 'API_KEY=sk-secret', 'MODE=prod'], {}), 0)
  assert.deepEqual(calls, [{ id: 'web-1', input: { set: { API_KEY: 'sk-secret', MODE: 'prod' } } }])
  assert.ok(out.includes('set 2 variables on blog/web:'))
  assert.ok(out.includes('  API_KEY'))
  assert.ok(out.some((l) => l.includes('has been stopped')))
  assert.ok(!out.some((l) => l.includes('sk-secret')))
})

test('hobby env set in a linked directory takes K=V as its first argument', async () => {
  const { ctx, calls } = envCtx({ linked: 'blog' })
  assert.equal(await cmdEnv(ctx, ['set', 'A=1'], {}), 0)
  assert.deepEqual(calls, [{ id: 'web-1', input: { set: { A: '1' } } }])
})

test('hobby env set --env-file merges the file under explicit K=V', async () => {
  const dir = envFileDir('A=file\nB=file\n')
  const { ctx, calls } = envCtx()
  ctx.io.cwd = dir
  assert.equal(await cmdEnv(ctx, ['set', 'blog/web', 'A=arg'], { 'env-file': '.env.production' }), 0)
  assert.deepEqual(calls, [{ id: 'web-1', input: { set: { A: 'arg', B: 'file' } } }])
})

test('hobby env set with nothing to set is a usage error', async () => {
  const { ctx } = envCtx()
  await assert.rejects(cmdEnv(ctx, ['set', 'blog/web'], {}), UsageError)
})

test('hobby env unset <target> K sends unset; linked, a lone argument is a key', async () => {
  const explicit = envCtx({ env: { A: '1', B: '2' } })
  assert.equal(await cmdEnv(explicit.ctx, ['unset', 'blog/web', 'A'], {}), 0)
  assert.deepEqual(explicit.calls, [{ id: 'web-1', input: { unset: ['A'] } }])

  const linked = envCtx({ env: { A: '1', B: '2' }, linked: 'blog' })
  assert.equal(await cmdEnv(linked.ctx, ['unset', 'B'], {}), 0)
  assert.deepEqual(linked.calls, [{ id: 'web-1', input: { unset: ['B'] } }])
})

test('hobby env ls prints key names from the redacted config, and a worker\'s [vars] apart', async () => {
  const app = envCtx({ env: { ZED: '<redacted>', ALPHA: '<redacted>' } })
  assert.equal(await cmdEnv(app.ctx, ['ls', 'blog/web'], {}), 0)
  assert.deepEqual(app.out.slice(0, 3), ['blog/web:', '  ALPHA', '  ZED'])
  assert.ok(!app.out.some((l) => l.includes('<redacted>')))

  const worker = envCtx({ kind: 'worker', env: { SECRET: '<redacted>' }, vars: { PUBLIC: '<redacted>' } })
  assert.equal(await cmdEnv(worker.ctx, ['ls', 'blog/web', '--json'], { json: true }), 0)
  assert.deepEqual(JSON.parse(worker.out[0] as string), { keys: ['SECRET'], vars: ['PUBLIC'] })
})

test('hobby env refuses a postgres target and an unknown subcommand', async () => {
  const { ctx } = envCtx()
  await assert.rejects(cmdEnv(ctx, ['set', 'blog/primary', 'A=1'], {}), (err: unknown) => err instanceof UsageError && /postgres/.test(err.message))
  await assert.rejects(cmdEnv(ctx, ['frob', 'blog/web'], {}), UsageError)
})

// Issues #146 and #147: --dockerfile and --build-arg for an app, --context
// for a worker, each only on the wire when given so a redeploy keeps the
// stored values.
test('hobby deploy <root> --dockerfile --build-arg sends them with the source and detects an app by that file', async () => {
  const root = mkdtempSync(join(tmpdir(), 'hobby-mono-'))
  mkdirSync(join(root, 'deploy'))
  writeFileSync(join(root, 'deploy', 'admin.Dockerfile'), 'FROM scratch\n')
  const { ctx, recorded } = fakeCtx({ cwd: root })

  const code = await cmdDeploy(ctx, ['.'], {
    project: 'cl',
    name: 'admin',
    dockerfile: 'deploy/admin.Dockerfile',
    'build-arg': ['NEXT_PUBLIC_URL=https://a', 'X=1'],
  })
  assert.equal(code, 0)
  const body = recorded.resourceBodies[0]?.body as unknown as { kind: string; source: unknown }
  assert.equal(body.kind, 'app')
  assert.deepEqual(body.source, {
    path: root,
    dockerfile: 'deploy/admin.Dockerfile',
    buildArgs: { NEXT_PUBLIC_URL: 'https://a', X: '1' },
  })
})

test('hobby deploy --context sends an absolute context for a worker, and refuses it for an app', async () => {
  const root = mkdtempSync(join(tmpdir(), 'hobby-ws-'))
  mkdirSync(join(root, 'apps', 'w'), { recursive: true })
  writeFileSync(join(root, 'apps', 'w', 'wrangler.toml'), 'name = "w"\nmain = "src/index.ts"\ncompatibility_date = "2024-01-01"\n')
  const { ctx, recorded } = fakeCtx({ cwd: root })

  assert.equal(await cmdDeploy(ctx, ['./apps/w'], { project: 'cl', context: '.' }), 0)
  const body = recorded.resourceBodies[0]?.body as unknown as { kind: string; source: unknown }
  assert.equal(body.kind, 'worker')
  assert.deepEqual(body.source, { path: join(root, 'apps', 'w'), context: root })

  writeFileSync(join(root, 'Dockerfile'), 'FROM scratch\n')
  await assert.rejects(
    cmdDeploy(ctx, ['.'], { project: 'cl', name: 'web', context: '.' }),
    (err: unknown) => err instanceof UsageError && /--context is for workers/.test(err.message)
  )
  await assert.rejects(
    cmdDeploy(ctx, ['./apps/w'], { project: 'cl', dockerfile: 'x' }),
    (err: unknown) => err instanceof UsageError && /for apps/.test(err.message)
  )
})

// Issue #75: `hobby cron ls`.
test('hobby cron ls lists each schedule with next and last, and says so when there are none', async () => {
  const out: string[] = []
  const api = {
    async listProjects() {
      return { projects: [{ name: 'blog' }, { name: 'quiet' }] }
    },
    async listCrons(name: string) {
      if (name !== 'blog') return { crons: [] }
      return {
        crons: [
          { worker: 'blog/nightly', resourceId: 'w1', cron: '0 3 * * *', nextAt: '2026-10-30T03:00:00.000Z', lastAt: null, lastOutcome: null },
          {
            worker: 'blog/nightly',
            resourceId: 'w1',
            cron: '*/15 * * * *',
            nextAt: '2026-10-29T12:15:00.000Z',
            lastAt: '2026-10-29T12:00:00.000Z',
            lastOutcome: { outcome: 'exception', detail: 'scheduled() threw' },
          },
        ],
      }
    },
  }
  const ctx = {
    io: { out: (s: string) => out.push(s), err: () => {}, env: {}, cwd: '/tmp', readLine: async () => '' },
    api: api as unknown as Api,
    paths: {} as Ctx['paths'],
    config: {} as Ctx['config'],
  } as Ctx

  assert.equal(await cmdCron(ctx, ['ls'], {}), 0)
  assert.deepEqual(out, [
    'blog/nightly  "0 3 * * *"  next 2026-10-30T03:00:00.000Z  last not yet',
    'blog/nightly  "*/15 * * * *"  next 2026-10-29T12:15:00.000Z  last 2026-10-29T12:00:00.000Z (exception)',
  ])

  out.length = 0
  assert.equal(await cmdCron(ctx, ['ls', 'quiet'], {}), 0)
  assert.deepEqual(out, ['no worker in quiet declares a cron trigger'])

  out.length = 0
  assert.equal(await cmdCron(ctx, ['ls', 'blog', '--json'], { json: true }), 0)
  assert.equal((JSON.parse(out[0] as string) as { crons: unknown[] }).crons.length, 2)
  await assert.rejects(cmdCron(ctx, ['frob'], {}), UsageError)
})

// Issue #81: --port and --database used to be accepted and dropped on a
// redeploy, so the obvious fix for a wrong port did nothing.
test('hobby deploy --port and --database reach the redeploy as containerPort and databaseResourceId', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'hobby-redeploy-flags-'))
  mkdirSync(join(cwd, 'site'))
  writeFileSync(join(cwd, 'site', 'Dockerfile'), 'FROM scratch\n')
  const { ctx, recorded } = fakeCtx({
    cwd,
    existingResources: [
      { id: 'a1', name: 'site', kind: 'app' },
      { id: 'db1', name: 'primary', kind: 'postgres' },
    ],
  })

  assert.equal(await cmdDeploy(ctx, ['./site'], { project: 'blog', port: '8080', database: 'primary' }), 0)

  assert.deepEqual(recorded.deploys, [
    { id: 'a1', input: { source: { path: join(cwd, 'site') }, containerPort: 8080, databaseResourceId: 'db1' } },
  ])
})

// Issue #87 and #77: a worker is named after its manifest's `name`, as
// wrangler names it, and a directory with only a wrangler.json is a worker.
test('hobby deploy names a worker after the manifest, and detects wrangler.json', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'hobby-worker-name-'))
  mkdirSync(join(cwd, 'my-worker-dir'))
  writeFileSync(
    join(cwd, 'my-worker-dir', 'wrangler.json'),
    JSON.stringify({ name: 'api', main: 'src/index.ts', compatibility_date: '2026-08-01' })
  )
  const { ctx, recorded } = fakeCtx({ cwd })

  assert.equal(await cmdDeploy(ctx, ['./my-worker-dir'], { project: 'blog' }), 0)
  assert.deepEqual(recorded.resources, ['blog/api'])
  assert.equal(recorded.resourceBodies[0]?.body.kind, 'worker')

  // --name still wins over the manifest.
  recorded.resources.length = 0
  assert.equal(await cmdDeploy(ctx, ['./my-worker-dir'], { project: 'blog', name: 'other' }), 0)
  assert.deepEqual(recorded.resources, ['blog/other'])

  // A manifest with no name falls back to the directory.
  mkdirSync(join(cwd, 'nameless'))
  writeFileSync(join(cwd, 'nameless', 'wrangler.toml'), 'main = "src/index.ts"\ncompatibility_date = "2026-08-01"\n')
  recorded.resources.length = 0
  assert.equal(await cmdDeploy(ctx, ['./nameless'], { project: 'blog' }), 0)
  assert.deepEqual(recorded.resources, ['blog/nameless'])
})

// Issue #80: a deploy that created its project and then failed must not
// leave the empty project behind. One that left a resource (a failed first
// deploy with a row the user will retry) keeps it.
test('hobby deploy removes a project it created when the deploy fails and left nothing in it', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'hobby-deploy-rollback-'))
  mkdirSync(join(cwd, 'site'))
  writeFileSync(join(cwd, 'site', 'Dockerfile'), 'FROM scratch\n')
  const boom = new HobbyError('invalid_name', 'j is too short')

  const empty = fakeCtx({ cwd, projectMissing: true, failResource: boom })
  await assert.rejects(cmdDeploy(empty.ctx, ['./site'], { project: 'fresh', name: 'j' }), (err: unknown) => err === boom)
  assert.deepEqual(empty.recorded.created, ['fresh'])
  assert.deepEqual(empty.recorded.deleted, ['fresh'], 'the empty project this deploy created is removed again')

  const occupied = fakeCtx({
    cwd,
    projectMissing: true,
    failResource: boom,
    existingResources: [{ id: 'a1', name: 'site', kind: 'app', state: 'failed' }],
  })
  await assert.rejects(cmdDeploy(occupied.ctx, ['./site'], { project: 'fresh' }))
  assert.deepEqual(occupied.recorded.deleted, [], 'a project with a resource in it is left alone')

  // An existing project is never touched by the rollback.
  const existing = fakeCtx({ cwd, failResource: boom })
  await assert.rejects(cmdDeploy(existing.ctx, ['./site'], { project: 'blog' }))
  assert.deepEqual(existing.recorded.deleted, [])
})

// Issue #93: the build output reaches the terminal. On failure, as a block
// on stderr with the hint pointing at it; on success, only under --verbose.
test('hobby deploy prints the build output on a build failure, and on success only with --verbose', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'hobby-build-output-'))
  mkdirSync(join(cwd, 'site'))
  writeFileSync(join(cwd, 'site', 'Dockerfile'), 'FROM scratch\n')
  const err: string[] = []
  const out: string[] = []
  let fail = true
  const api = {
    async getProject() {
      return { project: { id: 'p1', name: 'blog' }, resources: [{ id: 'a1', name: 'site', kind: 'app' }] }
    },
    async deployResource() {
      if (fail) {
        throw new HobbyError('build_failed', 'docker build failed for hobby/blog-site:1', 'Step 1/3 : FROM scratch\nerror: boom\n')
      }
      return {
        resource: { id: 'a1', kind: 'app', name: 'site', state: 'sleeping', config: { image: 'img:2', hostname: 'site.blog.localhost' } },
        image: 'img:2',
        logs: 'Step 1/3 : FROM scratch\nSuccessfully built abc\n',
        url: 'http://site.blog.localhost:7433',
      }
    },
  }
  const ctx = {
    io: { out: (s: string) => out.push(s), err: (s: string) => err.push(s), env: {}, cwd, readLine: async () => '' },
    api: api as unknown as Api,
    paths: {} as Ctx['paths'],
    config: {} as Ctx['config'],
  } as Ctx

  await assert.rejects(cmdDeploy(ctx, ['./site'], { project: 'blog' }), (thrown: unknown) => {
    assert.ok(thrown instanceof HobbyError)
    assert.equal(thrown.code, 'build_failed')
    assert.equal(thrown.hint, 'the build output is above')
    return true
  })
  assert.deepEqual(err, ['build output:', '  Step 1/3 : FROM scratch', '  error: boom'])

  // Under --json the error keeps its hint for the envelope, and nothing is
  // printed as text.
  err.length = 0
  await assert.rejects(cmdDeploy(ctx, ['./site'], { project: 'blog', json: true }), (thrown: unknown) => {
    assert.ok(thrown instanceof HobbyError)
    assert.match(thrown.hint ?? '', /error: boom/)
    return true
  })
  assert.deepEqual(err, [])

  fail = false
  assert.equal(await cmdDeploy(ctx, ['./site'], { project: 'blog' }), 0)
  assert.deepEqual(err, [], 'a successful build is quiet by default')
  // Issue #94: the URL is the daemon's, not a hard-coded https://.
  assert.ok(out.includes('  url       http://site.blog.localhost:7433'))

  err.length = 0
  assert.equal(await cmdDeploy(ctx, ['./site'], { project: 'blog', verbose: true }), 0)
  assert.deepEqual(err, ['build output:', '  Step 1/3 : FROM scratch', '  Successfully built abc'])
})

// Issue #114: without psql the connection string is still printed, and the
// hint says how to install it.
test('hobby connect without psql on PATH prints the connection string and an install hint, exit 1', async () => {
  const out: string[] = []
  const err: string[] = []
  const api = {
    async getProject() {
      return { project: { id: 'p1', name: 'blog' }, resources: [{ id: 'r1', kind: 'postgres', name: 'primary' }] }
    },
    async getConnection() {
      return { connectionString: 'postgres://postgres:secret@127.0.0.1:5432/blog' }
    },
  }
  const ctx = {
    io: {
      out: (s: string) => out.push(s),
      err: (s: string) => err.push(s),
      env: { PATH: mkdtempSync(join(tmpdir(), 'hobby-no-psql-')) },
      cwd: '/tmp',
      readLine: async () => '',
    },
    api: api as unknown as Api,
    paths: {} as Ctx['paths'],
    config: {} as Ctx['config'],
  } as Ctx

  assert.equal(await cmdConnect(ctx, ['blog'], {}), 1)
  assert.deepEqual(out, ['postgres://postgres:secret@127.0.0.1:5432/blog'])
  assert.equal(err[0], 'psql was not found on PATH')
  assert.ok(err.some((line) => line.includes('brew install libpq')))
  assert.ok(err.some((line) => line.includes('apt install postgresql-client')))
})
