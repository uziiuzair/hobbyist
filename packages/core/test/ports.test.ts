import assert from 'node:assert/strict'
import net from 'node:net'
import { test } from 'node:test'
import { allocateHostPort, isHostPortFree } from '../src/ports.js'

function hold(): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = net.createServer()
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address !== null ? address.port : 0
      resolve({ port, close: () => new Promise((res) => server.close(() => res())) })
    })
  })
}

// Issue #60: the store only knew the ports its own rows held, so a port
// taken by any other process made every `hobby new` fail the same way
// until that process let go.
test('allocateHostPort skips a port another process holds and hands out the next one', async () => {
  const held = await hold()
  try {
    const from = held.port
    const store = {
      allocatePort(_from: number, _to: number, exclude: number[] = []): number {
        for (let port = from; port <= from + 5; port++) {
          if (!exclude.includes(port)) return port
        }
        throw new Error('exhausted')
      },
    }
    assert.equal(await isHostPortFree(held.port), false)
    const port = await allocateHostPort(store, from, from + 5)
    assert.notEqual(port, held.port)
    assert.equal(await isHostPortFree(port), true)
  } finally {
    await held.close()
  }
})

test('allocateHostPort passes the caller exclusions through and keeps its own', async () => {
  const asked: number[][] = []
  const store = {
    allocatePort(_from: number, _to: number, exclude: number[] = []): number {
      asked.push([...exclude])
      return 40000 + exclude.length
    },
  }
  const port = await allocateHostPort(store, 40000, 40010, [39999], async (p) => p !== 40001)
  assert.equal(port, 40002)
  assert.deepEqual(asked, [[39999], [39999, 40001]])
})
