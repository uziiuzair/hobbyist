// pgProbe's own contract, the same shape getDatabaseSize guarantees in
// size.test.ts: it answers a ProbeOutcome, it never throws, and it never
// hangs.
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
import { classifyProbeError, pgProbe } from '../src/readiness.js'

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

// A server that reads the startup packet and answers it with one
// ErrorResponse, then closes: the shape of a real Postgres refusing a
// session before authentication. Built by hand so the test does not lean on
// any encoder in the code under test.
async function withRefusingServer(
  sqlstate: string,
  message: string,
  fn: (port: number) => Promise<void>
): Promise<void> {
  const body = Buffer.concat([Buffer.from(`SFATAL\0VFATAL\0C${sqlstate}\0M${message}\0`, 'utf8'), Buffer.from([0])])
  const header = Buffer.alloc(5)
  header.write('E', 0, 'ascii')
  header.writeInt32BE(4 + body.length, 1)
  const refusal = Buffer.concat([header, body])

  const accepted: Socket[] = []
  const server: Server = createServer((socket) => {
    accepted.push(socket)
    socket.on('error', () => {})
    socket.once('data', () => socket.end(refusal))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address !== null && typeof address === 'object')
  try {
    await fn(address.port)
  } finally {
    for (const socket of accepted) socket.destroy()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

// Issue #10: "a server answered with an error" is not "nothing answered".
test('pgProbe: a server that refuses with an authentication error answers broken, naming it', async () => {
  await withRefusingServer('28P01', 'password authentication failed for user "postgres"', async (port) => {
    const probe = pgProbe(sampleConfig({ hostPort: port }))
    const outcome = await probe()
    assert.deepEqual(outcome, {
      broken: 'password authentication failed for user "postgres" (SQLSTATE 28P01)',
    })
  })
})

// The case that must not be misread: a Postgres still booting answers with
// an ErrorResponse too, and concluding "broken" on it would fail a wake
// that was about to succeed and leave the resource refused until someone
// ran `hobby wake`.
test('pgProbe: a server answering 57P03, the database system is starting up, is still cold, not broken', async () => {
  await withRefusingServer('57P03', 'the database system is starting up', async (port) => {
    const probe = pgProbe(sampleConfig({ hostPort: port }))
    assert.equal(await probe(), false)
  })
})

test('classifyProbeError: only a server ErrorResponse outside the transient classes is broken', () => {
  assert.equal(classifyProbeError(new Error('connect ECONNREFUSED 127.0.0.1:1')), false)
  assert.equal(classifyProbeError(new Error('Connection terminated due to connection timeout')), false)
  assert.equal(classifyProbeError('not even an error'), false)
})
