// `hobby pg ext ls|add|rm` and `--extension` on `hobby new` / `hobby pg
// create`: what each sends to the daemon API, which CLI and MCP share.

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { cmdNew, cmdPg, UsageError, type Ctx } from '../src/index.js'
import type { Api } from '../src/cli/client.js'

const report = {
  extensions: {
    declared: ['pg_trgm'],
    installed: [
      { name: 'pg_trgm', version: '1.6' },
      { name: 'plpgsql', version: '1.0' },
    ],
    missing: [],
  },
}

function fakeCtx(opts: { kind?: string; linked?: string } = {}): { ctx: Ctx; calls: string[]; out: string[] } {
  const calls: string[] = []
  const out: string[] = []
  const project = { id: 'p1', name: 'blog', networkName: 'hobby-blog', sleepAfterSeconds: 300, createdAt: new Date() }
  const api = {
    async createProject() {
      return { project }
    },
    async getProject() {
      return { project, resources: [{ id: 'r1', name: 'primary', kind: opts.kind ?? 'postgres', state: 'sleeping', config: {} }] }
    },
    async createResource(name: string, body: unknown) {
      calls.push(`createResource ${name} ${JSON.stringify(body)}`)
      return { resource: { id: 'r1', kind: 'postgres', name: 'primary', state: 'sleeping', config: {} } }
    },
    async getConnection() {
      return { connectionString: 'postgres://u:p@127.0.0.1:5432/blog', tailnetConnectionString: null }
    },
    async getExtensions(id: string) {
      calls.push(`getExtensions ${id}`)
      return report
    },
    async setExtensions(id: string, input: unknown) {
      calls.push(`setExtensions ${id} ${JSON.stringify(input)}`)
      return { ...report, removed: [] }
    },
  }
  const ctx = {
    io: { out: (s: string) => out.push(s), err: () => {}, env: {}, cwd: '/tmp', readLine: async () => '' },
    api: api as unknown as Api,
    paths: {} as Ctx['paths'],
    config: { project: opts.linked ?? null } as Ctx['config'],
  } as Ctx
  return { ctx, calls, out }
}

test('hobby new --extension sends the list on the postgres create; without it the body has no field', async () => {
  const a = fakeCtx()
  await cmdNew(a.ctx, ['blog'], { extension: ['vector', 'pg_trgm'] })
  assert.deepEqual(a.calls, ['createResource blog {"kind":"postgres","name":"primary","extensions":["vector","pg_trgm"]}'])
  const b = fakeCtx()
  await cmdNew(b.ctx, ['blog'], {})
  assert.deepEqual(b.calls, ['createResource blog {"kind":"postgres","name":"primary"}'])
})

test('hobby pg create --extension sends the list too', async () => {
  const { ctx, calls } = fakeCtx()
  await cmdPg(ctx, ['create', 'analytics'], { project: 'blog', extension: ['hstore'], json: true })
  assert.deepEqual(calls, ['createResource blog {"kind":"postgres","name":"analytics","extensions":["hstore"]}'])
})

test('hobby pg ext <target> and hobby pg ext ls <target> both read, and print versions', async () => {
  const { ctx, calls, out } = fakeCtx()
  assert.equal(await cmdPg(ctx, ['ext', 'blog'], {}), 0)
  assert.equal(await cmdPg(ctx, ['ext', 'ls', 'blog'], {}), 0)
  assert.deepEqual(calls, ['getExtensions r1', 'getExtensions r1'])
  assert.ok(out.includes('    pg_trgm 1.6'))
  assert.ok(out.includes('    plpgsql 1.0  (not declared)'))
})

test('hobby pg ext add and rm send add and remove; rm says nothing was dropped', async () => {
  const { ctx, calls, out } = fakeCtx()
  await cmdPg(ctx, ['ext', 'add', 'blog', 'pg_trgm', 'hstore'], {})
  await cmdPg(ctx, ['ext', 'rm', 'blog', 'hstore'], {})
  assert.deepEqual(calls, ['setExtensions r1 {"add":["pg_trgm","hstore"]}', 'setExtensions r1 {"remove":["hstore"]}'])
  assert.ok(out.some((line) => line.startsWith('undeclared only. Nothing was dropped')))
})

test('in a linked directory, hobby pg ext add <ext> reads the one argument as the extension', async () => {
  const { ctx, calls } = fakeCtx({ linked: 'blog' })
  await cmdPg(ctx, ['ext', 'add', 'pg_trgm'], {})
  assert.deepEqual(calls, ['setExtensions r1 {"add":["pg_trgm"]}'])
})

test('hobby pg ext on an app, or with no extension names, is a usage error with no API write', async () => {
  const app = fakeCtx({ kind: 'app' })
  await assert.rejects(cmdPg(app.ctx, ['ext', 'add', 'blog', 'vector'], {}), UsageError)
  assert.deepEqual(app.calls, [])
  const empty = fakeCtx()
  await assert.rejects(cmdPg(empty.ctx, ['ext', 'add', 'blog'], {}), UsageError)
  await assert.rejects(cmdPg(empty.ctx, ['bogus'], {}), UsageError)
})
