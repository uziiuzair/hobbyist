// runQuery's own contract, exercised against real failure paths that need
// no Docker and no real Postgres: a closed local port refuses the
// connection immediately, which is enough to pin down the one thing this
// file guarantees regardless of what is actually listening, that a
// connection failure surfaces as a structured HobbyError('not_ready', ...)
// rather than a bare rejection or a hang. The parameterized-query and
// SQL-error-shape paths need a real Postgres and are not exercised here;
// see the task report.

import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:net'
import { test } from 'node:test'
import { HobbyError, type PostgresConfig } from '@hobby.sh/core'
import { runQuery } from '../src/query.js'

function sampleConfig(overrides: Partial<PostgresConfig> = {}): PostgresConfig {
  return {
    image: 'postgres:18-alpine',
    containerName: `hobby-blog-primary-${randomUUID()}`,
    dataDir: '/home/user/.hobby/projects/blog/primary/pgdata',
    hostPort: 25599,
    superuser: 'postgres',
    password: 'secret',
    database: 'blog',
    ...overrides,
  }
}

// A real TCP server that never speaks the Postgres wire protocol: the
// client's own startup handshake will simply never complete. Used to force
// a definite connection failure quickly (via a short connectionTimeoutMs),
// without depending on any port on this machine being genuinely closed.
function unresponsiveServer(): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = createServer((socket) => {
      // Accept and say nothing back, ever, but still drain (and discard)
      // whatever the client sends (pg's own startup packet): a socket with
      // no 'data' listener stays paused, its incoming bytes never
      // consumed, so Node never emits 'end' for it even after the client
      // tears its own side down. Without resume() here, server.close()
      // below would wait forever for a connection that is already dead at
      // the TCP level but still open from Node's point of view.
      socket.resume()
    })
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address !== null ? address.port : 0
      resolve({
        port,
        close: () => new Promise((res) => server.close(() => res())),
      })
    })
  })
}

test('runQuery: a connection that cannot be established throws HobbyError(not_ready), never hangs', async () => {
  const { port, close } = await unresponsiveServer()
  try {
    await assert.rejects(
      runQuery(sampleConfig({ hostPort: port }), 'select 1', [], 200),
      (err: unknown) => {
        assert.ok(err instanceof HobbyError)
        assert.equal(err.code, 'not_ready')
        assert.match(err.message, /could not connect to run the query/)
        return true
      }
    )
  } finally {
    await close()
  }
})

test('runQuery: a closed port refuses the connection immediately and still throws HobbyError(not_ready)', async () => {
  // Nothing is listening on this port at all (no server ever started on
  // it): the OS refuses the connection outright rather than timing out,
  // exercising the ECONNREFUSED path distinctly from the timeout path above.
  await assert.rejects(
    runQuery(sampleConfig({ hostPort: 1 }), 'select 1', [], 500),
    (err: unknown) => {
      assert.ok(err instanceof HobbyError)
      assert.equal(err.code, 'not_ready')
      return true
    }
  )
})
