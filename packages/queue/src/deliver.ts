// The HTTP hop from a leased batch to a container's control port, and the
// only place a delivery failure is turned into a retry rather than a crashed
// tick.
//
// The wire shape matches what packages/worker/src/runtime-image.ts's
// CONTROL_SOURCE actually reads (verified against a live container in
// docs/queues/research/2026-08-14-control-channel-verified.md): a top-level
// `queue` name, `messages` carrying `id`, `timestamp` (ms), the codec-encoded
// `body` string verbatim (the daemon never parses it, see codec.ts's own
// header comment) and `attempts`, plus `metadata.metrics`. The response is a
// real Cloudflare QueueResponse: `outcome`, `retryBatch`, `retryMessages`,
// alongside `ackAll` and `explicitAcks`, which workerd adds and which we do
// not read, because broker.ts's applyResult already folds ackAll/retryAll
// into `retryBatch` and the per-message list before we ever see them.
//
// Never throws. A network failure, a non-2xx status, a body that does not
// parse as a QueueResponse, or a request that never gets a response at all
// (see DELIVERY_TIMEOUT_MS below) all become the same EXCEPTION_RESULT, which
// broker.ts's applyResult already treats as "retry everything": a dead,
// unreachable, or hung consumer must produce a retry, not a crashed tick.

import type { DeliveryResult, LeasedBatch } from './broker.js'
import { LEASE_MS } from './broker.js'

const EXCEPTION_RESULT: DeliveryResult = {
  outcome: 'exception',
  retryBatch: { retry: false },
  retryMessages: [],
}

// Bounds how long a single delivery attempt is allowed to hang. Without this,
// a consumer that accepts the connection and never responds (hung user code,
// a deadlocked container, a queue() handler awaiting something that never
// settles) leaves `fetch` pending for undici's own default, minutes, and
// nothing in this project bounds that. Every other container-facing network
// call here already bounds itself for the identical reason: proxy.ts's
// connect timeout, http.ts's upstreamTimeoutMs, worker.ts's socket 'timeout'
// handler.
//
// tick.ts's own loop is sequential, one queue at a time within a tick, and
// startQueueTick awaits a whole tick before starting the next one (see that
// file's own header comment). That means an unbounded delivery for one queue
// does not merely delay its own redelivery, it blocks every OTHER drainable
// queue in the same tick and every SUBSEQUENT tick on the whole box, and a
// per-queue try/catch cannot see a hang, only a throw. Bounding the fetch is
// what turns "one hung consumer stops queue delivery for the entire box"
// into "one hung consumer costs the box one timeout's worth of delay".
//
// Set to half of LEASE_MS, not a round number picked independently, because
// the two constants are in a real relationship: leaseBatch (broker.ts) sets
// lease_expires_at = now + LEASE_MS when a batch is handed to a delivery
// attempt, and expireLeases (also broker.ts) is the ONLY other path that
// clears that lease and makes the same rows visible again. If a delivery
// attempt were still outstanding when its own lease expired, a later
// tick could redeliver the identical batch while the first, still-hung
// attempt might eventually resolve and call applyResult too: two concurrent
// deliveries of the same batch, which at-least-once permits but which
// nothing here should manufacture on its own. Timing this out at LEASE_MS/2
// guarantees the timeout always fires, and applyResult always clears the
// lease through the normal path, with at least half the lease's own duration
// still unexpired, so the lease's natural expiry is never the reason a
// message becomes visible again while a delivery for it might still be
// running.
export const DELIVERY_TIMEOUT_MS = LEASE_MS / 2

interface QueueRequestMessage {
  id: string
  timestamp: number
  body: string
  attempts: number
}

interface QueueRequestBody {
  queue: string
  messages: QueueRequestMessage[]
  metadata: {
    metrics: {
      backlogCount: number
      backlogBytes: number
      oldestMessageTimestamp: number
    }
  }
}

function isRetryMessages(value: unknown): value is DeliveryResult['retryMessages'] {
  if (!Array.isArray(value)) return false
  return value.every((entry) => {
    if (typeof entry !== 'object' || entry === null) return false
    const record = entry as Record<string, unknown>
    if (typeof record['msgId'] !== 'string') return false
    return record['delaySeconds'] === undefined || typeof record['delaySeconds'] === 'number'
  })
}

// Structural validation only: this is a boundary where a container's control
// server, running someone else's user code inside CONTROL_SOURCE's fetch
// handler, hands us back JSON we did not generate. Anything short of the
// exact shape applyResult() expects is treated the same as the container
// having answered nothing at all.
function parseDeliveryResult(value: unknown): DeliveryResult | null {
  if (typeof value !== 'object' || value === null) return null
  const record = value as Record<string, unknown>

  const outcome = record['outcome']
  if (outcome !== 'ok' && outcome !== 'exception') return null

  const retryBatch = record['retryBatch']
  if (typeof retryBatch !== 'object' || retryBatch === null) return null
  const retryBatchRecord = retryBatch as Record<string, unknown>
  if (typeof retryBatchRecord['retry'] !== 'boolean') return null
  if (retryBatchRecord['delaySeconds'] !== undefined && typeof retryBatchRecord['delaySeconds'] !== 'number') {
    return null
  }

  const retryMessages = record['retryMessages']
  if (!isRetryMessages(retryMessages)) return null

  return {
    outcome,
    retryBatch: {
      retry: retryBatchRecord['retry'],
      ...(typeof retryBatchRecord['delaySeconds'] === 'number'
        ? { delaySeconds: retryBatchRecord['delaySeconds'] }
        : {}),
    },
    retryMessages,
  }
}

// POST http://127.0.0.1:<controlPort>/queue with the leased batch, and parse
// the response. queueName is the wrangler-declared name the consumer's own
// queue() handler dispatches on (payload.queue on the wire), which is why
// tick.ts's DrainableQueue carries it separately from the resource id: a
// resource id is never something user code inside the container should see.
//
// timeoutMs defaults to DELIVERY_TIMEOUT_MS and is an injectable seam only
// for tests that need to prove the timeout path itself without waiting out
// the real, LEASE_MS-derived value: the same pattern broker.ts's leaseBatch
// uses for its own leaseMs parameter, defaulting to LEASE_MS. Production
// never passes it.
export async function deliverBatch(
  controlPort: number,
  batch: LeasedBatch,
  queueName: string,
  timeoutMs: number = DELIVERY_TIMEOUT_MS
): Promise<DeliveryResult> {
  const body: QueueRequestBody = {
    queue: queueName,
    messages: batch.messages.map((message) => ({
      id: message.id,
      timestamp: message.timestampMs,
      body: message.body,
      attempts: message.attempts,
    })),
    metadata: {
      metrics: {
        backlogCount: batch.backlogCount,
        backlogBytes: batch.backlogBytes,
        oldestMessageTimestamp: batch.oldestMessageTimestampMs ?? 0,
      },
    },
  }

  let res: Response
  try {
    res = await fetch(`http://127.0.0.1:${controlPort}/queue`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      // AbortSignal.timeout rejects the fetch with a TimeoutError once
      // timeoutMs elapses with no response, whether the connection was never
      // accepted or was accepted and then never answered. Either way it
      // lands in the catch below exactly like a connection refusal does: a
      // hung consumer must produce a retry, not a promise this function
      // leaves pending forever.
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch {
    // Connection refused, timed out, or the container is simply not there.
    return EXCEPTION_RESULT
  }

  if (!res.ok) {
    return EXCEPTION_RESULT
  }

  let parsedBody: unknown
  try {
    parsedBody = await res.json()
  } catch {
    return EXCEPTION_RESULT
  }

  const result = parseDeliveryResult(parsedBody)
  return result ?? EXCEPTION_RESULT
}
