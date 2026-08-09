// Pure tests against a fake Api: no socket, no Docker, no network. Each
// test checks that a tool calls exactly the daemon route(s) documented in
// packages/cli/src/daemon/routes.ts, with the arguments the brief
// documents, and nothing else. The hobby_rm-without-confirm test is the one
// the task brief calls out by name: it must return an error and the fake
// Api must record zero calls.

import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Api, ConnectionResponse, DeletedResponse, LogsResponse, ProjectDetailResponse, ProjectsResponse, ResourceResponse, WireResource } from '@hobby.sh/cli'
import type { Project } from '@hobby.sh/core'
import { connectionStringTool, listTool, logsTool, newTool, rmTool, sleepTool, wakeTool, type ToolResult } from '../src/tools.js'

function project(name: string, id = `${name}-id`): Project {
  return { id, name, networkName: `hobby-${name}`, sleepAfterSeconds: 300, createdAt: new Date('2026-01-01'), releasedAt: null }
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
    listProjects: notWired('listProjects'),
    createProject: notWired('createProject'),
    getProject: notWired('getProject'),
    deleteProject: notWired('deleteProject'),
    createResource: notWired('createResource'),
    getResource: notWired('getResource'),
    deleteResource: notWired('deleteResource'),
    startResource: notWired('startResource'),
    stopResource: notWired('stopResource'),
    getConnection: notWired('getConnection'),
    getLogs: notWired('getLogs'),
    eject: notWired('eject'),
    adopt: notWired('adopt'),
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
