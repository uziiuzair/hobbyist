// cmdNew against a fake Api. Nothing here touches the daemon, Docker or a
// socket: the command is three API calls and the decisions it makes between
// them, and those decisions are what these pin.

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { HobbyError } from '@hobby.sh/core'
import { cmdNew, type Ctx } from '../src/index.js'
import type { Api } from '../src/cli/client.js'

interface Recorded {
  created: string[]
  resources: string[]
  deleted: string[]
}

// Only the four methods cmdNew reaches for. Casting a partial through unknown
// rather than stubbing all of Api keeps the fake honest about what this
// command actually depends on: add a call to cmdNew and this fails loudly
// rather than silently returning undefined.
function fakeCtx(opts: { failResource?: Error; failDelete?: Error } = {}): {
  ctx: Ctx
  recorded: Recorded
  out: string[]
  err: string[]
} {
  const recorded: Recorded = { created: [], resources: [], deleted: [] }
  const out: string[] = []
  const err: string[] = []

  const api = {
    async createProject(name: string) {
      recorded.created.push(name)
      return { project: { id: 'p1', name, networkName: `hobby-${name}`, sleepAfterSeconds: 300, createdAt: new Date() } }
    },
    async createResource(projectName: string, body: { kind: string; name: string }) {
      recorded.resources.push(`${projectName}/${body.name}`)
      if (opts.failResource !== undefined) throw opts.failResource
      return { resource: { id: 'r1' } }
    },
    async getConnection(_id: string) {
      return { connectionString: 'postgres://postgres:secret@127.0.0.1:5432/blog' }
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
      cwd: '/tmp',
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
