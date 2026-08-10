// The registry that turns a cancel key back into a connection. Every test
// here injects its own mint, because the property under test is what the
// map does with the keys, not how random they are.

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CancelRegistry, mintCancelKey, type CancelKey, type CancelRoute } from '../src/index.js'

function route(port: number): CancelRoute {
  return { host: '127.0.0.1', port, backendKey: null }
}

// A mint that walks a fixed list, so a test can force a collision.
function mintFrom(keys: CancelKey[]): () => CancelKey {
  let index = 0
  return () => {
    const key = keys[Math.min(index++, keys.length - 1)]
    if (key === undefined) {
      throw new Error('mintFrom was given no keys')
    }
    return key
  }
}

test('a route is not resolvable until BackendKeyData has arrived', () => {
  const registry = new CancelRegistry(mintFrom([{ processId: 1, secretKey: 2 }]))
  const target = route(5432)

  const issued = registry.add(target)
  assert.ok(issued !== null)

  // Registered, but the backend has not said who it is yet: this is the
  // window a connection sits in while it authenticates.
  assert.equal(registry.size, 1)
  assert.equal(registry.lookup(issued), null)

  target.backendKey = { processId: 4242, secretKey: 24242 }
  assert.deepEqual(registry.lookup(issued), {
    host: '127.0.0.1',
    port: 5432,
    backendKey: { processId: 4242, secretKey: 24242 },
  })
})

test('a key this registry never issued resolves to nothing', () => {
  const registry = new CancelRegistry(mintFrom([{ processId: 1, secretKey: 2 }]))
  const target = route(5432)
  target.backendKey = { processId: 4242, secretKey: 24242 }
  registry.add(target)

  assert.equal(registry.lookup({ processId: 9999, secretKey: 8888 }), null)
  // Half a match is no match: both halves are the key.
  assert.equal(registry.lookup({ processId: 1, secretKey: 8888 }), null)
  assert.equal(registry.lookup({ processId: 9999, secretKey: 2 }), null)
})

test('removing a route leaves nothing behind, so the map is bounded by live connections', () => {
  const registry = new CancelRegistry(mintFrom([{ processId: 1, secretKey: 2 }]))
  const target = route(5432)
  target.backendKey = { processId: 4242, secretKey: 24242 }

  const issued = registry.add(target)
  assert.ok(issued !== null)
  assert.equal(registry.size, 1)

  registry.remove(issued)
  assert.equal(registry.size, 0)
  assert.equal(registry.lookup(issued), null)

  // A second remove of the same key is a no-op, which matters because
  // finish() in the proxy is reachable from four different events.
  registry.remove(issued)
  assert.equal(registry.size, 0)
})

test('a collision is minted around rather than overwritten', () => {
  const taken: CancelKey = { processId: 1, secretKey: 2 }
  const free: CancelKey = { processId: 3, secretKey: 4 }
  const registry = new CancelRegistry(mintFrom([taken, taken, free]))

  const first = route(5432)
  first.backendKey = { processId: 100, secretKey: 200 }
  const firstKey = registry.add(first)
  assert.deepEqual(firstKey, taken)

  const second = route(5433)
  second.backendKey = { processId: 300, secretKey: 400 }
  const secondKey = registry.add(second)

  assert.deepEqual(secondKey, free)
  assert.ok(firstKey !== null)
  // The first connection's key still points at the first connection. An
  // overwrite here would cancel the wrong query.
  assert.equal(registry.lookup(firstKey)?.port, 5432)
  assert.equal(registry.size, 2)
})

test('a mint that can only produce a taken key gives up rather than spinning', () => {
  const only: CancelKey = { processId: 1, secretKey: 2 }
  const registry = new CancelRegistry(() => only)

  assert.deepEqual(registry.add(route(5432)), only)
  // Null means this connection gets no cancel routing, which is what every
  // connection had before the registry existed. It is not an error.
  assert.equal(registry.add(route(5433)), null)
  assert.equal(registry.size, 1)
})

test('mintCancelKey produces a plausible, positive process id and does not repeat', () => {
  const seen = new Set<string>()
  for (let i = 0; i < 200; i++) {
    const key = mintCancelKey()
    assert.ok(key.processId > 0, 'a process id a client might display should look like one')
    assert.ok(key.processId <= 0x7fffffff)
    // Int32 range, since these go on the wire through writeInt32BE.
    assert.ok(key.secretKey >= -0x80000000 && key.secretKey <= 0x7fffffff)
    seen.add(`${key.processId}:${key.secretKey}`)
  }
  assert.equal(seen.size, 200)
})
