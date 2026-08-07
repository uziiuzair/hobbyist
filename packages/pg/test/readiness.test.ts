// pgProbe's own contract, the same shape getDatabaseSize guarantees in
// size.test.ts: it answers a boolean, it never throws, and it never hangs.
// waitReady's poll loop is tested separately in postgres.test.ts with an
// injected probe and a fake clock; these two cover the real probe against a
// socket, which is the part no fake reaches.
//
// What these deliberately do not cover: the deadline on client.end(). Hitting
// that needs a connection that completes a Postgres handshake and then stops
// responding, which means a real server. The bound is there because the
// sibling path in activity-guard.ts carries it, not because a test drove it
// out, and this comment is the honest record of that.

import assert from 'node:assert/strict'
import { createServer, type Server, type Socket } from 'node:net'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import type { PostgresConfig } from '@hobby.sh/core'
import { pgProbe } from '../src/readiness.js'

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

test('pgProbe: a refused connection answers false rather than throwing', async () => {
  // Nothing is listening on port 1: the OS refuses the connection outright.
  const probe = pgProbe(sampleConfig({ hostPort: 1 }))
  assert.equal(await probe(), false)
})

// The failure mode that matters during a wake: the port is open (Docker has
// published it, or the postmaster is mid-initdb) but nothing completes a
// handshake. A probe that waits forever here is a wake with no ceiling.
test('pgProbe: a port that accepts and then says nothing answers false, bounded', async () => {
  // Every accepted socket is kept so teardown can destroy it. net.Server has
  // no closeAllConnections (that is http.Server), and server.close() waits on
  // every socket it has accepted: the probe destroying its own end is not
  // enough to release this one, and without this the test hangs on cleanup
  // while the code under test has already returned correctly.
  const accepted: Socket[] = []
  const server: Server = createServer((socket) => {
    // Accept and never write a byte.
    accepted.push(socket)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address !== null && typeof address === 'object')

  try {
    const probe = pgProbe(sampleConfig({ hostPort: address.port }))
    const started = Date.now()
    assert.equal(await probe(), false)
    // The connection timeout is 1000ms and the end deadline another 1000ms.
    // Anything near or above their sum means one of the two is not bounding.
    assert.ok(Date.now() - started < 2500, 'pgProbe did not return within its own deadlines')
  } finally {
    for (const socket of accepted) socket.destroy()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})
