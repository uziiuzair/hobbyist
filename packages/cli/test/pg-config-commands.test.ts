// `hobby pg config ls|set|unset` and `--setting` on `hobby new` / `hobby pg
// create`: what each sends to the daemon API, which CLI and MCP share, and
// what it prints.

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { cmdNew, cmdPg, UsageError, type Ctx } from '../src/index.js'
import type { Api } from '../src/cli/client.js'

const available = [
  { name: 'shared_buffers', type: 'memory', context: 'postmaster', restartRequired: true, default: '128MB', summary: 'cache', docs: 'https://x', min: '1MB', max: '8GB' },
  { name: 'jit', type: 'bool', context: 'user', restartRequired: false, default: 'on', summary: 'jit', docs: 'https://x' },
]

function fakeCtx(opts: { linked?: string; applied?: string } = {}): { ctx: Ctx; calls: string[]; out: string[] } {
  const calls: string[] = []
  const out: string[] = []
  const project = { id: 'p1', name: 'blog', networkName: 'hobby-blog', sleepAfterSeconds: 300, createdAt: new Date() }
  const resource = { id: 'r1', name: 'primary', kind: 'postgres', state: 'sleeping', config: {} }
  const api = {
    async createProject() {
      return { project }
    },
    async getProject() {
      return { project, resources: [resource] }
    },
    async createResource(name: string, body: unknown) {
      calls.push(`createResource ${name} ${JSON.stringify(body)}`)
      return { resource }
    },
    async getConnection() {
      return { connectionString: 'postgres://user:password@127.0.0.1:5432/blog', tailnetConnectionString: null }
    },
    async getSettings(id: string) {
      calls.push(`getSettings ${id}`)
      return {
        settings: { shared_buffers: '256MB' },
        needsPreload: [{ extension: 'pg_stat_statements', library: 'pg_stat_statements', allowed: true }],
        available,
      }
    },
    async setSettings(id: string, input: unknown) {
      calls.push(`setSettings ${id} ${JSON.stringify(input)}`)
      return { resource, settings: { jit: 'off' }, applied: opts.applied ?? 'next-start', pausedMs: opts.applied === 'restarted' ? 1200 : null, needsPreload: [] }
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

test('hobby new --setting and hobby pg create --setting send settings on the postgres create', async () => {
  const a = fakeCtx()
  await cmdNew(a.ctx, ['blog'], { setting: ['shared_preload_libraries=pg_stat_statements', 'work_mem=16MB'], extension: 'pg_stat_statements' })
  assert.deepEqual(a.calls, [
    'createResource blog {"kind":"postgres","name":"primary","extensions":["pg_stat_statements"],"settings":{"shared_preload_libraries":"pg_stat_statements","work_mem":"16MB"}}',
  ])
  const b = fakeCtx()
  await cmdPg(b.ctx, ['create', 'analytics'], { project: 'blog', setting: 'jit=off', json: true })
  assert.deepEqual(b.calls, ['createResource blog {"kind":"postgres","name":"analytics","settings":{"jit":"off"}}'])
  await assert.rejects(cmdNew(fakeCtx().ctx, ['blog'], { setting: 'jit' }), UsageError)
})

test('hobby pg config <target> reads without waking, marks a missing preload, and --all lists the allowlist', async () => {
  const { ctx, calls, out } = fakeCtx()
  assert.equal(await cmdPg(ctx, ['config', 'blog'], {}), 0)
  assert.deepEqual(calls, ['getSettings r1'])
  assert.ok(out.includes('  shared_buffers = 256MB  (default 128MB)'))
  assert.ok(out.some((line) => line.includes('! pg_stat_statements needs pg_stat_statements') && line.includes('hobby pg config set blog/primary shared_preload_libraries=pg_stat_statements')))
  assert.ok(!out.some((line) => line.startsWith('  jit ')))
  const all = fakeCtx()
  await cmdPg(all.ctx, ['config', 'ls', 'blog'], { all: true })
  assert.ok(all.out.includes('  shared_buffers  1MB..8GB  (default 128MB, restart)  cache'))
  assert.ok(all.out.includes('  jit  bool  (default on)  jit'))
})

test('hobby pg config set and unset send set, unset and allowPause, and say how it was applied', async () => {
  const set = fakeCtx()
  await cmdPg(set.ctx, ['config', 'set', 'blog', 'jit=off', 'work_mem=8MB'], {})
  assert.deepEqual(set.calls, ['setSettings r1 {"set":{"jit":"off","work_mem":"8MB"},"allowPause":false}'])
  assert.ok(set.out.some((line) => line.includes('asleep: the settings apply when it next wakes')))

  const restarted = fakeCtx({ applied: 'restarted' })
  await cmdPg(restarted.ctx, ['config', 'unset', 'blog', 'jit'], { 'allow-pause': true })
  assert.deepEqual(restarted.calls, ['setSettings r1 {"unset":["jit"],"allowPause":true}'])
  assert.ok(restarted.out.includes('restarted with the new settings (paused 1200ms).'))
})

test('in a linked directory the target can be left out', async () => {
  const set = fakeCtx({ linked: 'blog' })
  await cmdPg(set.ctx, ['config', 'set', 'jit=off'], {})
  assert.deepEqual(set.calls, ['setSettings r1 {"set":{"jit":"off"},"allowPause":false}'])
  const unset = fakeCtx({ linked: 'blog' })
  await cmdPg(unset.ctx, ['config', 'unset', 'jit'], {})
  assert.deepEqual(unset.calls, ['setSettings r1 {"unset":["jit"],"allowPause":false}'])
  await assert.rejects(cmdPg(fakeCtx().ctx, ['config', 'set', 'jit=off'], {}), UsageError)
})
