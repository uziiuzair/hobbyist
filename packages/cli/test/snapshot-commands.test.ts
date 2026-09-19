// `hobby snapshot` against a fake Api, the same shape commands.test.ts uses:
// each command is a handful of API calls and the decisions between them,
// and those decisions (which subcommand, which flags reach the wire, when to
// ask before destroying something) are what these pin. The routes behind
// them are exercised for real in snapshot-routes.test.ts.

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { HobbyError } from '@hobby.sh/core'
import { cmdSnapshot, UsageError, type Ctx } from '../src/index.js'
import type { Api } from '../src/cli/client.js'

const ID = '20260919t120000z-a1b2c3'

function manifest(id: string) {
  return {
    version: 1 as const,
    snapshotId: id,
    createdAt: '2026-09-19T12:00:00.000Z',
    clone: 'reflink' as const,
    project: { name: 'blog', sleepAfterSeconds: 300 },
    resources: [],
    verification: { status: 'unverified' as const, at: null, detail: null },
  }
}

// Only what `hobby snapshot` reaches for, cast through unknown for the same
// reason commands.test.ts gives: a new call to anything else fails loudly.
function fakeCtx(typed: string[] = []): { ctx: Ctx; calls: string[]; out: string[]; err: string[] } {
  const calls: string[] = []
  const out: string[] = []
  const err: string[] = []
  const api = {
    async takeSnapshot(project: string, opts?: { allowPause?: boolean }) {
      calls.push(`takeSnapshot ${project} ${JSON.stringify(opts ?? {})}`)
      return { snapshot: manifest(ID), dir: `/home/u/.hobby/snapshots/${project}/${ID}`, resources: [] }
    },
    async listSnapshots(project: string) {
      calls.push(`listSnapshots ${project}`)
      return { snapshots: [manifest(ID)] }
    },
    async restoreSnapshot(id: string, opts?: Record<string, unknown>) {
      calls.push(`restoreSnapshot ${id} ${JSON.stringify(opts ?? {})}`)
      return {
        project: { id: 'p1', name: opts?.['inPlace'] === true ? 'blog' : 'blog-restored' },
        resources: [],
        restartFailures: [],
        preRestoreDir: null,
      }
    },
    async deleteSnapshot(id: string) {
      calls.push(`deleteSnapshot ${id}`)
      return { deleted: true as const }
    },
  }
  const ctx = {
    io: {
      out: (s: string) => out.push(s),
      err: (s: string) => err.push(s),
      env: {},
      cwd: '/tmp',
      readLine: async () => typed.shift() ?? '',
    },
    api: api as unknown as Api,
  } as unknown as Ctx
  return { ctx, calls, out, err }
}

test('hobby snapshot <project> takes one, sends allowPause only when asked, and states its limits', async () => {
  const plain = fakeCtx()
  assert.equal(await cmdSnapshot(plain.ctx, ['blog'], {}), 0)
  assert.deepEqual(plain.calls, ['takeSnapshot blog {"allowPause":false}'])
  assert.ok(plain.out.some((line) => line.includes(ID)))
  assert.ok(plain.err.some((line) => line.includes('not losing this disk')))

  const allowed = fakeCtx()
  await cmdSnapshot(allowed.ctx, ['blog'], { 'allow-pause': true })
  assert.deepEqual(allowed.calls, ['takeSnapshot blog {"allowPause":true}'])
})

test('hobby snapshot --json prints exactly the API response', async () => {
  const { ctx, out } = fakeCtx()
  await cmdSnapshot(ctx, ['blog'], { json: true })
  assert.equal(out.length, 1)
  assert.equal((JSON.parse(out[0] as string) as { snapshot: { snapshotId: string } }).snapshot.snapshotId, ID)

  const listed = fakeCtx()
  await cmdSnapshot(listed.ctx, ['ls', 'blog'], { json: true })
  assert.deepEqual(JSON.parse(listed.out[0] as string), { snapshots: [manifest(ID)] })
})

test('hobby snapshot restore defaults to a new project and never asks', async () => {
  const { ctx, calls } = fakeCtx()
  assert.equal(await cmdSnapshot(ctx, ['restore', 'blog', ID], {}), 0)
  assert.deepEqual(calls, ['listSnapshots blog', `restoreSnapshot ${ID} {"allowPause":false}`])
})

test('hobby snapshot restore --in-place asks for the project name, and a wrong answer restores nothing', async () => {
  const refused = fakeCtx(['blgo'])
  assert.equal(await cmdSnapshot(refused.ctx, ['restore', 'blog', ID], { 'in-place': true }), 1)
  assert.ok(!refused.calls.some((call) => call.startsWith('restoreSnapshot')))

  const confirmed = fakeCtx(['blog'])
  assert.equal(await cmdSnapshot(confirmed.ctx, ['restore', 'blog', ID], { 'in-place': true, 'allow-pause': true }), 0)
  assert.ok(confirmed.calls.includes(`restoreSnapshot ${ID} {"inPlace":true,"allowPause":true}`))
})

test('hobby snapshot restore refuses an id that is not one of that project\'s snapshots', async () => {
  const { ctx, calls } = fakeCtx()
  await assert.rejects(
    cmdSnapshot(ctx, ['restore', 'blog', '20260101t000000z-ffffff'], { 'in-place': true, yes: true }),
    (err: unknown) => err instanceof HobbyError && err.code === 'resource_not_found'
  )
  assert.ok(!calls.some((call) => call.startsWith('restoreSnapshot')))
})

test('hobby snapshot restore rejects --as with --in-place before calling anything', async () => {
  const { ctx, calls } = fakeCtx()
  await assert.rejects(
    cmdSnapshot(ctx, ['restore', 'blog', ID], { as: 'other', 'in-place': true }),
    (err: unknown) => err instanceof UsageError
  )
  assert.deepEqual(calls, [])
})

test('hobby snapshot rm asks for the id unless --yes', async () => {
  const refused = fakeCtx(['nope'])
  assert.equal(await cmdSnapshot(refused.ctx, ['rm', 'blog', ID], {}), 1)
  assert.ok(!refused.calls.some((call) => call.startsWith('deleteSnapshot')))

  const confirmed = fakeCtx()
  assert.equal(await cmdSnapshot(confirmed.ctx, ['rm', 'blog', ID], { yes: true }), 0)
  assert.ok(confirmed.calls.includes(`deleteSnapshot ${ID}`))
})
