// The queue tick: the impure half, and the only file in this package that
// touches real time, a container's control port, or the running/sleeping
// state of a worker. Modeled closely on packages/do/src/mirror.ts, which
// docs/queues/CLAUDE.md and this task's own brief both call the reference
// shape: same `now` and `sleepFor` injectable seams, same `waitOrStop`, same
// drain-on-stop through a tracked `currentTick`, same per-item try/catch so
// one bad queue cannot stall the others. Where this differs from that file is
// called out inline below, and summarized in this task's report.
//
// One pass per queue, in the order docs/queues/specs/2026-08-13-queues-design.md
// lays out under "The tick": expire leases, sweep retention, check readiness,
// wake if sleeping, lease, deliver, apply, route dead letters. Each step reads
// the store and the queue's own sqlite file fresh every tick, exactly as the
// alarm mirror re-reads alarm schedules fresh every tick: this package holds
// no cache of its own that would need an invalidation path back from a
// process it does not observe.

import type { ResourceState } from '@hobby.sh/core'
import {
  applyResult,
  enqueue,
  expireLeases,
  isBatchReady,
  leaseBatch,
  sweepRetention,
  type ConsumerOptions,
  type DeliveryResult,
  type LeasedBatch,
  type LeasedMessage,
} from './broker.js'
import { openQueueDb } from './schema.js'

// One queue this daemon is responsible for draining. Built fresh each tick by
// packages/cli/src/daemon/queues.ts, the join between the store and this
// package, mirroring alarms.ts's own MirroredNamespace join.
//
// `queueName` is the one field the task brief's own interface sketch left
// off but that `deliver`'s own signature (below) requires: the wire protocol
// hands the consumer's queue() handler `payload.queue`, the wrangler-declared
// name, never a resource id. A resource id is an implementation detail user
// code inside the container should never see, so it cannot double as that
// name. Recorded here as a deliberate addition; see this task's report.
export interface DrainableQueue {
  resourceId: string
  consumerResourceId: string
  queueName: string
  dbPath: string
  deadLetterDbPath: string | null
  options: ConsumerOptions
  retentionSeconds: number
}

export interface QueueTickOptions {
  // Called fresh each tick rather than captured once, so a queue created or
  // destroyed while the daemon runs is picked up without restarting the tick.
  queues: () => DrainableQueue[]
  // Asked for, never performed here. Resolving means the consumer is running;
  // rejecting is logged and left for the next tick, exactly as the alarm
  // mirror's own wake.
  wake: (resourceId: string) => Promise<void>
  deliver: (consumerResourceId: string, batch: LeasedBatch, queueName: string) => Promise<DeliveryResult>
  stateOf: (resourceId: string) => ResourceState
  intervalMs: number
  // Injectable seams, matching startAlarmMirror's: the loop is testable
  // against a fake clock with zero real time passing. Production omits both.
  now?: () => number
  sleepFor?: (ms: number) => Promise<void>
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function defaultSleepFor(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    // Never let this background loop's own wait keep the process alive. Same
    // reasoning as hibernator.ts's and mirror.ts's own defaultSleepFor.
    timer.unref?.()
  })
}

// Writes one dead lettered message into the dead letter queue's OWN
// database, opened, written and closed synchronously, right here, inside the
// onDeadLetter callback broker.ts invokes BEFORE it deletes the row from the
// source database (applyResult / expireLeases, both in broker.ts). That
// ordering is the whole guarantee constraint 1 of this task exists to
// protect: the dead letter queue is a separate sqlite file and cannot join
// the source database's transaction, so writing here, before the source's
// delete, turns a possible message LOSS (crash between the source's delete
// and a deferred dead-letter write) into a possible DUPLICATE (crash between
// this write and the source's own commit). At-least-once is already this
// queue's contract, so a duplicate is acceptable and a loss is not.
//
// Deliberately NOT batched across the messages in one applyResult/expireLeases
// call, even though that would mean fewer sqlite opens: batching would mean
// collecting messages in memory during the callback and writing them out only
// after the source transaction has already committed, which reopens exactly
// the loss window this function exists to close. See broker.ts's own comment
// on the same callback for the same reasoning stated from the source side.
//
// Uses the broker's own public enqueue(), not a raw INSERT, so a dead
// lettered message gets a fresh id and a fresh retention clock starting from
// the moment it lands in the dead letter queue. Restarting the clock is
// deliberate: inheriting the original enqueued_at would let a message that
// had already been sitting for most of its retention window get swept on the
// very next tick, disappearing from the dead letter queue before anyone had a
// chance to `hobby queue peek` it.
function routeDeadLetter(deadLetterDbPath: string | null, message: LeasedMessage, nowMs: number): void {
  if (deadLetterDbPath === null) {
    // Matches Cloudflare: a consumer with no configured dead_letter_queue
    // simply drops a message that exhausted its retries, after broker.ts's
    // own deadLettered bookkeeping already counted it.
    return
  }
  const db = openQueueDb(deadLetterDbPath)
  try {
    enqueue(db, [{ body: message.body, contentType: message.contentType }], nowMs)
  } finally {
    db.close()
  }
}

// One queue, one pass: expire leases, sweep retention, check readiness, wake
// if sleeping, lease, deliver, apply, route dead letters. Returns early the
// moment there is nothing further to do this tick, so a queue with no ready
// batch costs one isBatchReady read and nothing else.
async function tickOneQueue(
  queue: DrainableQueue,
  opts: { wake: QueueTickOptions['wake']; deliver: QueueTickOptions['deliver']; stateOf: QueueTickOptions['stateOf'] },
  nowMs: number
): Promise<void> {
  const db = openQueueDb(queue.dbPath)
  try {
    // Step 1: expire leases. A lease that ran out means the consumer never
    // answered: crashed, was slept out from under a batch (which the guard in
    // guard.ts exists to prevent, but a daemon restart bypasses any guard),
    // or the daemon itself restarted mid-batch.
    expireLeases(db, queue.options, nowMs, (message) => routeDeadLetter(queue.deadLetterDbPath, message, nowMs))

    // Step 2: sweep retention, every tick, whether or not a batch is ready:
    // constraint from this task's brief and from the design doc's own "The
    // tick" section. A queue with a consumer that never wakes must still age
    // out its backlog on schedule.
    sweepRetention(db, queue.retentionSeconds, nowMs)

    // Step 3: is a batch ready at all.
    if (!isBatchReady(db, queue.options, nowMs)) {
      return
    }

    // Step 4: wake if sleeping, deliver once running. A consumer already
    // `starting` is left for the next tick rather than a second wake being
    // issued: mirror.ts documents the identical rule ("never stack wakes") for
    // the identical reason, an in-flight start that is not yet ready to serve.
    // Any other non-`running` state (`stopping`, `failed`, `creating`,
    // `destroying`) is treated the same way: there is nothing this tick can
    // usefully do until the consumer settles.
    const state = opts.stateOf(queue.consumerResourceId)
    if (state === 'sleeping') {
      // wake()'s own contract (packages/cli/src/daemon/context.ts's buildWake,
      // which this queue's real wake option is built from) does not resolve
      // until the resource has been proven to serve, so nothing here re-checks
      // stateOf after this await: by the time it resolves, the consumer is
      // running.
      await opts.wake(queue.consumerResourceId)
    } else if (state !== 'running') {
      return
    }

    // Step 5: lease.
    const batch = leaseBatch(db, queue.options, nowMs)
    if (batch === null) {
      return
    }

    // Step 6: deliver. A throw here (network failure the deliver
    // implementation itself did not already turn into an EXCEPTION_RESULT, or
    // a bug) leaves the batch's rows leased exactly as they are: nothing here
    // requeues them early. They come back on their own on a later tick, once
    // the lease set at leaseBatch expires, through step 1 of that tick. This
    // is deliberately not a try/catch around applyResult too: a throw between
    // deliver succeeding and applyResult finishing would be a bug in this
    // file, not a delivery failure, and should surface rather than be
    // swallowed into "leave it leased."
    let result: DeliveryResult
    try {
      result = await opts.deliver(queue.consumerResourceId, batch, queue.queueName)
    } catch (err) {
      console.error(
        `queue tick: delivery threw for queue ${queue.resourceId}, leaving ${batch.messages.length} message(s) leased: ${errorMessage(err)}`
      )
      return
    }

    // Step 7: apply the result and route dead letters, in that order:
    // applyResult calls onDeadLetter itself, before it deletes the row, so
    // the routing already happened by the time this line returns.
    applyResult(db, batch.leaseId, result, queue.options, nowMs, (message) =>
      routeDeadLetter(queue.deadLetterDbPath, message, nowMs)
    )
  } finally {
    db.close()
  }
}

// One pass over every drainable queue. Failures are contained per queue,
// exactly as tickOnce in mirror.ts contains them per namespace: an unreadable
// or corrupt queue database must not stop the other queues in the same tick
// from being drained.
//
// This loop is sequential, one queue at a time, not Promise.all. A try/catch
// around each queue only sees a throw, never a hang, so the worst case for
// one tick is bounded by the SLOWEST single delivery, not the average: the
// number of drainable queues multiplied by opts.deliver's own timeout, which
// is deliver.ts's DELIVERY_TIMEOUT_MS in production. That is only acceptable
// because that timeout is bounded (see deliver.ts's own comment on why it is
// derived from LEASE_MS); with an unbounded deliver, one hung consumer would
// stall every other queue in this tick and, through startQueueTick awaiting
// the whole tick before scheduling the next, every later tick too. Making
// this loop concurrent instead is a real design change, deliberately not
// made here: it would need per-queue isolation decisions (a slow queue must
// not starve a fast one of tick cadence) this task did not set out to make.
export async function tickOnce(
  queues: DrainableQueue[],
  opts: Omit<QueueTickOptions, 'queues' | 'intervalMs'>
): Promise<void> {
  const now = opts.now ?? Date.now
  const nowMs = now()
  for (const queue of queues) {
    try {
      await tickOneQueue(queue, { wake: opts.wake, deliver: opts.deliver, stateOf: opts.stateOf }, nowMs)
    } catch (err) {
      console.error(`queue tick: tick failed for queue ${queue.resourceId}: ${errorMessage(err)}`)
    }
  }
}

export function startQueueTick(opts: QueueTickOptions): { stop(): Promise<void> } {
  const now = opts.now ?? Date.now
  const sleepFor = opts.sleepFor ?? defaultSleepFor

  let stopped = false
  let resolveStopSignal: () => void = () => {}
  const stopSignal = new Promise<void>((resolve) => {
    resolveStopSignal = resolve
  })

  // Tracks the in-flight tick so stop() can drain rather than returning while
  // a delivery is half done. Set synchronously before the await and cleared
  // synchronously after, so there is never a window where a tick is running
  // but this is null. Identical to mirror.ts's own currentTick.
  let currentTick: Promise<void> | null = null

  // Races the interval against stop(), so shutdown does not wait out a full
  // interval. Returns true when the interval elapsed normally.
  async function waitOrStop(ms: number): Promise<boolean> {
    let sleptFully = true
    await Promise.race([
      sleepFor(ms),
      stopSignal.then(() => {
        sleptFully = false
      }),
    ])
    return sleptFully
  }

  const loop = (async (): Promise<void> => {
    while (!stopped) {
      const sleptFully = await waitOrStop(opts.intervalMs)
      if (!sleptFully || stopped) {
        break
      }
      // Caught inside the tracked promise, not around the await, so stop()'s
      // await of currentTick never rejects either.
      currentTick = tickOnce(opts.queues(), {
        wake: opts.wake,
        deliver: opts.deliver,
        stateOf: opts.stateOf,
        now,
      }).catch((err: unknown) => {
        console.error(`queue tick: tick failed: ${errorMessage(err)}`)
      })
      await currentTick
      currentTick = null
    }
  })()

  loop.catch((err: unknown) => {
    console.error(`queue tick: loop exited unexpectedly: ${errorMessage(err)}`)
  })

  return {
    stop(): Promise<void> {
      if (stopped) {
        return currentTick ?? Promise.resolve()
      }
      stopped = true
      resolveStopSignal()
      return currentTick ?? Promise.resolve()
    },
  }
}
