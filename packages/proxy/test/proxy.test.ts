// Written for Task 6's fix round 1. Unlike the original submission, these
// ARE executed: see task-6-report.md for the real `node --test` output.

import assert from 'node:assert/strict'
import net from 'node:net'
import { test } from 'node:test'
import {
  ActivityTracker,
  buildStartupPacket,
  CANCEL_REQUEST_CODE,
  GSS_ENC_REQUEST_CODE,
  SSL_REQUEST_CODE,
  startPgProxy,
  type ConnectionHandle,
  type ProxyDeps,
  type ProxyTarget,
} from '../src/index.js'

// Pulls the SQLSTATE ('C' field) out of a raw ErrorResponse buffer, without
// depending on any unexported parser: the wire format is simple enough to
// scan by hand, and doing so keeps this test honest about what a real
// client would actually see on the wire.
function extractSqlState(buf: Buffer): string | null {
  const cIndex = buf.indexOf(Buffer.from('C', 'ascii'))
  if (cIndex === -1) return null
  const end = buf.indexOf(0, cIndex + 1)
  if (end === -1) return null
  return buf.toString('ascii', cIndex + 1, end)
}

function readAll(socket: net.Socket): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    socket.on('data', (chunk: Buffer) => chunks.push(chunk))
    socket.on('end', () => resolve(Buffer.concat(chunks)))
    socket.on('close', () => resolve(Buffer.concat(chunks)))
    socket.on('error', reject)
  })
}

// Resolves with exactly the next 'data' chunk, for tests that need to
// inspect one write at a time (e.g. the single 'N' byte answering an
// SSLRequest) rather than waiting for the whole connection to end.
function readOneChunk(socket: net.Socket): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    socket.once('data', resolve)
    socket.once('error', reject)
  })
}

function sslRequestBytes(): Buffer {
  const buf = Buffer.alloc(8)
  buf.writeInt32BE(8, 0)
  buf.writeInt32BE(SSL_REQUEST_CODE, 4)
  return buf
}

function gssEncRequestBytes(): Buffer {
  const buf = Buffer.alloc(8)
  buf.writeInt32BE(8, 0)
  buf.writeInt32BE(GSS_ENC_REQUEST_CODE, 4)
  return buf
}

function cancelRequestBytes(processId: number, secretKey: number): Buffer {
  const buf = Buffer.alloc(16)
  buf.writeInt32BE(16, 0)
  buf.writeInt32BE(CANCEL_REQUEST_CODE, 4)
  buf.writeInt32BE(processId, 8)
  buf.writeInt32BE(secretKey, 12)
  return buf
}

// A fake upstream Postgres: accepts connections and records the raw bytes
// each one sends first, which is what the proxy's rebuilt startup packet
// arrives as (every parameter and its order preserved, only `database`
// possibly substituted; see ProxyTarget.database and Important 1 of the
// fix-round report). Never actually speaks Postgres; the proxy is not
// expected to notice, since it never parses anything upstream of the
// splice.
function startFakeUpstream(): Promise<{
  port: number
  receivedFirstBytes: () => Promise<Buffer>
  close: () => Promise<void>
}> {
  return new Promise((resolve, reject) => {
    let firstBytesResolve: ((buf: Buffer) => void) | null = null
    const firstBytes = new Promise<Buffer>((res) => {
      firstBytesResolve = res
    })

    const server = net.createServer((socket) => {
      socket.once('data', (chunk: Buffer) => {
        firstBytesResolve?.(chunk)
      })
    })
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address !== null ? address.port : 0
      resolve({
        port,
        receivedFirstBytes: () => firstBytes,
        close: () => new Promise((res, rej) => server.close((err) => (err ? rej(err) : res()))),
      })
    })
  })
}

function connectClient(port: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: '127.0.0.1', port })
    socket.once('connect', () => resolve(socket))
    socket.once('error', reject)
  })
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

test('an unknown database yields an ErrorResponse with 3D000', async () => {
  const deps: ProxyDeps = {
    resolve: async () => null,
    wake: async () => {
      throw new Error('wake must not be called for an unknown database')
    },
    activity: new ActivityTracker(),
  }

  const proxy = await startPgProxy({ port: 0, deps, wakeTimeoutMs: 1000 })
  try {
    const client = await connectClient(proxy.port)
    client.write(buildStartupPacket({ user: 'bob', database: 'nope' }))

    const response = await readAll(client)
    assert.equal(response[0], 0x45) // 'E'
    assert.equal(extractSqlState(response), '3D000')
  } finally {
    await proxy.close()
  }
})

test('a sleeping target calls wake exactly once, re-resolves after waking, and dials the post-wake address', async () => {
  const upstream = await startFakeUpstream()

  let wakeCalls = 0
  let resolveCalls = 0
  const deps: ProxyDeps = {
    resolve: async (): Promise<ProxyTarget> => {
      resolveCalls += 1
      // The pre-wake resolve deliberately points at a port nothing is
      // listening on: if the proxy dialed this address instead of
      // re-resolving after the wake, the connection would fail outright.
      // Only the post-wake (second) resolve points at the real fake
      // upstream. This is what actually exercises requirement #4, unlike
      // the original test, which returned the same host/port both times
      // and would have passed even with no re-resolve at all.
      if (resolveCalls === 1) {
        return { resourceId: 'resource-1', host: '127.0.0.1', port: 1, state: 'sleeping', database: 'proj1' }
      }
      return { resourceId: 'resource-1', host: '127.0.0.1', port: upstream.port, state: 'running', database: 'proj1' }
    },
    wake: async () => {
      wakeCalls += 1
    },
    activity: new ActivityTracker(),
  }

  const proxy = await startPgProxy({ port: 0, deps, wakeTimeoutMs: 1000 })
  try {
    const client = await connectClient(proxy.port)
    const packet = buildStartupPacket({ user: 'bob', database: 'proj1' })
    client.write(packet)

    const receivedByUpstream = await upstream.receivedFirstBytes()
    assert.deepEqual(receivedByUpstream, packet)
    assert.equal(wakeCalls, 1)
    assert.equal(resolveCalls, 2)

    client.destroy()
  } finally {
    await proxy.close()
    await upstream.close()
  }
})

test('a dotted routing key substitutes the sub-database, preserving every other parameter and its order', async () => {
  const upstream = await startFakeUpstream()

  const deps: ProxyDeps = {
    resolve: async (): Promise<ProxyTarget> => ({
      resourceId: 'resource-1',
      host: '127.0.0.1',
      port: upstream.port,
      state: 'running',
      database: 'blog', // the project's own default database; not used here since the client asked for a sub-database explicitly
    }),
    wake: async () => {
      throw new Error('wake must not be called for a running target')
    },
    activity: new ActivityTracker(),
  }

  const proxy = await startPgProxy({ port: 0, deps, wakeTimeoutMs: 1000 })
  try {
    const client = await connectClient(proxy.port)
    // application_name placed before AND after `database` on purpose, to
    // prove the substitution does not just move `database` to the end.
    client.write(
      buildStartupPacket({
        user: 'bob',
        database: 'blog.analytics',
        application_name: 'psql',
      })
    )

    const receivedByUpstream = await upstream.receivedFirstBytes()
    const expected = buildStartupPacket({
      user: 'bob',
      database: 'analytics', // substituted: the routing key's sub-database, not the project name
      application_name: 'psql',
    })
    assert.deepEqual(receivedByUpstream, expected)

    client.destroy()
  } finally {
    await proxy.close()
    await upstream.close()
  }
})

test('activity.close fires exactly once when the client closes before the upstream', async () => {
  const upstream = await startFakeUpstream()

  class CountingActivityTracker extends ActivityTracker {
    closeCalls = 0
    close(handle: ConnectionHandle): void {
      this.closeCalls += 1
      super.close(handle)
    }
  }
  const activity = new CountingActivityTracker()

  const deps: ProxyDeps = {
    resolve: async (): Promise<ProxyTarget> => ({
      resourceId: 'resource-1',
      host: '127.0.0.1',
      port: upstream.port,
      state: 'running',
      database: 'proj1',
    }),
    wake: async () => {
      throw new Error('wake must not be called for a running target')
    },
    activity,
  }

  const proxy = await startPgProxy({ port: 0, deps, wakeTimeoutMs: 1000 })
  try {
    const client = await connectClient(proxy.port)
    client.write(buildStartupPacket({ user: 'bob', database: 'proj1' }))
    await upstream.receivedFirstBytes()

    assert.equal(activity.count('resource-1'), 1)

    // Client closes first.
    client.destroy()
    // Give the proxy's 'close'/'error' handlers a turn before asserting.
    await sleep(10)

    assert.equal(activity.closeCalls, 1)
    assert.equal(activity.count('resource-1'), 0)
  } finally {
    await proxy.close()
    await upstream.close()
  }
})

test('activity.close fires exactly once when the upstream closes before the client', async () => {
  let upstreamSocket: net.Socket | null = null

  class CountingActivityTracker extends ActivityTracker {
    closeCalls = 0
    close(handle: ConnectionHandle): void {
      this.closeCalls += 1
      super.close(handle)
    }
  }
  const activity = new CountingActivityTracker()

  // A second fake upstream server that hands back the raw socket so the
  // test can sever it from this side, simulating Postgres closing the
  // connection (e.g. the container was stopped).
  const server = net.createServer((socket) => {
    upstreamSocket = socket
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0

  const deps: ProxyDeps = {
    resolve: async (): Promise<ProxyTarget> => ({
      resourceId: 'resource-1',
      host: '127.0.0.1',
      port,
      state: 'running',
      database: 'proj1',
    }),
    wake: async () => {
      throw new Error('wake must not be called for a running target')
    },
    activity,
  }

  const proxy = await startPgProxy({ port: 0, deps, wakeTimeoutMs: 1000 })
  try {
    const client = await connectClient(proxy.port)
    client.write(buildStartupPacket({ user: 'bob', database: 'proj1' }))

    // Wait until the proxy has actually dialed upstream.
    await sleep(20)
    assert.ok(upstreamSocket !== null)
    // TypeScript cannot see past the net.createServer callback that
    // assigns upstreamSocket, so the assert.ok above narrows the read type
    // to `never` rather than `net.Socket`. A cast is the standard escape
    // for a `let` captured and reassigned inside a closure.
    const upstream = upstreamSocket as net.Socket

    // Upstream closes first.
    upstream.destroy()
    await sleep(10)

    assert.equal(activity.closeCalls, 1)
    assert.equal(activity.count('resource-1'), 0)

    client.destroy()
  } finally {
    await proxy.close()
    await new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve(undefined))))
  }
})

test('SSLRequest is answered with a single N, then a real startup packet on the same socket is routed normally', async () => {
  const upstream = await startFakeUpstream()

  const deps: ProxyDeps = {
    resolve: async (): Promise<ProxyTarget> => ({
      resourceId: 'resource-1',
      host: '127.0.0.1',
      port: upstream.port,
      state: 'running',
      database: 'proj1',
    }),
    wake: async () => {
      throw new Error('wake must not be called for a running target')
    },
    activity: new ActivityTracker(),
  }

  const proxy = await startPgProxy({ port: 0, deps, wakeTimeoutMs: 1000 })
  try {
    const client = await connectClient(proxy.port)
    client.write(sslRequestBytes())

    const sslResponse = await readOneChunk(client)
    assert.deepEqual(sslResponse, Buffer.from('N', 'ascii'))

    const packet = buildStartupPacket({ user: 'bob', database: 'proj1' })
    client.write(packet)

    const receivedByUpstream = await upstream.receivedFirstBytes()
    assert.deepEqual(receivedByUpstream, packet)

    client.destroy()
  } finally {
    await proxy.close()
    await upstream.close()
  }
})

test('GSSENCRequest then SSLRequest, libpq real default order, both answered with N before the startup packet lands', async () => {
  const upstream = await startFakeUpstream()

  const deps: ProxyDeps = {
    resolve: async (): Promise<ProxyTarget> => ({
      resourceId: 'resource-1',
      host: '127.0.0.1',
      port: upstream.port,
      state: 'running',
      database: 'proj1',
    }),
    wake: async () => {
      throw new Error('wake must not be called for a running target')
    },
    activity: new ActivityTracker(),
  }

  const proxy = await startPgProxy({ port: 0, deps, wakeTimeoutMs: 1000 })
  try {
    const client = await connectClient(proxy.port)

    client.write(gssEncRequestBytes())
    const gssResponse = await readOneChunk(client)
    assert.deepEqual(gssResponse, Buffer.from('N', 'ascii'))

    client.write(sslRequestBytes())
    const sslResponse = await readOneChunk(client)
    assert.deepEqual(sslResponse, Buffer.from('N', 'ascii'))

    const packet = buildStartupPacket({ user: 'bob', database: 'proj1' })
    client.write(packet)

    const receivedByUpstream = await upstream.receivedFirstBytes()
    assert.deepEqual(receivedByUpstream, packet)

    client.destroy()
  } finally {
    await proxy.close()
    await upstream.close()
  }
})

test('a startup packet split across two writes is reassembled before routing', async () => {
  const upstream = await startFakeUpstream()

  const deps: ProxyDeps = {
    resolve: async (): Promise<ProxyTarget> => ({
      resourceId: 'resource-1',
      host: '127.0.0.1',
      port: upstream.port,
      state: 'running',
      database: 'proj1',
    }),
    wake: async () => {
      throw new Error('wake must not be called for a running target')
    },
    activity: new ActivityTracker(),
  }

  const proxy = await startPgProxy({ port: 0, deps, wakeTimeoutMs: 1000 })
  try {
    const client = await connectClient(proxy.port)
    const packet = buildStartupPacket({ user: 'bob', database: 'proj1', application_name: 'split-write-test' })
    const midpoint = Math.floor(packet.length / 2)

    client.write(packet.subarray(0, midpoint))
    await sleep(10) // force two distinct TCP segments / 'data' events, not one
    client.write(packet.subarray(midpoint))

    const receivedByUpstream = await upstream.receivedFirstBytes()
    assert.deepEqual(receivedByUpstream, packet)

    client.destroy()
  } finally {
    await proxy.close()
    await upstream.close()
  }
})

test('a CancelRequest is never treated as a wake and simply closes the connection', async () => {
  let resolveCalls = 0
  let wakeCalls = 0
  const deps: ProxyDeps = {
    resolve: async (): Promise<ProxyTarget> => {
      resolveCalls += 1
      return { resourceId: 'resource-1', host: '127.0.0.1', port: 1, state: 'sleeping', database: 'proj1' }
    },
    wake: async () => {
      wakeCalls += 1
    },
    activity: new ActivityTracker(),
  }

  const proxy = await startPgProxy({ port: 0, deps, wakeTimeoutMs: 1000 })
  try {
    const client = await connectClient(proxy.port)
    client.write(cancelRequestBytes(4242, 24242))

    const response = await readAll(client)
    assert.equal(response.length, 0) // closed with no ErrorResponse and no other payload
    assert.equal(resolveCalls, 0)
    assert.equal(wakeCalls, 0)
  } finally {
    await proxy.close()
  }
})

test('a wake that never resolves produces a 57P03 ErrorResponse once wakeTimeoutMs elapses', async () => {
  const deps: ProxyDeps = {
    resolve: async (): Promise<ProxyTarget> => ({
      resourceId: 'resource-1',
      host: '127.0.0.1',
      port: 1,
      state: 'sleeping',
      database: 'proj1',
    }),
    wake: () => new Promise<void>(() => {}), // never resolves, never rejects
    activity: new ActivityTracker(),
  }

  const proxy = await startPgProxy({ port: 0, deps, wakeTimeoutMs: 100 })
  try {
    const client = await connectClient(proxy.port)
    client.write(buildStartupPacket({ user: 'bob', database: 'proj1' }))

    const response = await readAll(client)
    assert.equal(response[0], 0x45) // 'E'
    assert.equal(extractSqlState(response), '57P03')
  } finally {
    await proxy.close()
  }
})

test('ActivityTracker counts opens and closes and reports idle seconds only when the count is zero', () => {
  let now = 1_000_000
  const tracker = new ActivityTracker(() => now)

  assert.equal(tracker.count('r1'), 0)
  assert.equal(tracker.idleSeconds('r1'), null)

  const first = tracker.open('r1')
  assert.equal(tracker.count('r1'), 1)
  assert.equal(tracker.idleSeconds('r1'), null) // still active, not idle

  const second = tracker.open('r1')
  assert.equal(tracker.count('r1'), 2)

  tracker.close(first)
  assert.equal(tracker.count('r1'), 1)
  assert.equal(tracker.idleSeconds('r1'), null) // one connection still open

  now += 5_000 // 5 real seconds later, but still not idle
  tracker.close(second)
  assert.equal(tracker.count('r1'), 0)
  assert.equal(tracker.idleSeconds('r1'), 0) // just closed, at the moment it closed

  now += 30_000
  assert.equal(tracker.idleSeconds('r1'), 30)

  assert.deepEqual(tracker.resources(), ['r1'])
})

test('ActivityTracker.close is idempotent: closing the same connection twice changes nothing', () => {
  let now = 0
  const tracker = new ActivityTracker(() => now)

  const handle = tracker.open('r1')
  tracker.close(handle)
  assert.equal(tracker.count('r1'), 0)

  // Extra closes of a connection already accounted for must not move the idle
  // clock forward on their own. idleSeconds reports seconds, not
  // milliseconds, hence 100_000ms here to assert a clean 100.
  now += 100_000
  tracker.close(handle)
  tracker.close(handle)
  assert.equal(tracker.count('r1'), 0)
  assert.equal(tracker.idleSeconds('r1'), 100)
})

// The race the handle exists for. A bare count could not tell A's close from
// B's, so a reset landing between them left the tracker reporting zero with a
// live client attached, and hibernation slept a connected database.
test('ActivityTracker: a connection that outlives a reset cannot zero the count of one that follows it', () => {
  let now = 0
  const tracker = new ActivityTracker(() => now)

  const stale = tracker.open('r1')
  assert.equal(tracker.count('r1'), 1)

  // stopPostgres or destroyPostgres reports the resource gone while the old
  // connection is still attached.
  tracker.reset('r1')
  assert.equal(tracker.count('r1'), 0)

  const live = tracker.open('r1')
  assert.equal(tracker.count('r1'), 1)

  now += 10_000
  tracker.close(stale)

  assert.equal(tracker.count('r1'), 1, 'the live connection is still attached')
  assert.equal(tracker.idleSeconds('r1'), null, 'a connected resource is never idle')

  tracker.close(live)
  assert.equal(tracker.count('r1'), 0)
  assert.equal(tracker.idleSeconds('r1'), 0)
})
