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
  // Answers the startup packet with AuthenticationOk first, so the close
  // below lands on a spliced session. A close before any backend message is
  // a different case now: the proxy holds the client and redials (issue #9,
  // see holdUntilServing), which the tests further down cover.
  const server = net.createServer((socket) => {
    upstreamSocket = socket
    socket.on('error', () => {})
    socket.once('data', () => socket.write(Buffer.from([0x52, 0, 0, 0, 8, 0, 0, 0, 0])))
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

// A cancel carries no database name, so there is nothing to resolve and
// nothing that could be woken by one. A key the proxy never issued (or one
// whose connection has since closed) has nothing to route to, and closing
// silently is what a real Postgres does with a key it does not recognise.
test('a CancelRequest for a key this proxy never issued closes without resolving or waking', async () => {
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

// Reads exactly `count` bytes, across as many 'data' events as it takes.
// The proxy may forward BackendKeyData and ReadyForQuery in one write or
// two, and a test that assumed one would be asserting the scheduler.
function readBytes(socket: net.Socket, count: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0)
    const onData = (chunk: Buffer): void => {
      buffer = Buffer.concat([buffer, chunk])
      if (buffer.length < count) return
      socket.off('data', onData)
      socket.off('error', onError)
      resolve(buffer.subarray(0, count))
    }
    const onError = (err: Error): void => {
      socket.off('data', onData)
      reject(err)
    }
    socket.on('data', onData)
    socket.once('error', onError)
  })
}

function backendKeyDataBytes(processId: number, secretKey: number): Buffer {
  const buf = Buffer.alloc(13)
  buf.write('K', 0, 'ascii')
  buf.writeInt32BE(12, 1)
  buf.writeInt32BE(processId, 5)
  buf.writeInt32BE(secretKey, 9)
  return buf
}

function readyForQueryBytes(): Buffer {
  const buf = Buffer.alloc(6)
  buf.write('Z', 0, 'ascii')
  buf.writeInt32BE(5, 1)
  buf.write('I', 5, 'ascii')
  return buf
}

// A fake upstream that says just enough to be cancellable: it answers the
// first connection's startup packet with BackendKeyData and ReadyForQuery,
// the way a real backend does once authentication succeeds, and records
// what any later connection sends, which is where a routed CancelRequest
// arrives.
function startCancellableUpstream(backendKey: { processId: number; secretKey: number }): Promise<{
  port: number
  cancelBytes: () => Promise<Buffer>
  connectionCount: () => number
  // Writes on the first accepted socket, so a test can send bytes after the
  // startup phase has ended and assert on what reaches the client.
  sendOnFirst: (buf: Buffer) => void
  close: () => Promise<void>
}> {
  return new Promise((resolve, reject) => {
    let cancelResolve: ((buf: Buffer) => void) | null = null
    const cancel = new Promise<Buffer>((res) => {
      cancelResolve = res
    })
    let connections = 0
    let first: net.Socket | null = null

    const server = net.createServer((socket) => {
      connections += 1
      const isFirst = connections === 1
      if (isFirst) {
        first = socket
      }
      socket.on('error', () => {})
      socket.once('data', (chunk: Buffer) => {
        if (isFirst) {
          socket.write(backendKeyDataBytes(backendKey.processId, backendKey.secretKey))
          socket.write(readyForQueryBytes())
          return
        }
        cancelResolve?.(chunk)
        socket.end()
      })
    })
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address !== null ? address.port : 0
      resolve({
        port,
        cancelBytes: () => cancel,
        connectionCount: () => connections,
        sendOnFirst: (buf: Buffer) => first?.write(buf),
        close: () => new Promise((res, rej) => server.close((err) => (err ? rej(err) : res()))),
      })
    })
  })
}

function runningDeps(port: number): ProxyDeps {
  return {
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
    activity: new ActivityTracker(),
  }
}

// The whole point of the feature, end to end. The client is handed a key
// the proxy minted, presents it on a second connection, and the backend
// receives a cancel carrying its own key instead.
test('a CancelRequest is routed to the connection it belongs to, carrying the backend own key', async () => {
  const backendKey = { processId: 4242, secretKey: 24242 }
  const upstream = await startCancellableUpstream(backendKey)
  const proxy = await startPgProxy({ port: 0, deps: runningDeps(upstream.port), wakeTimeoutMs: 1000 })

  try {
    const client = await connectClient(proxy.port)
    client.write(buildStartupPacket({ user: 'bob', database: 'proj1' }))

    const handed = await readBytes(client, 13 + 6)
    assert.equal(handed[0], 0x4b, 'BackendKeyData reached the client')
    const issued = { processId: handed.readInt32BE(5), secretKey: handed.readInt32BE(9) }
    assert.notDeepEqual(issued, backendKey, 'the key the client holds is minted, not the backend own')
    assert.deepEqual(
      handed.subarray(13),
      readyForQueryBytes(),
      'everything either side of BackendKeyData passes through untouched'
    )

    // The cancel arrives the way psql sends one: a second connection that
    // carries nothing but the pair.
    const canceller = await connectClient(proxy.port)
    canceller.write(cancelRequestBytes(issued.processId, issued.secretKey))

    const received = await upstream.cancelBytes()
    assert.equal(received.length, 16)
    assert.equal(received.readInt32BE(0), 16)
    assert.equal(received.readInt32BE(4), CANCEL_REQUEST_CODE)
    assert.equal(received.readInt32BE(8), backendKey.processId)
    assert.equal(received.readInt32BE(12), backendKey.secretKey)

    client.destroy()
    canceller.destroy()
  } finally {
    await proxy.close()
    await upstream.close()
  }
})

// The registry is bounded by live connections, and this is the visible
// consequence: once the connection is gone, its key is a key the proxy
// never issued, and nothing is dialed.
test('a CancelRequest for a connection that has already closed dials nothing', async () => {
  const backendKey = { processId: 4242, secretKey: 24242 }
  const upstream = await startCancellableUpstream(backendKey)
  const proxy = await startPgProxy({ port: 0, deps: runningDeps(upstream.port), wakeTimeoutMs: 1000 })

  try {
    const client = await connectClient(proxy.port)
    client.write(buildStartupPacket({ user: 'bob', database: 'proj1' }))

    const handed = await readBytes(client, 13 + 6)
    const issued = { processId: handed.readInt32BE(5), secretKey: handed.readInt32BE(9) }
    assert.equal(upstream.connectionCount(), 1)

    client.destroy()
    await sleep(20)

    const canceller = await connectClient(proxy.port)
    canceller.write(cancelRequestBytes(issued.processId, issued.secretKey))
    const response = await readAll(canceller)

    assert.equal(response.length, 0, 'closed with no payload, same as any unroutable cancel')
    assert.equal(upstream.connectionCount(), 1, 'no second connection was made to the backend')
  } finally {
    await proxy.close()
    await upstream.close()
  }
})

// Query traffic must not be parsed or rewritten. Once ReadyForQuery has
// gone past, the connection is a plain pipe again, and bytes that happen to
// be shaped exactly like BackendKeyData are just bytes: a rewrite here
// would corrupt a result set.
test('bytes after ReadyForQuery are spliced untouched, including ones shaped like BackendKeyData', async () => {
  const backendKey = { processId: 4242, secretKey: 24242 }
  const upstream = await startCancellableUpstream(backendKey)
  const proxy = await startPgProxy({ port: 0, deps: runningDeps(upstream.port), wakeTimeoutMs: 1000 })

  try {
    const client = await connectClient(proxy.port)
    client.write(buildStartupPacket({ user: 'bob', database: 'proj1' }))

    const handed = await readBytes(client, 13 + 6)
    const issued = { processId: handed.readInt32BE(5), secretKey: handed.readInt32BE(9) }

    // The same bytes the proxy rewrote a moment ago, sent again after the
    // startup phase has ended.
    const lookalike = backendKeyDataBytes(backendKey.processId, backendKey.secretKey)
    const arrived = readBytes(client, lookalike.length)
    upstream.sendOnFirst(lookalike)

    assert.deepEqual(await arrived, lookalike, 'forwarded verbatim, not rewritten a second time')
    assert.notEqual(
      (await arrived).readInt32BE(5),
      issued.processId,
      'the minted key was not substituted into post-startup traffic'
    )

    client.destroy()
  } finally {
    await proxy.close()
    await upstream.close()
  }
})

// ---------------------------------------------------------------------------
// Issue #9: a `running` target whose backend is still starting up.
// ---------------------------------------------------------------------------

function authenticationOkBytes(): Buffer {
  const buf = Buffer.alloc(9)
  buf.write('R', 0, 'ascii')
  buf.writeInt32BE(8, 1)
  buf.writeInt32BE(0, 5)
  return buf
}

// A hand-built FATAL 57P03 carrying Postgres's own wording, independent of
// the proxy's errorResponse builder so the test is not checking the proxy
// against itself.
function startingUpBytes(): Buffer {
  const body = Buffer.concat([
    Buffer.from('SFATAL\0VFATAL\0C57P03\0Mthe database system is starting up\0', 'utf8'),
    Buffer.from([0]),
  ])
  const header = Buffer.alloc(5)
  header.write('E', 0, 'ascii')
  header.writeInt32BE(4 + body.length, 1)
  return Buffer.concat([header, body])
}

// Pulls the 'M' field out of an ErrorResponse, same hand-scan as
// extractSqlState above.
function extractMessage(buf: Buffer): string | null {
  const mIndex = buf.indexOf(Buffer.from('\0M', 'ascii'))
  if (mIndex === -1) return null
  const end = buf.indexOf(0, mIndex + 2)
  if (end === -1) return null
  return buf.toString('utf8', mIndex + 2, end)
}

// The shape a Postgres in crash recovery has from the outside: it accepts
// every TCP connection, reads the startup packet, and answers the first
// `refusals` of them with FATAL 57P03 and a close, exactly as the postmaster
// does while it cannot take sessions. After that it serves a normal
// handshake: AuthenticationOk, BackendKeyData, ReadyForQuery. Every startup
// packet it receives is recorded, so a test can assert the proxy replayed
// the client's packet identically on each attempt. `refusals` of Infinity is
// a backend that never recovers.
//
// `refuseWith` picks how a refusal looks. 'starting_up' is the 57P03 above.
// 'close' and 'reset' are the shape Docker's published port has while
// nothing inside the container listens yet: the host side accepts the TCP
// connection, then ends it (FIN) or tears it down (RST) without a byte.
function startRecoveringUpstream(
  refusals: number,
  refuseWith: 'starting_up' | 'close' | 'reset' = 'starting_up'
): Promise<{
  port: number
  connectionCount: () => number
  packets: Buffer[]
  close: () => Promise<void>
}> {
  return new Promise((resolve, reject) => {
    let connections = 0
    const packets: Buffer[] = []
    const sockets: net.Socket[] = []
    const server = net.createServer((socket) => {
      connections += 1
      const refuse = connections <= refusals
      sockets.push(socket)
      socket.on('error', () => {})
      socket.once('data', (chunk: Buffer) => {
        packets.push(chunk)
        if (refuse) {
          if (refuseWith === 'close') {
            socket.end()
          } else if (refuseWith === 'reset') {
            socket.resetAndDestroy()
          } else {
            socket.end(startingUpBytes())
          }
          return
        }
        socket.write(Buffer.concat([authenticationOkBytes(), backendKeyDataBytes(4242, 24242), readyForQueryBytes()]))
      })
    })
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address !== null ? address.port : 0
      resolve({
        port,
        connectionCount: () => connections,
        packets,
        close: () => {
          for (const socket of sockets) socket.destroy()
          return new Promise((res, rej) => server.close((err) => (err ? rej(err) : res())))
        },
      })
    })
  })
}

test('issue #9: a running target answering 57P03 holds the client and completes the handshake once the backend recovers', async () => {
  const upstream = await startRecoveringUpstream(3)
  const activity = new ActivityTracker()
  const deps = { ...runningDeps(upstream.port), activity }
  // Destroyed in finally, so a failed assertion cannot leave a client
  // holding proxy.close() open and hang the rest of the file.
  const clients: net.Socket[] = []
  const proxy = await startPgProxy({ port: 0, deps, wakeTimeoutMs: 2000 })

  try {
    const client = await connectClient(proxy.port)
    clients.push(client)
    const received: Buffer[] = []
    client.on('data', (chunk: Buffer) => received.push(chunk))
    const started = Date.now()
    const packet = buildStartupPacket({ user: 'bob', database: 'proj1' })
    client.write(packet)

    // AuthenticationOk + BackendKeyData + ReadyForQuery, and not one byte of
    // the three refusals before them.
    const expectedLength = 9 + 13 + 6
    while (Buffer.concat(received).length < expectedLength) {
      await sleep(5)
      assert.ok(Date.now() - started < 3000, 'the handshake did not complete inside the 3 second ceiling')
    }
    const elapsed = Date.now() - started
    const handshake = Buffer.concat(received)

    assert.equal(handshake[0], 0x52, 'the first thing the client saw was AuthenticationOk, not the backend refusal')
    assert.equal(handshake.indexOf(Buffer.from('57P03', 'ascii')), -1, 'no 57P03 reached the client')
    assert.equal(handshake.length, expectedLength)
    assert.ok(elapsed < 3000, `took ${elapsed}ms, over the 3 second hard ceiling`)

    assert.equal(upstream.connectionCount(), 4, 'three refused attempts, then the one that was served')
    for (const replayed of upstream.packets) {
      assert.deepEqual(replayed, packet, 'every attempt replays the identical startup packet')
    }
    assert.equal(activity.count('resource-1'), 1, 'the held-then-spliced connection is counted exactly once')

    client.destroy()
    await sleep(20)
    assert.equal(activity.count('resource-1'), 0)
  } finally {
    for (const client of clients) client.destroy()
    await proxy.close()
    await upstream.close()
  }
})

test('issue #9: a backend that never stops answering 57P03 gets the client a clean ErrorResponse at the budget, not a dropped socket', async () => {
  const upstream = await startRecoveringUpstream(Infinity)
  const activity = new ActivityTracker()
  const deps = { ...runningDeps(upstream.port), activity }
  const clients: net.Socket[] = []
  const proxy = await startPgProxy({ port: 0, deps, wakeTimeoutMs: 500 })

  try {
    const client = await connectClient(proxy.port)
    clients.push(client)
    const started = Date.now()
    client.write(buildStartupPacket({ user: 'bob', database: 'proj1' }))

    const response = await readAll(client)
    const elapsed = Date.now() - started

    assert.equal(response[0], 0x45, 'an ErrorResponse, not an empty read')
    assert.equal(extractSqlState(response), '57P03')
    const message = extractMessage(response) ?? ''
    // The proxy's own error, sent once the budget ran out, naming what the
    // backend kept saying. Not the backend's refusal forwarded verbatim.
    assert.match(message, /still not accepting connections after 500ms/)
    assert.match(message, /the database system is starting up/)
    assert.ok(elapsed >= 400, `gave up after ${elapsed}ms, well before the 500ms budget`)
    assert.ok(elapsed < 3000, `took ${elapsed}ms, over the 3 second hard ceiling`)
    assert.ok(upstream.connectionCount() > 1, 'the refusal was retried, not accepted on the first answer')
    assert.equal(activity.count('resource-1'), 0, 'the activity handle held across retries was closed')
  } finally {
    for (const client of clients) client.destroy()
    await proxy.close()
    await upstream.close()
  }
})

test('issue #9 regression: a healthy running target is dialed once and spliced with no added latency', async () => {
  const upstream = await startRecoveringUpstream(0)
  const clients: net.Socket[] = []
  const proxy = await startPgProxy({ port: 0, deps: runningDeps(upstream.port), wakeTimeoutMs: 2000 })

  try {
    const client = await connectClient(proxy.port)
    clients.push(client)
    const started = Date.now()
    client.write(buildStartupPacket({ user: 'bob', database: 'proj1' }))

    const handshake = await readBytes(client, 9 + 13 + 6)
    const elapsed = Date.now() - started

    assert.equal(handshake[0], 0x52)
    assert.equal(upstream.connectionCount(), 1, 'dialed exactly once')
    // Under READY_RETRY_INTERVAL_MS (100ms): a loopback handshake takes a
    // few milliseconds, so anything near 100 means the happy path slept.
    assert.ok(elapsed < 100, `the happy path took ${elapsed}ms`)

    client.destroy()
  } finally {
    for (const client of clients) client.destroy()
    await proxy.close()
    await upstream.close()
  }
})

test('issue #9: a client that leaves while held stops the retries and releases its activity', async () => {
  const upstream = await startRecoveringUpstream(Infinity)
  const activity = new ActivityTracker()
  const deps = { ...runningDeps(upstream.port), activity }
  const clients: net.Socket[] = []
  const proxy = await startPgProxy({ port: 0, deps, wakeTimeoutMs: 5000 })

  try {
    const client = await connectClient(proxy.port)
    clients.push(client)
    client.write(buildStartupPacket({ user: 'bob', database: 'proj1' }))
    await sleep(250)
    assert.equal(activity.count('resource-1'), 1, 'a held client counts as activity')

    client.destroy()
    await sleep(150)
    const dialsAfterLeaving = upstream.connectionCount()
    await sleep(300)

    assert.equal(activity.count('resource-1'), 0)
    assert.equal(upstream.connectionCount(), dialsAfterLeaving, 'no more dials once the client is gone')
  } finally {
    for (const client of clients) client.destroy()
    await proxy.close()
    await upstream.close()
  }
})

// ---------------------------------------------------------------------------
// Issue #10: a resource whose wake already failed is answered, not woken.
// ---------------------------------------------------------------------------

test('issue #10: a refused target gets an immediate ErrorResponse naming the way out, with no wake and no dial', async () => {
  const upstream = await startRecoveringUpstream(0)
  let wakeCalls = 0
  const deps: ProxyDeps = {
    resolve: async (): Promise<ProxyTarget> => ({
      resourceId: 'resource-1',
      host: '127.0.0.1',
      port: upstream.port,
      state: 'failed',
      database: 'proj1',
    }),
    wake: async () => {
      wakeCalls += 1
    },
    isWakeRefused: (resourceId) => resourceId === 'resource-1',
    activity: new ActivityTracker(),
  }
  const clients: net.Socket[] = []
  const proxy = await startPgProxy({ port: 0, deps, wakeTimeoutMs: 30000 })

  try {
    const client = await connectClient(proxy.port)
    clients.push(client)
    const started = Date.now()
    client.write(buildStartupPacket({ user: 'bob', database: 'proj1' }))

    const response = await readAll(client)
    const elapsed = Date.now() - started

    assert.equal(response[0], 0x45)
    assert.equal(extractSqlState(response), '57P03')
    assert.match(extractMessage(response) ?? '', /hobby wake/)
    assert.equal(wakeCalls, 0, 'a refused resource is not woken')
    assert.equal(upstream.connectionCount(), 0, 'and not dialed')
    assert.ok(elapsed < 1000, `answered after ${elapsed}ms rather than immediately`)
  } finally {
    for (const client of clients) client.destroy()
    await proxy.close()
    await upstream.close()
  }
})

// The regression the refusal must not cause: `failed` on its own is what
// reconcile writes for a container that merely stopped (an unclean reboot),
// and such a target wakes exactly as it always did.
test('issue #10: a failed target that is not refused is woken and served as before', async () => {
  const upstream = await startRecoveringUpstream(0)
  let wakeCalls = 0
  let state = 'failed'
  const deps: ProxyDeps = {
    resolve: async (): Promise<ProxyTarget> => ({
      resourceId: 'resource-1',
      host: '127.0.0.1',
      port: upstream.port,
      state,
      database: 'proj1',
    }),
    wake: async () => {
      wakeCalls += 1
      state = 'running'
    },
    isWakeRefused: () => false,
    activity: new ActivityTracker(),
  }
  const clients: net.Socket[] = []
  const proxy = await startPgProxy({ port: 0, deps, wakeTimeoutMs: 2000 })

  try {
    const client = await connectClient(proxy.port)
    clients.push(client)
    client.write(buildStartupPacket({ user: 'bob', database: 'proj1' }))

    const handshake = await readBytes(client, 9 + 13 + 6)
    assert.equal(handshake[0], 0x52, 'AuthenticationOk, not an ErrorResponse')
    assert.equal(wakeCalls, 1)
    assert.equal(upstream.connectionCount(), 1)
  } finally {
    for (const client of clients) client.destroy()
    await proxy.close()
    await upstream.close()
  }
})

// The shape measured against real Docker: the published port accepts while
// nothing in the container listens, then closes. Held and redialed exactly
// like a 57P03, for both a clean close and a reset.
for (const refuseWith of ['close', 'reset'] as const) {
  test(`issue #9: a running target whose port accepts then ${refuseWith === 'close' ? 'closes' : 'resets'} before answering holds the client until the backend serves`, async () => {
    const upstream = await startRecoveringUpstream(3, refuseWith)
    const activity = new ActivityTracker()
    const deps = { ...runningDeps(upstream.port), activity }
    const clients: net.Socket[] = []
    const proxy = await startPgProxy({ port: 0, deps, wakeTimeoutMs: 2000 })

    try {
      const client = await connectClient(proxy.port)
      clients.push(client)
      const started = Date.now()
      const packet = buildStartupPacket({ user: 'bob', database: 'proj1' })
      client.write(packet)

      const handshake = await readBytes(client, 9 + 13 + 6)
      const elapsed = Date.now() - started

      assert.equal(handshake[0], 0x52, 'the client saw AuthenticationOk, not a closed socket or an error')
      assert.ok(elapsed < 3000, `took ${elapsed}ms, over the 3 second hard ceiling`)
      assert.equal(upstream.connectionCount(), 4, 'three early closes, then the one that was served')
      for (const replayed of upstream.packets) {
        assert.deepEqual(replayed, packet, 'every attempt replays the identical startup packet')
      }
      assert.equal(activity.count('resource-1'), 1)
    } finally {
      for (const client of clients) client.destroy()
      await proxy.close()
      await upstream.close()
    }
  })
}

test('issue #9: a port that keeps accepting and closing gets the client a clean ErrorResponse at the budget, not a dropped socket', async () => {
  const upstream = await startRecoveringUpstream(Infinity, 'close')
  const activity = new ActivityTracker()
  const deps = { ...runningDeps(upstream.port), activity }
  const clients: net.Socket[] = []
  const proxy = await startPgProxy({ port: 0, deps, wakeTimeoutMs: 500 })

  try {
    const client = await connectClient(proxy.port)
    clients.push(client)
    const started = Date.now()
    client.write(buildStartupPacket({ user: 'bob', database: 'proj1' }))

    const response = await readAll(client)
    const elapsed = Date.now() - started

    assert.equal(response[0], 0x45, 'an ErrorResponse, not an empty read')
    assert.equal(extractSqlState(response), '57P03')
    const message = extractMessage(response) ?? ''
    assert.match(message, /still not accepting connections after 500ms/)
    assert.match(message, /closed it before Postgres answered/)
    assert.ok(elapsed >= 400, `gave up after ${elapsed}ms, well before the 500ms budget`)
    assert.ok(elapsed < 3000, `took ${elapsed}ms, over the 3 second hard ceiling`)
    assert.ok(upstream.connectionCount() > 1, 'the early close was retried')
    assert.equal(activity.count('resource-1'), 0)
  } finally {
    for (const client of clients) client.destroy()
    await proxy.close()
    await upstream.close()
  }
})

// The line the hold draws: once the first backend message has arrived the
// connection is spliced, and a close after that is the session's own end.
// It reaches the client as a close and is never retried.
test('issue #9: a close after the first backend message is spliced through, not retried', async () => {
  let connections = 0
  const server = net.createServer((socket) => {
    connections += 1
    socket.on('error', () => {})
    socket.once('data', () => socket.end(Buffer.from([0x52, 0, 0, 0, 8, 0, 0, 0, 0])))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const port = (server.address() as net.AddressInfo).port
  const clients: net.Socket[] = []
  const proxy = await startPgProxy({ port: 0, deps: runningDeps(port), wakeTimeoutMs: 2000 })

  try {
    const client = await connectClient(proxy.port)
    clients.push(client)
    client.write(buildStartupPacket({ user: 'bob', database: 'proj1' }))
    const response = await readAll(client)

    assert.equal(response[0], 0x52, 'the backend message reached the client')
    assert.equal(connections, 1, 'no redial after the session had started')
  } finally {
    for (const client of clients) client.destroy()
    await proxy.close()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})
