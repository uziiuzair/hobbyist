// The one place tick.ts and deliver.ts are exercised together against a
// real socket, deliberately separate from tick.test.ts (whose own header
// comment says "no real HTTP anywhere in this file"): this file exists
// specifically to prove the review finding it was written for, that a hung
// consumer on one queue does not stall the others in the same tick, nor stall
// tickOnce itself, once deliver.ts's fetch is bounded by a timeout. A fake
// deliver can only prove tick.ts's own bookkeeping around whatever
// DeliveryResult it is handed; it cannot prove the timeout actually fires
// against a real stalled socket, which is the failure mode under test here.

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import type { ResourceState } from '@hobby.sh/core'
import { depth, enqueue, hasOutstandingLease, DEFAULT_CONSUMER_OPTIONS } from '../src/broker.js'
import { deliverBatch } from '../src/deliver.js'
import { openQueueDb } from '../src/schema.js'
import { tickOnce, type DrainableQueue } from '../src/tick.js'

const roots: string[] = []
const servers: Server[] = []
after(async () => {
  for (const root of roots) {
    rmSync(root, { recursive: true, force: true })
  }
  await Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))))
})

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'hobby-tick-integration-'))
  roots.push(dir)
  return dir
}

function json(value: unknown): { body: string; contentType: 'json' } {
  return { body: JSON.stringify(value), contentType: 'json' }
}

function seed(dbPath: string, count: number, nowMs: number): string[] {
  const db = openQueueDb(dbPath)
  try {
    return enqueue(
      db,
      Array.from({ length: count }, (_, i) => json({ i })),
      nowMs
    )
  } finally {
    db.close()
  }
}

function hangingServer(): Promise<{ port: number }> {
  const server = createServer(() => {
    // Never responds, simulating a deadlocked queue() handler.
  })
  servers.push(server)
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      resolve({ port: typeof address === 'object' && address !== null ? address.port : 0 })
    })
  })
}

const NOW = 1786375171389

test('one queue whose consumer hangs does not stop the tick, and a healthy queue in the same tick still delivers', async () => {
  const hung = await hangingServer()

  const hungDir = tempDir()
  const hungQueue: DrainableQueue = {
    resourceId: 'hung-queue',
    consumerResourceId: 'hung-consumer',
    queueName: 'jobs',
    dbPath: join(hungDir, 'main.sqlite'),
    deadLetterDbPath: null,
    options: DEFAULT_CONSUMER_OPTIONS,
    retentionSeconds: 345_600,
  }
  seed(hungQueue.dbPath, 5, NOW)

  const healthyDir = tempDir()
  const healthyQueue: DrainableQueue = {
    resourceId: 'healthy-queue',
    consumerResourceId: 'healthy-consumer',
    queueName: 'jobs',
    dbPath: join(healthyDir, 'main.sqlite'),
    deadLetterDbPath: null,
    options: DEFAULT_CONSUMER_OPTIONS,
    retentionSeconds: 345_600,
  }
  seed(healthyQueue.dbPath, 5, NOW)

  const healthyDelivered: string[] = []
  const states: Record<string, ResourceState> = { 'hung-consumer': 'running', 'healthy-consumer': 'running' }

  const started = Date.now()
  await tickOnce([hungQueue, healthyQueue], {
    wake: async () => {},
    // A real deliverBatch for BOTH queues, but only the hung one actually
    // points at a real (stalled) socket; the short timeoutMs is what keeps
    // this test fast rather than waiting out the real, LEASE_MS-derived
    // DELIVERY_TIMEOUT_MS.
    deliver: async (consumerResourceId, batch, queueName) => {
      if (consumerResourceId === 'hung-consumer') {
        return deliverBatch(hung.port, batch, queueName, 100)
      }
      healthyDelivered.push(consumerResourceId)
      return { outcome: 'ok', retryBatch: { retry: false }, retryMessages: [] }
    },
    stateOf: (resourceId) => states[resourceId] ?? 'sleeping',
    now: () => NOW + 2000,
  })
  const elapsedMs = Date.now() - started

  // The whole tick, including the hung queue's bounded wait, finished well
  // under the real 30-second DELIVERY_TIMEOUT_MS: proof the loop did not
  // hang, not merely that it eventually would have.
  assert.ok(elapsedMs < 5000, `expected the tick to finish well under 5s, took ${elapsedMs}ms`)

  // The healthy queue was still reached and delivered to in the same tick.
  assert.deepEqual(healthyDelivered, ['healthy-consumer'])
  const healthyDb = openQueueDb(healthyQueue.dbPath)
  assert.equal(depth(healthyDb), 0, 'the healthy queue was acked normally')
  healthyDb.close()

  // The hung queue's messages were retried through the normal applyResult
  // path (deliverBatch's abort produced an exception result, not a throw),
  // not left leased waiting for LEASE_MS to pass.
  const hungDb = openQueueDb(hungQueue.dbPath)
  assert.equal(depth(hungDb), 5, 'nothing was lost')
  assert.equal(hasOutstandingLease(hungDb, NOW + 2000), false, 'the lease was cleared immediately, not left to expire')
  hungDb.close()
})
