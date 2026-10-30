import assert from 'node:assert/strict'
import net from 'node:net'
import { test } from 'node:test'
import { tcpProbe } from '../src/readiness.js'

function listen(onConnection: (socket: net.Socket) => void): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = net.createServer(onConnection)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address !== null ? address.port : 0
      resolve({
        port,
        close: () =>
          new Promise((res) => {
            server.close(() => res())
          }),
      })
    })
  })
}

test('tcpProbe answers true for a server that answers with any HTTP status line', async () => {
  const server = await listen((socket) => {
    socket.on('data', () => socket.end('HTTP/1.1 500 Internal Server Error\r\ncontent-length: 0\r\n\r\n'))
  })
  try {
    assert.equal(await tcpProbe({ host: '127.0.0.1', port: server.port, timeoutMs: 500 })(), true)
  } finally {
    await server.close()
  }
})

// Docker's port proxy accepts on the host the instant a container exists,
// then closes at once when nothing inside is listening.
test('tcpProbe answers false for a port that accepts and closes without a byte', async () => {
  const server = await listen((socket) => socket.destroy())
  try {
    assert.equal(await tcpProbe({ host: '127.0.0.1', port: server.port, timeoutMs: 500 })(), false)
  } finally {
    await server.close()
  }
})

// Issue #79: a server whose `/` takes longer than the window is listening.
// Before this it timed out, answered false, and the deploy failed with the
// loopback-bind hint.
test('tcpProbe answers true for a server that accepts and holds the connection past the window', async () => {
  const held: net.Socket[] = []
  const server = await listen((socket) => {
    held.push(socket)
    socket.on('data', () => {})
  })
  try {
    assert.equal(await tcpProbe({ host: '127.0.0.1', port: server.port, timeoutMs: 100 })(), true)
  } finally {
    for (const socket of held) socket.destroy()
    await server.close()
  }
})

test('tcpProbe answers false for a port nothing listens on', async () => {
  const server = await listen(() => {})
  const port = server.port
  await server.close()
  assert.equal(await tcpProbe({ host: '127.0.0.1', port, timeoutMs: 500 })(), false)
})

// Issue #55: the loop ends the moment the container is seen to have exited.
test('waitListening returns exited, not a timeout, once the status says the container stopped', async () => {
  const { waitListening } = await import('../src/readiness.js')
  let clock = 0
  let statusCalls = 0
  const result = await waitListening({
    probe: async () => false,
    pollMs: 10,
    timeoutMs: 60_000,
    status: async () => {
      statusCalls++
      return statusCalls < 3 ? { exists: true, running: true, exitCode: null } : { exists: true, running: false, exitCode: 137 }
    },
    now: () => clock,
    sleepFor: async (ms) => {
      clock += ms
    },
  })
  assert.equal(result.ready, false)
  assert.deepEqual(result.exited, { exitCode: 137 })
  assert.equal(result.attempts, 3)
  assert.equal(clock, 20, 'two polls, then the exit was seen')
})

test('waitListening keeps polling when the status check itself fails', async () => {
  const { waitListening } = await import('../src/readiness.js')
  let clock = 0
  const result = await waitListening({
    probe: async () => clock >= 30,
    pollMs: 10,
    timeoutMs: 60_000,
    status: async () => {
      throw new Error('docker inspect failed')
    },
    now: () => clock,
    sleepFor: async (ms) => {
      clock += ms
    },
  })
  assert.equal(result.ready, true)
  assert.equal(result.exited, undefined)
})
