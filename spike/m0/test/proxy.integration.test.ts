import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from 'pg'
import { prepareFixture } from '../src/fixture.ts'
import { removeIfExists, stopClean, isRunning } from '../src/runtime.ts'
import { startProxy } from '../src/proxy.ts'
import type { Timeline } from '../src/timeline.ts'

const NAME = 'm0-proxy-test'
const DATA = mkdtempSync(join(tmpdir(), 'm0-proxy-'))

after(async () => {
  await removeIfExists(NAME)
})

test('a connection to a stopped instance wakes it and serves the query', { timeout: 180_000 }, async () => {
  const fixture = await prepareFixture({
    name: NAME,
    image: 'postgres:18-alpine',
    hostPort: 55598,
    dataDir: DATA,
  })
  assert.equal(await isRunning(NAME), false)

  const timelines: Timeline[] = []
  const proxy = await startProxy({
    listenPort: 55597,
    fixture,
    pollMs: 25,
    wakeTimeoutMs: 30_000,
    onTimeline: (t) => timelines.push(t),
  })

  const client = new Client({
    host: '127.0.0.1',
    port: 55597,
    user: fixture.user,
    password: fixture.password,
    database: fixture.database,
  })
  await client.connect()
  const res = await client.query('SELECT 1 AS one')
  assert.equal(res.rows[0].one, 1)
  await client.end()

  assert.equal(timelines.length, 1)
  const t = timelines[0]!
  assert.ok(t.segmentMs('accept', 'upstream_connected') > 0)
  assert.equal(t.has('container_up'), true)
  assert.equal(t.has('pg_ready'), true)

  await proxy.close()
  await stopClean(NAME)
})
