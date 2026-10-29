// cmdNew, cmdCreate and cmdDeploy against a fake Api. Nothing here touches
// the daemon, Docker or a socket: each command is a handful of API calls and
// the decisions it makes between them, and those decisions are what these
// pin.

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { HobbyError } from '@hobby.sh/core'
import {
  cmdConnect,
  cmdCreate,
  cmdDeploy,
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
    existingResources?: Array<{ id: string; name: string; kind: string }>
    cwd?: string
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

test('hobby unpin without a flag falls back to the box default', async () => {
  const { ctx, recorded } = fakeCtx()
  ctx.config = { ...ctx.config, sleepAfterSeconds: 300 }

  const code = await cmdUnpin(ctx, ['prod'], {})

  assert.equal(code, 0)
  assert.deepEqual(recorded.sleepPolicies, [{ project: 'prod', sleepAfterSeconds: 300 }])
})

test('hobby unpin refuses to guess when the box default is itself null', async () => {
  const { ctx, recorded } = fakeCtx()
  ctx.config = { ...ctx.config, sleepAfterSeconds: null }

  await assert.rejects(cmdUnpin(ctx, ['prod'], {}), UsageError)
  assert.deepEqual(recorded.sleepPolicies, [], 'nothing was sent')
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
  const { ctx } = fakeCtx({ existingResources: [{ id: 'x1', name: 'site', kind: 'postgres' }] })

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

test('hobby deploy --env-file refuses a worker and creates nothing', async () => {
  const dir = envFileDir('A=1\n')
  const { ctx, recorded } = fakeCtx({ cwd: dir })

  await assert.rejects(
    () => cmdDeploy(ctx, ['./api'], { project: 'blog', kind: 'worker', 'env-file': '.env.production' }),
    (err: unknown) => err instanceof UsageError && /wrangler/.test(err.message)
  )
  assert.deepEqual(recorded.created, [])
  assert.deepEqual(recorded.resources, [])
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
