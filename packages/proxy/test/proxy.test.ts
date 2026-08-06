// Written but not executed in this task, see task-6-report.md.

import assert from 'node:assert/strict'
import net from 'node:net'
import { test } from 'node:test'
import { ActivityTracker, buildStartupPacket, startPgProxy, type ProxyDeps, type ProxyTarget } from '../src/index.js'

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

// A fake upstream Postgres: accepts connections and records the raw bytes
// each one sends first, which is what the proxy's replayed startup packet
// arrives as. Never actually speaks Postgres; the proxy is not expected to
// notice, since it never parses anything upstream of the splice.
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

test('a sleeping target calls wake exactly once and the upstream receives the startup packet verbatim', async () => {
  const upstream = await startFakeUpstream()

  let wakeCalls = 0
  let resolveCalls = 0
  const deps: ProxyDeps = {
    resolve: async (): Promise<ProxyTarget> => {
      resolveCalls += 1
      // First resolve (pre-wake) reports sleeping; every subsequent
      // resolve (the re-resolve after wake) reports running. This is what
      // exercises requirement #4: the proxy must re-resolve rather than
      // trust the pre-wake address.
      return {
        resourceId: 'resource-1',
        host: '127.0.0.1',
        port: upstream.port,
        state: resolveCalls === 1 ? 'sleeping' : 'running',
      }
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
    close(resourceId: string): void {
      this.closeCalls += 1
      super.close(resourceId)
    }
  }
  const activity = new CountingActivityTracker()

  const deps: ProxyDeps = {
    resolve: async (): Promise<ProxyTarget> => ({
      resourceId: 'resource-1',
      host: '127.0.0.1',
      port: upstream.port,
      state: 'running',
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
    await new Promise((resolve) => setTimeout(resolve, 10))

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
    close(resourceId: string): void {
      this.closeCalls += 1
      super.close(resourceId)
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
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.ok(upstreamSocket !== null)
    // TypeScript cannot see past the net.createServer callback that
    // assigns upstreamSocket, so the assert.ok above narrows the read type
    // to `never` rather than `net.Socket`. A cast is the standard escape
    // for a `let` captured and reassigned inside a closure.
    const upstream = upstreamSocket as net.Socket

    // Upstream closes first.
    upstream.destroy()
    await new Promise((resolve) => setTimeout(resolve, 10))

    assert.equal(activity.closeCalls, 1)
    assert.equal(activity.count('resource-1'), 0)

    client.destroy()
  } finally {
    await proxy.close()
    await new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve(undefined))))
  }
})

test('ActivityTracker counts opens and closes and reports idle seconds only when the count is zero', () => {
  let now = 1_000_000
  const tracker = new ActivityTracker(() => now)

  assert.equal(tracker.count('r1'), 0)
  assert.equal(tracker.idleSeconds('r1'), null)

  tracker.open('r1')
  assert.equal(tracker.count('r1'), 1)
  assert.equal(tracker.idleSeconds('r1'), null) // still active, not idle

  tracker.open('r1')
  assert.equal(tracker.count('r1'), 2)

  tracker.close('r1')
  assert.equal(tracker.count('r1'), 1)
  assert.equal(tracker.idleSeconds('r1'), null) // one connection still open

  now += 5_000 // 5 real seconds later, but still not idle
  tracker.close('r1')
  assert.equal(tracker.count('r1'), 0)
  assert.equal(tracker.idleSeconds('r1'), 0) // just closed, at the moment it closed

  now += 30_000
  assert.equal(tracker.idleSeconds('r1'), 30)

  assert.deepEqual(tracker.resources(), ['r1'])
})

test('ActivityTracker.close is idempotent: closing an already-zero count does not go negative', () => {
  let now = 0
  const tracker = new ActivityTracker(() => now)

  tracker.open('r1')
  tracker.close('r1')
  assert.equal(tracker.count('r1'), 0)

  // Extra closes beyond the matching open must not push the count negative,
  // nor move lastCloseAt forward on their own.
  now += 100
  tracker.close('r1')
  tracker.close('r1')
  assert.equal(tracker.count('r1'), 0)
  assert.equal(tracker.idleSeconds('r1'), 100)
})
