// getDatabaseSize's own contract: any failure to connect resolves null,
// never throws and never hangs. This is deliberately the only shape this
// file needs to guarantee: the caching and "never wake to check" policy on
// top of it live in packages/cli/src/daemon/size.ts and are tested there.

import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import type { PostgresConfig } from '@hobby.sh/core'
import { getDatabaseSize } from '../src/size.js'

function sampleConfig(overrides: Partial<PostgresConfig> = {}): PostgresConfig {
  return {
    image: 'postgres:18-alpine',
    containerName: `hobby-blog-primary-${randomUUID()}`,
    dataDir: '/home/user/.hobby/projects/blog/primary/pgdata',
    hostPort: 25598,
    superuser: 'postgres',
    password: 'secret',
    database: 'blog',
    ...overrides,
  }
}

test('getDatabaseSize: a refused connection resolves null rather than throwing', async () => {
  // Nothing is listening on port 1: the OS refuses the connection outright.
  const size = await getDatabaseSize(sampleConfig({ hostPort: 1 }), 500)
  assert.equal(size, null)
})
