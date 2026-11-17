// Pure tests against a fake Api: no socket, no Docker, no network. Each
// test checks that a tool calls exactly the daemon route(s) documented in
// packages/cli/src/daemon/routes.ts, with the arguments the brief
// documents, and nothing else. The hobby_rm-without-confirm test is the one
// the task brief calls out by name: it must return an error and the fake
// Api must record zero calls.

import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Api, BranchResponse, ConnectionResponse, DeletedResponse, LogsResponse, ProjectDetailResponse, ProjectsResponse, ResourceResponse, WireResource } from '@hobby.sh/cli'
import type { Project } from '@hobby.sh/core'
import {
  branchTool,
  connectionStringTool,
  diffTool,
  envListTool,
  envSetTool,
  envUnsetTool,
  expireTool,
  listTool,
  logsTool,
  newTool,
  pgExtAddTool,
  pgExtListTool,
  pgExtRmTool,
  resetTool,
  rmTool,
  sleepTool,
  wakeTool,
  type ToolResult,
} from '../src/tools.js'

function project(name: string, id = `${name}-id`): Project {
  return { id, name, networkName: `hobby-${name}`, sleepAfterSeconds: 300, createdAt: new Date('2026-01-01'), releasedAt: null, parentId: null, expiresAt: null }
}

// The daemon's wire shape (WireResource, packages/cli/src/daemon/wire.ts):
// no config.password (see routes.ts's toWireResource), sizeBytes and
// connectionCount present instead. This fixture never carries a password at
// all, which is the point: it stands in for what the real daemon actually
// sends now, not the richer internal record it used to leak.
function resource(name: string, projectId: string, id = `${name}-id`): WireResource {
  return {
    id,
    projectId,
    kind: 'postgres',
    name,
    state: 'running',
    config: {
      image: 'postgres:18-alpine',
      containerName: `hobby-${projectId}-${name}`,
      dataDir: '/x/pgdata',
      hostPort: 15432,
      superuser: 'postgres',
      database: projectId,
    },
    sizeBytes: null,
    connectionCount: 0,
    lastActiveAt: null,
    createdAt: new Date('2026-01-01'),
  }
}

// Records every call made against it (method name, then its arguments,
// stringified) and answers from fixed tables keyed by project name /
// resource id, set up per test. Any Api method not stubbed for a given
// test throws, so a tool that calls a route it should not touch fails the
// test loudly rather than silently returning undefined.
function fakeApi(overrides: Partial<Api>): { api: Api; calls: string[] } {
  const calls: string[] = []
  const notWired = (name: string) => () => {
    throw new Error(`unexpected call: ${name} (test did not wire this route)`)
  }
  const base: Api = {
    health: notWired('health'),
    version: notWired('version'),
    setEnv: notWired('setEnv'),
    getExtensions: notWired('getExtensions'),
    setExtensions: notWired('setExtensions'),
    listCrons: notWired('listCrons'),
    listProjects: notWired('listProjects'),
    createProject: notWired('createProject'),
    setSleepPolicy: notWired('setSleepPolicy'),
    getAllowlist: notWired('getAllowlist'),
    setAllowlist: notWired('setAllowlist'),
    clearAllowlist: notWired('clearAllowlist'),
    getProject: notWired('getProject'),
    branchProject: notWired('branchProject'),
    resetBranch: notWired('resetBranch'),
    setExpiry: notWired('setExpiry'),
    diffSchemas: notWired('diffSchemas'),
    deleteProject: notWired('deleteProject'),
    createResource: notWired('createResource'),
    deployResource: notWired('deployResource'),
    getResource: notWired('getResource'),
    deleteResource: notWired('deleteResource'),
    startResource: notWired('startResource'),
    stopResource: notWired('stopResource'),
    getConnection: notWired('getConnection'),
    getLogs: notWired('getLogs'),
    eject: notWired('eject'),
    adopt: notWired('adopt'),
    listQueues: notWired('listQueues'),
    createQueue: notWired('createQueue'),
    peekQueue: notWired('peekQueue'),
    sendMessage: notWired('sendMessage'),
    purgeQueue: notWired('purgeQueue'),
    setRetention: notWired('setRetention'),
    takeSnapshot: notWired('takeSnapshot'),
    listSnapshots: notWired('listSnapshots'),
    restoreSnapshot: notWired('restoreSnapshot'),
    deleteSnapshot: notWired('deleteSnapshot'),
  }
  const api = { ...base } as unknown as Record<string, unknown>
  for (const [key, fn] of Object.entries(overrides)) {
    api[key] = (...args: unknown[]) => {
      calls.push(`${key}(${args.map((a) => JSON.stringify(a)).join(', ')})`)
      return (fn as (...a: unknown[]) => unknown)(...args)
    }
  }
  return { api: api as unknown as Api, calls }
}

function resultText(result: ToolResult): unknown {
  const first = result.content[0]
  assert.ok(first !== undefined)
  return JSON.parse(first.text)
}

test('hobby_list: GET /v1/projects then GET /v1/projects/:name per project, no password in any resource', async () => {
  const p = project('blog')
  const { api, calls } = fakeApi({
    listProjects: async (): Promise<ProjectsResponse> => ({ projects: [p] }),
    getProject: async (name: string): Promise<ProjectDetailResponse> => {
      assert.equal(name, 'blog')
      return { project: p, resources: [resource('primary', p.id)] }
    },
  })

  const result = await listTool(api)
  assert.equal(result.isError, undefined)
  assert.deepEqual(calls, ['listProjects()', 'getProject("blog")'])

  const body = resultText(result) as { projects: Array<{ resources: WireResource[] }> }
  const config = body.projects[0]?.resources[0]?.config as Record<string, unknown> | undefined
  assert.equal(config?.password, undefined)
  assert.ok(config !== undefined && !('password' in config), 'the wire config must not carry a password key at all')
})

test('hobby_new: POST /v1/projects then POST /v1/projects/:name/resources with name "primary", no connection call', async () => {
  const p = project('blog')
  const { api, calls } = fakeApi({
    createProject: async (name: string) => {
      assert.equal(name, 'blog')
      return { project: p }
    },
    createResource: async (projectName: string, input: { kind: 'postgres'; name: string }): Promise<ResourceResponse> => {
      assert.equal(projectName, 'blog')
      assert.deepEqual(input, { kind: 'postgres', name: 'primary' })
      return { resource: resource('primary', p.id) }
    },
  })

  const result = await newTool(api, { name: 'blog' })
  assert.equal(result.isError, undefined)
  assert.deepEqual(calls, ['createProject("blog")', 'createResource("blog", {"kind":"postgres","name":"primary"})'])

  const body = resultText(result) as { resource: WireResource }
  const config = body.resource.config as unknown as Record<string, unknown>
  assert.equal(config.password, undefined)
})

test('hobby_branch: one POST /v1/projects/:name/branch, allowPause false unless the agent set it', async () => {
  const branched: BranchResponse = {
    project: project('blog-exp'),
    resources: [],
    clone: 'reflink',
    paused: [],
    pausedMs: null,
    resumeFailures: [],
  }
  const { api, calls } = fakeApi({
    branchProject: async () => branched,
  })

  const plain = await branchTool(api, { source: 'blog', name: 'blog-exp' })
  assert.equal(plain.isError, undefined)
  const allowed = await branchTool(api, { source: 'blog', name: 'blog-exp', allowPause: true })
  assert.equal(allowed.isError, undefined)
  assert.deepEqual(calls, [
    'branchProject("blog", "blog-exp", {"allowPause":false})',
    'branchProject("blog", "blog-exp", {"allowPause":true})',
  ])
})

test('hobby_connection_string: resolves the target then GET /v1/resources/:id/connection, password included', async () => {
  const p = project('blog')
  const r = resource('primary', p.id)
  const { api, calls } = fakeApi({
    getProject: async (): Promise<ProjectDetailResponse> => ({ project: p, resources: [r] }),
    getConnection: async (id: string): Promise<ConnectionResponse> => {
      assert.equal(id, r.id)
      return { connectionString: 'postgresql://postgres:super-secret@127.0.0.1:5432/blog' }
    },
  })

  const result = await connectionStringTool(api, { target: 'blog' })
  assert.equal(result.isError, undefined)
  assert.deepEqual(calls, ['getProject("blog")', `getConnection("${r.id}")`])
  assert.deepEqual(resultText(result), { connectionString: 'postgresql://postgres:super-secret@127.0.0.1:5432/blog' })
})

test('hobby_sleep: resolves the target then POST /v1/resources/:id/stop', async () => {
  const p = project('blog')
  const r = resource('primary', p.id)
  const { api, calls } = fakeApi({
    getProject: async (): Promise<ProjectDetailResponse> => ({ project: p, resources: [r] }),
    stopResource: async (id: string): Promise<ResourceResponse> => {
      assert.equal(id, r.id)
      return { resource: { ...r, state: 'sleeping' } }
    },
  })

  const result = await sleepTool(api, { target: 'blog' })
  assert.deepEqual(calls, ['getProject("blog")', `stopResource("${r.id}")`])
  const body = resultText(result) as { resource: WireResource }
  assert.equal(body.resource.state, 'sleeping')
  const config = body.resource.config as unknown as Record<string, unknown>
  assert.equal(config.password, undefined)
})

test('hobby_wake: resolves the target then POST /v1/resources/:id/start', async () => {
  const p = project('blog')
  const r = { ...resource('primary', p.id), state: 'sleeping' as const }
  const { api, calls } = fakeApi({
    getProject: async (): Promise<ProjectDetailResponse> => ({ project: p, resources: [r] }),
    startResource: async (id: string): Promise<ResourceResponse> => {
      assert.equal(id, r.id)
      return { resource: { ...r, state: 'running' } }
    },
  })

  const result = await wakeTool(api, { target: 'blog/primary' })
  assert.deepEqual(calls, ['getProject("blog")', `startResource("${r.id}")`])
  const body = resultText(result) as { resource: WireResource }
  assert.equal(body.resource.state, 'running')
})

test('hobby_logs: resolves the target then GET /v1/resources/:id/logs with tail forwarded', async () => {
  const p = project('blog')
  const r = resource('primary', p.id)
  const { api, calls } = fakeApi({
    getProject: async (): Promise<ProjectDetailResponse> => ({ project: p, resources: [r] }),
    getLogs: async (id: string, tail?: number): Promise<LogsResponse> => {
      assert.equal(id, r.id)
      assert.equal(tail, 50)
      return { logs: 'log line 1\nlog line 2' }
    },
  })

  const result = await logsTool(api, { target: 'blog', tail: 50 })
  assert.deepEqual(calls, ['getProject("blog")', `getLogs("${r.id}", 50)`])
  assert.deepEqual(resultText(result), { logs: 'log line 1\nlog line 2' })
})

test('hobby_rm: without confirm, returns an error and issues no request at all', async () => {
  const { api, calls } = fakeApi({})

  const result = await rmTool(api, { target: 'blog', confirm: false as unknown as true })
  assert.equal(result.isError, true)
  const text = result.content[0]?.text ?? ''
  assert.ok(text.includes('usage:'))
  assert.ok(text.toLowerCase().includes('confirm'))
  assert.deepEqual(calls, [])
})

test('hobby_rm: confirm true and a bare project name calls DELETE /v1/projects/:name directly', async () => {
  const { api, calls } = fakeApi({
    deleteProject: async (name: string): Promise<DeletedResponse> => {
      assert.equal(name, 'blog')
      return { deleted: true }
    },
  })

  const result = await rmTool(api, { target: 'blog', confirm: true })
  assert.equal(result.isError, undefined)
  assert.deepEqual(calls, ['deleteProject("blog")'])
  assert.deepEqual(resultText(result), { deleted: true })
})

test('hobby_rm: confirm true and project/resource resolves the target then DELETE /v1/resources/:id', async () => {
  const p = project('blog')
  const r = resource('primary', p.id)
  const { api, calls } = fakeApi({
    getProject: async (): Promise<ProjectDetailResponse> => ({ project: p, resources: [r] }),
    deleteResource: async (id: string): Promise<DeletedResponse> => {
      assert.equal(id, r.id)
      return { deleted: true }
    },
  })

  const result = await rmTool(api, { target: 'blog/primary', confirm: true })
  assert.equal(result.isError, undefined)
  assert.deepEqual(calls, ['getProject("blog")', `deleteResource("${r.id}")`])
})

// Issue #74: the env tools mirror `hobby env set|ls|unset` over
// POST /v1/resources/:id/env, and none of them returns a value.
function appResource(name: string, projectId: string, env: Record<string, string>): WireResource {
  return {
    id: `${name}-id`,
    projectId,
    kind: 'app',
    name,
    state: 'running',
    config: {
      image: 'img:1',
      containerName: `hobby-${projectId}-${name}`,
      hostPort: 25500,
      containerPort: 8080,
      hostname: `${name}.blog.localhost`,
      source: null,
      env,
      databaseResourceId: null,
    },
    sizeBytes: null,
    connectionCount: 0,
    lastActiveAt: null,
    createdAt: new Date('2026-01-01'),
  }
}

test('hobby_env_set: resolves the target then POST /v1/resources/:id/env with set, returning keys only', async () => {
  const p = project('blog')
  const r = appResource('web', p.id, {})
  const { api, calls } = fakeApi({
    getProject: async (): Promise<ProjectDetailResponse> => ({ project: p, resources: [r] }),
    setEnv: async (id, input) => {
      assert.equal(id, r.id)
      assert.deepEqual(input, { set: { API_KEY: 'sk-secret' } })
      return { resource: { ...r, state: 'sleeping' }, keys: ['API_KEY'], stopped: true }
    },
  })
  const result = await envSetTool(api, { target: 'blog', set: { API_KEY: 'sk-secret' } })
  assert.deepEqual(calls, ['getProject("blog")', `setEnv("${r.id}", {"set":{"API_KEY":"sk-secret"}})`])
  assert.deepEqual(resultText(result), { set: ['API_KEY'], keys: ['API_KEY'], stopped: true })
  assert.ok(!JSON.stringify(result).includes('sk-secret'))
})

test('hobby_env_unset and hobby_env_ls: unset over the same route; ls reads names off the redacted config', async () => {
  const p = project('blog')
  const r = appResource('web', p.id, { B: '<redacted>', A: '<redacted>' })
  const { api } = fakeApi({
    getProject: async (): Promise<ProjectDetailResponse> => ({ project: p, resources: [r] }),
    setEnv: async (_id, input) => {
      assert.deepEqual(input, { unset: ['B'] })
      return { resource: r, keys: ['A'], stopped: false }
    },
  })
  assert.deepEqual(resultText(await envUnsetTool(api, { target: 'blog', keys: ['B'] })), { unset: ['B'], keys: ['A'], stopped: false })
  assert.deepEqual(resultText(await envListTool(api, { target: 'blog' })), { keys: ['A', 'B'] })
})

test('hobby_env_set on a postgres is a usage error, with no env call made', async () => {
  const p = project('blog')
  const r = resource('primary', p.id)
  const { api, calls } = fakeApi({
    getProject: async (): Promise<ProjectDetailResponse> => ({ project: p, resources: [r] }),
  })
  const result = await envSetTool(api, { target: 'blog', set: { A: '1' } })
  assert.equal(result.isError, true)
  assert.match(result.content[0]?.text ?? '', /only an app or a worker/)
  assert.deepEqual(calls, ['getProject("blog")'])
})

test('hobby_pg_ext_ls/add/rm: resolve the target then GET or POST /v1/resources/:id/extensions', async () => {
  const p = project('blog')
  const r = resource('primary', p.id)
  const report = {
    extensions: { declared: ['pg_trgm'], installed: [{ name: 'pg_trgm', version: '1.6' }, { name: 'plpgsql', version: '1.0' }], missing: [] },
  }
  const { api, calls } = fakeApi({
    getProject: async (): Promise<ProjectDetailResponse> => ({ project: p, resources: [r] }),
    getExtensions: async () => report,
    setExtensions: async () => ({ ...report, removed: [] }),
  })
  assert.deepEqual(resultText(await pgExtListTool(api, { target: 'blog' })), report)
  await pgExtAddTool(api, { target: 'blog', extensions: ['pg_trgm'] })
  await pgExtRmTool(api, { target: 'blog', extensions: ['hstore'] })
  assert.deepEqual(calls, [
    'getProject("blog")',
    `getExtensions("${r.id}")`,
    'getProject("blog")',
    `setExtensions("${r.id}", {"add":["pg_trgm"]})`,
    'getProject("blog")',
    `setExtensions("${r.id}", {"remove":["hstore"]})`,
  ])
})

test('hobby_new passes declared extensions on the resource create, and omits the field when none are given', async () => {
  const p = project('blog')
  const r = resource('primary', p.id)
  const { api, calls } = fakeApi({
    createProject: async () => ({ project: p }),
    createResource: async () => ({ resource: r }),
  })
  await newTool(api, { name: 'blog', extensions: ['vector'] })
  await newTool(api, { name: 'blog' })
  assert.equal(calls[1], 'createResource("blog", {"kind":"postgres","name":"primary","extensions":["vector"]})')
  assert.equal(calls[3], 'createResource("blog", {"kind":"postgres","name":"primary"})')
})

test('hobby_pg_ext_add on an app is a usage error, with no extensions call made', async () => {
  const p = project('blog')
  const r = appResource('web', p.id, {})
  const { api, calls } = fakeApi({
    getProject: async (): Promise<ProjectDetailResponse> => ({ project: p, resources: [r] }),
  })
  const result = await pgExtAddTool(api, { target: 'blog', extensions: ['vector'] })
  assert.equal(result.isError, true)
  assert.deepEqual(calls, ['getProject("blog")'])
})

test('hobby_branch: expires is parsed like the CLI flag, and a bad one makes no request', async () => {
  const { api, calls } = fakeApi({
    branchProject: async (): Promise<BranchResponse> => ({
      project: project('blog-exp'),
      resources: [],
      clone: 'reflink',
      paused: [],
      pausedMs: null,
      resumeFailures: [],
    }),
  })
  const ok = await branchTool(api, { source: 'blog', name: 'blog-exp', expires: '7d' })
  assert.equal(ok.isError, undefined)
  const bad = await branchTool(api, { source: 'blog', name: 'blog-exp', expires: 'next week' })
  assert.equal(bad.isError, true)
  assert.deepEqual(calls, ['branchProject("blog", "blog-exp", {"allowPause":false,"expiresInSeconds":604800})'])
})

test('hobby_reset without confirm: true refuses and makes no request', async () => {
  const { api, calls } = fakeApi({})
  const result = await resetTool(api, { branch: 'blog-exp', confirm: false })
  assert.equal(result.isError, true)
  assert.match(result.content[0]?.text ?? '', /confirm must be true/)
  assert.deepEqual(calls, [])
})

test('hobby_reset with confirm: one POST /v1/projects/:name/reset, allowPause only when set', async () => {
  const { api, calls } = fakeApi({
    resetBranch: async () => ({
      project: project('blog-exp'),
      parent: 'blog',
      resources: [],
      clone: 'reflink',
      parentPaused: [],
      parentPausedMs: null,
      parentResumeFailures: [],
      paused: [],
      pausedMs: null,
      restartFailures: [],
      preResetDirs: [],
    }),
  })
  await resetTool(api, { branch: 'blog-exp', confirm: true })
  await resetTool(api, { branch: 'blog-exp', confirm: true, allowPause: true })
  assert.deepEqual(calls, ['resetBranch("blog-exp", {"allowPause":false})', 'resetBranch("blog-exp", {"allowPause":true})'])
})

test('hobby_expire sets a parsed duration or clears with null; hobby_diff passes project and against', async () => {
  const { api, calls } = fakeApi({
    setExpiry: async () => ({ project: project('blog-exp') }),
    diffSchemas: async () => ({ old: { project: 'blog' }, new: { project: 'blog-exp' }, resources: [], woke: [], identical: true }),
  })
  await expireTool(api, { branch: 'blog-exp', expires: '36h' })
  await expireTool(api, { branch: 'blog-exp', expires: null })
  await diffTool(api, { project: 'blog-exp' })
  await diffTool(api, { project: 'b', against: 'a' })
  assert.deepEqual(calls, [
    'setExpiry("blog-exp", 129600)',
    'setExpiry("blog-exp", null)',
    'diffSchemas("blog-exp", )',
    'diffSchemas("b", "a")',
  ])
})
