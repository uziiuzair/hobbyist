// The tick, driven by a fake clock and a recorder for wake/deliver calls, no
// Docker and no real HTTP anywhere in this file: deliver.ts's own HTTP hop is
// exercised by whatever wires it to a real control port, not here. What is
// tested here is tick.ts's own decision making, against a fake wake and a
// fake deliver, exactly as mirror.test.ts exercises startAlarmMirror against
// a fake wake with no workerd in the loop.

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import type { ResourceState } from '@hobby.sh/core'
import {
  DEFAULT_CONSUMER_OPTIONS,
  LEASE_MS,
  depth,
  enqueue,
  hasOutstandingLease,
  peek,
  type ConsumerOptions,
  type DeliveryResult,
  type LeasedBatch,
} from '../src/broker.js'
import { openQueueDb } from '../src/schema.js'
import { tickOnce, type DrainableQueue } from '../src/tick.js'

const roots: string[] = []
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'hobby-tick-'))
  roots.push(dir)
  return dir
}
after(() => {
  for (const root of roots) {
    rmSync(root, { recursive: true, force: true })
  }
})

const NOW = 1786375171389

function json(value: unknown): { body: string; contentType: 'json' } {
  return { body: JSON.stringify(value), contentType: 'json' }
}

// Writes `count` messages directly into the queue's own sqlite file, the way
// the enqueue endpoint would, before the tick ever runs.
function seed(dbPath: string, count: number, nowMs: number = NOW): string[] {
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

function makeQueue(overrides: Partial<DrainableQueue> = {}): DrainableQueue {
  const dir = tempDir()
  return {
    resourceId: 'queue-1',
    consumerResourceId: 'consumer-1',
    queueName: 'main',
    dbPath: join(dir, 'main.sqlite'),
    deadLetterDbPath: null,
    options: DEFAULT_CONSUMER_OPTIONS,
    retentionSeconds: 345_600,
    ...overrides,
  }
}

type DeliverImpl = (consumerResourceId: string, batch: LeasedBatch, queueName: string) => Promise<DeliveryResult>

const OK: DeliveryResult = { outcome: 'ok', retryBatch: { retry: false }, retryMessages: [] }

// A fake wake/deliver/stateOf triple, with every call recorded. wake()
// mirrors production's own contract (packages/cli/src/daemon/context.ts's
// buildWake, via startWorker): it does not resolve until the resource is
// actually running, so it flips the fake state to 'running' as a side effect
// before resolving, exactly as the real one only ever resolves once
// waitListening has already succeeded.
function harness(initialStates: Record<string, ResourceState>) {
  const states: Record<string, ResourceState> = { ...initialStates }
  const woken: string[] = []
  const delivered: Array<{ consumerResourceId: string; batch: LeasedBatch; queueName: string }> = []
  let deliverImpl: DeliverImpl = async () => OK

  return {
    states,
    woken,
    delivered,
    setDeliver(fn: DeliverImpl): void {
      deliverImpl = fn
    },
    async wake(resourceId: string): Promise<void> {
      woken.push(resourceId)
      states[resourceId] = 'running'
    },
    async deliver(consumerResourceId: string, batch: LeasedBatch, queueName: string): Promise<DeliveryResult> {
      delivered.push({ consumerResourceId, batch, queueName })
      return deliverImpl(consumerResourceId, batch, queueName)
    },
    stateOf(resourceId: string): ResourceState {
      return states[resourceId] ?? 'sleeping'
    },
  }
}

test('a queue with nothing ready neither wakes nor delivers', async () => {
  const queue = makeQueue()
  const h = harness({ 'consumer-1': 'running' })

  await tickOnce([queue], { wake: h.wake, deliver: h.deliver, stateOf: h.stateOf, now: () => NOW })

  assert.deepEqual(h.woken, [])
  assert.deepEqual(h.delivered, [])
})

test('a ready batch on a running consumer delivers without waking it', async () => {
  const queue = makeQueue()
  seed(queue.dbPath, 5) // a full batch (maxBatchSize 5) is ready immediately
  const h = harness({ 'consumer-1': 'running' })

  await tickOnce([queue], { wake: h.wake, deliver: h.deliver, stateOf: h.stateOf, now: () => NOW + 2000 })

  assert.deepEqual(h.woken, [])
  assert.equal(h.delivered.length, 1)
  assert.equal(h.delivered[0]?.consumerResourceId, 'consumer-1')
  assert.equal(h.delivered[0]?.queueName, 'main')
  assert.equal(h.delivered[0]?.batch.messages.length, 5)

  const db = openQueueDb(queue.dbPath)
  assert.equal(depth(db), 0, 'a clean ok result acked the whole batch')
  db.close()
})

test('a ready batch on a sleeping consumer wakes it exactly once, then delivers', async () => {
  const queue = makeQueue()
  seed(queue.dbPath, 5)
  const h = harness({ 'consumer-1': 'sleeping' })

  await tickOnce([queue], { wake: h.wake, deliver: h.deliver, stateOf: h.stateOf, now: () => NOW + 2000 })

  assert.deepEqual(h.woken, ['consumer-1'])
  assert.equal(h.delivered.length, 1)
})

test('a consumer already starting is left for the next tick, with no wake stacked', async () => {
  const queue = makeQueue()
  seed(queue.dbPath, 5)
  const h = harness({ 'consumer-1': 'starting' })

  await tickOnce([queue], { wake: h.wake, deliver: h.deliver, stateOf: h.stateOf, now: () => NOW + 2000 })

  assert.deepEqual(h.woken, [], 'no wake stacked on top of the one already in flight')
  assert.deepEqual(h.delivered, [], 'nothing was leased or delivered this tick')

  const db = openQueueDb(queue.dbPath)
  assert.equal(depth(db), 5, 'every message is still there, untouched')
  assert.equal(hasOutstandingLease(db, NOW + 2000), false, 'nothing was even leased')
  db.close()
})

test('a delivery that throws leaves the messages leased, and the next tick after the lease expires redelivers them', async () => {
  const queue = makeQueue()
  seed(queue.dbPath, 5)
  const h = harness({ 'consumer-1': 'running' })
  let attempt = 0
  h.setDeliver(async () => {
    attempt += 1
    if (attempt === 1) {
      throw new Error('container unreachable')
    }
    return OK
  })

  let now = NOW + 2000
  await tickOnce([queue], { wake: h.wake, deliver: h.deliver, stateOf: h.stateOf, now: () => now })

  assert.equal(h.delivered.length, 1, 'delivery was attempted once, and threw')
  {
    const db = openQueueDb(queue.dbPath)
    assert.equal(depth(db), 5, 'nothing was lost')
    assert.equal(hasOutstandingLease(db, now), true, 'the batch is still leased, not requeued early')
    db.close()
  }

  // Advance past the lease. expireLeases (step 1 of the next tick) clears it
  // and makes every message visible again.
  now += LEASE_MS + 1
  await tickOnce([queue], { wake: h.wake, deliver: h.deliver, stateOf: h.stateOf, now: () => now })

  assert.equal(h.delivered.length, 2, 'redelivered on the tick after the lease expired')
  const db = openQueueDb(queue.dbPath)
  assert.equal(depth(db), 0, 'the second, successful delivery acked everything')
  db.close()
})

test("dead lettered messages are written into the dead letter queue's own database with their body intact", async () => {
  const dir = tempDir()
  const options: ConsumerOptions = { ...DEFAULT_CONSUMER_OPTIONS, maxBatchSize: 1, maxRetries: 0 }
  const queue = makeQueue({
    dbPath: join(dir, 'main.sqlite'),
    deadLetterDbPath: join(dir, 'dlq.sqlite'),
    options,
  })
  seed(queue.dbPath, 1)
  const h = harness({ 'consumer-1': 'running' })
  h.setDeliver(async () => ({ outcome: 'exception', retryBatch: { retry: false }, retryMessages: [] }))

  await tickOnce([queue], { wake: h.wake, deliver: h.deliver, stateOf: h.stateOf, now: () => NOW + 2000 })

  const source = openQueueDb(queue.dbPath)
  assert.equal(depth(source), 0, 'gone from the source queue: attempts (1) exceeded maxRetries (0)')
  source.close()

  const dlqPath = queue.deadLetterDbPath
  assert.ok(dlqPath !== null)
  const dlq = openQueueDb(dlqPath)
  const rows = peek(dlq, 10)
  dlq.close()

  assert.equal(rows.length, 1, 'exactly one message landed in the dead letter queue')
  assert.equal(rows[0]?.body, JSON.stringify({ i: 0 }), 'the body is intact')
  assert.equal(rows[0]?.contentType, 'json')
})

test('a queue whose deadLetterDbPath is null drops dead lettered messages and reaches depth zero', async () => {
  const options: ConsumerOptions = { ...DEFAULT_CONSUMER_OPTIONS, maxBatchSize: 1, maxRetries: 0 }
  const queue = makeQueue({ deadLetterDbPath: null, options })
  seed(queue.dbPath, 1)
  const h = harness({ 'consumer-1': 'running' })
  h.setDeliver(async () => ({ outcome: 'exception', retryBatch: { retry: false }, retryMessages: [] }))

  await tickOnce([queue], { wake: h.wake, deliver: h.deliver, stateOf: h.stateOf, now: () => NOW + 2000 })

  const db = openQueueDb(queue.dbPath)
  assert.equal(depth(db), 0, 'the message was dropped, not stuck retrying forever')
  db.close()
})

test('retention is swept every tick, whether or not a batch is ready', async () => {
  const queue = makeQueue({ retentionSeconds: 60 })
  seed(queue.dbPath, 1, NOW) // one message, below maxBatchSize, so never "ready" on count alone
  const h = harness({ 'consumer-1': 'running' })

  await tickOnce([queue], { wake: h.wake, deliver: h.deliver, stateOf: h.stateOf, now: () => NOW + 61_000 })

  const db = openQueueDb(queue.dbPath)
  assert.equal(depth(db), 0, 'the message aged out of retention before it could ever be delivered')
  db.close()
  assert.deepEqual(h.delivered, [], 'a swept message is never handed to deliver')
})

test('one queue throwing does not stop the others in the same tick', async () => {
  // A directory where a file is expected makes the sqlite open itself throw,
  // the same class of failure assertAlarmSchema exists to surface for the
  // alarm mirror, forced here by a filesystem collision instead of a bad
  // schema.
  const brokenDir = tempDir()
  const broken = makeQueue({
    resourceId: 'broken',
    consumerResourceId: 'consumer-broken',
    dbPath: brokenDir,
  })
  const healthy = makeQueue({ resourceId: 'healthy', consumerResourceId: 'consumer-healthy' })
  seed(healthy.dbPath, 5)

  const h = harness({ 'consumer-healthy': 'running' })

  await tickOnce([broken, healthy], { wake: h.wake, deliver: h.deliver, stateOf: h.stateOf, now: () => NOW + 2000 })

  assert.equal(h.delivered.length, 1, 'the broken queue did not stop the healthy one from being drained')
  assert.equal(h.delivered[0]?.consumerResourceId, 'consumer-healthy')
})

// The "no deployed code" predicate itself (checking WorkerConfig.manifest, or
// an empty queues.consumers) lives one layer up, in
// packages/cli/src/daemon/queues.ts's hasNoDeployedCode: this package knows
// nothing about WorkerConfig, only about DrainableQueue. What this package
// owes is the other half of that contract, proven here: a queue that
// drainableQueues() excludes from the list it hands to the tick (exactly
// what it does for a consumer with no deployed code) is left completely
// alone. Simulated by simply never including it, since that is the only
// input surface this package exposes.
test('a queue excluded from the drainable list, as for a consumer with no deployed code, is left alone', async () => {
  const undeployed = makeQueue({ resourceId: 'undeployed-queue', consumerResourceId: 'consumer-undeployed' })
  seed(undeployed.dbPath, 5)

  const deployed = makeQueue({ resourceId: 'deployed-queue', consumerResourceId: 'consumer-deployed' })
  seed(deployed.dbPath, 5)

  const h = harness({ 'consumer-undeployed': 'sleeping', 'consumer-deployed': 'sleeping' })

  // Only the deployed queue is handed to the tick, exactly what
  // drainableQueues() would produce once it had filtered the undeployed
  // consumer's queue out of the store's own list.
  await tickOnce([deployed], { wake: h.wake, deliver: h.deliver, stateOf: h.stateOf, now: () => NOW + 2000 })

  assert.deepEqual(h.woken, ['consumer-deployed'], 'the undeployed consumer was never woken')
  assert.equal(h.delivered.length, 1)
  assert.equal(h.delivered[0]?.consumerResourceId, 'consumer-deployed')

  const db = openQueueDb(undeployed.dbPath)
  assert.equal(depth(db), 5, "the undeployed consumer's queue still holds every message")
  db.close()
})
