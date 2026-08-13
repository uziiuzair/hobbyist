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
// Never throws. A network failure, a non-2xx status, or a body that does not
// parse as a QueueResponse all become the same EXCEPTION_RESULT, which
// broker.ts's applyResult already treats as "retry everything": a dead or
// unreachable consumer must produce a retry, not a crashed tick.

import type { DeliveryResult, LeasedBatch } from './broker.js'

const EXCEPTION_RESULT: DeliveryResult = {
  outcome: 'exception',
  retryBatch: { retry: false },
  retryMessages: [],
}

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
export async function deliverBatch(
  controlPort: number,
  batch: LeasedBatch,
  queueName: string
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
