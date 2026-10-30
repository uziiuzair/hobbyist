// Issue #122: what "Create a project" does, pinned against a fake API so
// the sequence is the one `hobby new` runs (packages/cli/src/cli/commands.ts,
// cmdNew): create the project, create a postgres named primary, and roll the
// project back if the postgres fails. `empty` is `hobby new --empty`.

import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Project, Resource } from '@hobby.sh/core'
import {
  createProjectWithDefaults,
  DEFAULT_POSTGRES_NAME,
  type ProjectCreator,
} from '../src/lib/createProject.js'

interface Recorded {
  op: 'createProject' | 'createResource' | 'deleteProject'
  args: unknown[]
}

function fakeApi(overrides: Partial<ProjectCreator> = {}): { api: ProjectCreator; calls: Recorded[] } {
  const calls: Recorded[] = []
  const api: ProjectCreator = {
    createProject: async (name) => {
      calls.push({ op: 'createProject', args: [name] })
      return { project: { id: 'p1', name } as Project }
    },
    createResource: async (projectName, name) => {
      calls.push({ op: 'createResource', args: [projectName, name] })
      return { resource: { id: 'r1', name } as Resource }
    },
    deleteProject: async (name, opts) => {
      calls.push({ op: 'deleteProject', args: [name, opts] })
      return { deleted: true }
    },
    ...overrides,
  }
  return { api, calls }
}

test('the default postgres is named the same as the CLI names it', () => {
  // packages/core/src/names.ts, DEFAULT_POSTGRES_NAME
  assert.equal(DEFAULT_POSTGRES_NAME, 'primary')
})

test('creates the project, then a postgres named primary in it', async () => {
  const { api, calls } = fakeApi()
  const result = await createProjectWithDefaults(api, 'blog')
  assert.deepEqual(
    calls.map((c) => [c.op, ...c.args]),
    [
      ['createProject', 'blog'],
      ['createResource', 'blog', 'primary'],
    ],
  )
  assert.equal(result.project.name, 'blog')
  assert.equal(result.resource?.name, 'primary')
})

test('empty creates the project and nothing else', async () => {
  const { api, calls } = fakeApi()
  const result = await createProjectWithDefaults(api, 'blog', { empty: true })
  assert.deepEqual(
    calls.map((c) => c.op),
    ['createProject'],
  )
  assert.equal(result.resource, null)
})

test('a failed postgres rolls the project back and rethrows the original error', async () => {
  const boom = new Error('image still pulling')
  const { api, calls } = fakeApi({
    createResource: async () => {
      throw boom
    },
  })
  await assert.rejects(() => createProjectWithDefaults(api, 'blog'), (err: unknown) => err === boom)
  assert.deepEqual(
    calls.filter((c) => c.op !== 'createResource').map((c) => [c.op, c.args[0]]),
    [
      ['createProject', 'blog'],
      ['deleteProject', 'blog'],
    ],
  )
})

test('a failed rollback is reported alongside the original failure, with the way out', async () => {
  const { api } = fakeApi({
    createResource: async () => {
      throw new Error('port in use')
    },
    deleteProject: async () => {
      throw new Error('store locked')
    },
  })
  await assert.rejects(
    () => createProjectWithDefaults(api, 'blog'),
    (err: unknown) =>
      err instanceof Error &&
      err.message.includes('port in use') &&
      err.message.includes('store locked') &&
      err.message.includes('hobby rm blog'),
  )
})

test('a failed createProject attempts nothing else', async () => {
  const { api, calls } = fakeApi()
  const base = api.createProject
  api.createProject = async (name) => {
    await base(name)
    throw new Error('name_taken')
  }
  await assert.rejects(() => createProjectWithDefaults(api, 'blog'), /name_taken/)
  assert.deepEqual(
    calls.map((c) => c.op),
    ['createProject'],
  )
})
