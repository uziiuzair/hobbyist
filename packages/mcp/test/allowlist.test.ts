// The allowlist tools are thin wrappers over the same Api methods `hobby
// allow` calls, so CLI and MCP send identical requests.

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { HobbyError } from '@hobby.sh/core'
import type { Api } from '@hobby.sh/cli'
import { allowAddTool, allowListTool, allowOffTool, allowRmTool } from '../src/tools.js'

test('hobby_allow_ls/add/rm/off call the allowlist Api and surface daemon errors', async () => {
  const calls: unknown[] = []
  const project = (allowlist: string[] | null) => ({ project: { name: 'blog', allowlist } })
  const api = {
    getAllowlist: async (p: string) => (calls.push(['get', p]), project(null)),
    setAllowlist: async (p: string, change: { add?: string[]; remove?: string[] }) => {
      calls.push(['set', p, change])
      if (change.add?.includes('nope')) throw new HobbyError('usage', '"nope" is not an IP address or CIDR range')
      return project(change.add ?? [])
    },
    clearAllowlist: async (p: string) => (calls.push(['clear', p]), project(null)),
  } as unknown as Api

  assert.equal(JSON.parse((await allowListTool(api, { project: 'blog' })).content[0]!.text).project.allowlist, null)
  const added = await allowAddTool(api, { project: 'blog', entries: ['10.0.0.0/8'] })
  assert.deepEqual(JSON.parse(added.content[0]!.text).project.allowlist, ['10.0.0.0/8'])
  await allowRmTool(api, { project: 'blog', entries: ['10.0.0.0/8'] })
  await allowOffTool(api, { project: 'blog' })
  const bad = await allowAddTool(api, { project: 'blog', entries: ['nope'] })
  assert.equal(bad.isError, true)
  assert.match(bad.content[0]!.text, /^usage: "nope" is not an IP address/)
  assert.deepEqual(calls, [
    ['get', 'blog'],
    ['set', 'blog', { add: ['10.0.0.0/8'] }],
    ['set', 'blog', { remove: ['10.0.0.0/8'] }],
    ['clear', 'blog'],
    ['set', 'blog', { add: ['nope'] }],
  ])
})
