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
