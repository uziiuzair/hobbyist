// Which queues the queue tick should drain, and how to reach each one's
// consumer. The join between the store and @hobby.sh/queue's tick.ts,
// mirroring alarms.ts's own durableObjectNamespaces: that file joins the
// store to @hobby.sh/do's mirror, this one joins it to @hobby.sh/queue's.
//
// @hobby.sh/queue knows nothing about the store, Docker, or HTTP (see that
// package's own tick.ts header comment); this file is the one place that
// knowledge is allowed to leak in, for the same reason ProxyDeps and
// durableObjectNamespaces already live here rather than in the packages they
// serve.

import {
  queueDbPath,
  deliverBatch,
  type ConsumerOptions,
  type DeliveryResult,
  type DrainableQueue,
  type LeasedBatch,
} from '@hobby.sh/queue'
import type { ResourceState, WorkerConfig } from '@hobby.sh/core'
import type { DaemonContext } from './context.js'

// The exception result deliver() falls back to when the consumer resource
// itself cannot be resolved to a live worker at delivery time, rather than
// at the join step above: a race between drainableQueues() building its
// snapshot and the tick actually reaching delivery (the consumer destroyed
// mid-tick, e.g.) is rare but not impossible, and deliverBatch's own
// contract (packages/queue/src/deliver.ts) is "never throw, always return a
// DeliveryResult", which broker.ts's applyResult already knows how to turn
// into a full-batch retry. Kept in sync with deliver.ts's own
// EXCEPTION_RESULT by construction rather than by import, since importing a
// private constant across the package boundary is not worth it for four
// literal fields.
const UNREACHABLE_CONSUMER_RESULT: DeliveryResult = {
  outcome: 'exception',
  retryBatch: { retry: false },
  retryMessages: [],
}

// Whether a worker's own config records "no code has ever been deployed to
// it", by either signal this branch might carry.
//
// `WorkerConfig.manifest` is `WorkerManifest | null` on the branch this task
// merges with, null before the first deploy (per this task's own brief). On
// THIS branch the field does not exist at all yet:
// packages/core/src/types.ts's WorkerConfig has no `manifest` key today, only
// `source: { path, manifest: string }`, which names the FILE the manifest was
// read from and is unrelated. So this checks structurally, through an index
// signature, rather than through the type, which cannot yet name a field that
// does not exist: `'manifest' in config && config.manifest === null` skips.
//
// The second signal is real today and does not depend on that field existing
// at all: a worker whose `queues.consumers` array is empty declares no
// consumer binding, which is what a worker created before any
// `[[queues.consumers]]` block was ever deployed to it looks like on this
// branch. Either signal alone is enough to skip.
//
// MERGE NOTE: `record-before-code` moved `queues` off `WorkerConfig` directly
// and onto `WorkerConfig.manifest.queues` on `main`. `config.queues.consumers`
// below will fail to COMPILE once this branch rebases onto that (the safe
// failure, not a silent misbehavior), and needs rewriting to
// `config.manifest?.queues.consumers` at that point, read together with
// signal (a) above rather than as a second independent check: a null
// `manifest` already covers "no consumers", so this becomes `config.manifest
// === null || config.manifest.queues.consumers.length === 0`, or equivalent.
function hasNoDeployedCode(config: WorkerConfig): boolean {
  const record = config as unknown as Record<string, unknown>
  if ('manifest' in record && record['manifest'] === null) {
    return true
  }
  return config.queues.consumers.length === 0
}

// Every queue this daemon is responsible for draining right now. Four
// exclusions, each of which would otherwise be a wake or a delivery attempt
// this queue was never meant to make:
//
//   - Not a `queue`. Every other kind is none of the tick's business.
//   - No consumer configured. `hobby queue send` still accepts messages for a
//     queue nobody is bound to; they simply accumulate until retention
//     expires, exactly the way a Cloudflare queue with no consumer behaves.
//     There is nothing to wake and nothing to deliver to.
//   - The consumer resource is missing, is not a worker, or has no deployed
//     code (hasNoDeployedCode above). Waking a worker with no code starts a
//     container that immediately exits, which the daemon records as a crash
//     loop rather than "you have not deployed yet", so this excludes it
//     rather than letting the tick find out the hard way. It must keep
//     ACCEPTING sends and never deliver, exactly like the "no consumer" case
//     above, which is why this exclusion sits beside it rather than turning
//     into a refusal anywhere on the send path.
//   - A released project. `hobby eject --release` handed the data directory to
//     the user's own compose stack; hobby stops acting on it. Waking a
//     released worker would start a container hobby no longer owns. The alarm
//     mirror's own durableObjectNamespaces applies the identical rule for the
//     identical reason.
export function drainableQueues(ctx: DaemonContext): DrainableQueue[] {
  const queues: DrainableQueue[] = []

  for (const resource of ctx.store.listResources()) {
    if (resource.kind !== 'queue') {
      continue
    }
    if (resource.config.consumerResourceId === null) {
      continue
    }

    const consumer = ctx.store.getResource(resource.config.consumerResourceId)
    if (consumer === null || consumer.kind !== 'worker') {
      continue
    }
    if (hasNoDeployedCode(consumer.config)) {
      continue
    }

    const project = ctx.store.getProject(resource.projectId)
    if (project === null || project.releasedAt != null) {
      continue
    }

    const options: ConsumerOptions = {
      maxBatchSize: resource.config.maxBatchSize,
      maxBatchTimeoutSeconds: resource.config.maxBatchTimeoutSeconds,
      maxRetries: resource.config.maxRetries,
      retryDelaySeconds: resource.config.retryDelaySeconds,
      deadLetterQueue: resource.config.deadLetterQueue,
    }

    queues.push({
      resourceId: resource.id,
      consumerResourceId: consumer.id,
      queueName: resource.name,
      dbPath: queueDbPath(ctx.paths, project.name, resource.name),
      deadLetterDbPath:
        resource.config.deadLetterQueue === null
          ? null
          : queueDbPath(ctx.paths, project.name, resource.config.deadLetterQueue),
      options,
      retentionSeconds: resource.config.retentionSeconds,
    })
  }

  return queues
}

// The tick's stateOf: a plain store read, never a probe. The tick only ever
// asks this to decide between "already running, deliver now", "sleeping,
// wake it" and "starting, wait", and the store's own state column is what
// every other wake-adjacent decision in the daemon already trusts for that
// (getOrCreateWake, the hibernator, both proxies).
//
// A resourceId this cannot resolve at all (the consumer was destroyed between
// drainableQueues() building its snapshot and the tick reaching this queue)
// reads as 'failed' rather than 'sleeping': 'sleeping' would make the tick
// call wake() on a resource id the store no longer has any row for, which
// wake() itself turns into a thrown HobbyError; 'failed' is one of the states
// tick.ts already treats as "wait for the next tick", so a queue whose
// consumer vanished mid-tick is simply left alone rather than logged as a
// wake failure for a resource that was never going to answer.
export function queueStateOf(ctx: DaemonContext): (resourceId: string) => ResourceState {
  return (resourceId: string): ResourceState => {
    const resource = ctx.store.getResource(resourceId)
    return resource === null ? 'failed' : resource.state
  }
}

// The tick's deliver: resolves a consumer resource id to its live control
// port and posts the batch. Kept a live lookup, not something baked into
// DrainableQueue at snapshot time in drainableQueues() above, because a
// worker's controlPort is allocated once at creation and never changes, but
// resolving it here rather than there keeps the store lookup pattern
// identical to createProxyDeps and createHttpProxyDeps: this file reads the
// store fresh at the moment it actually needs an answer, never caches one.
export function queueDeliverFn(
  ctx: DaemonContext
): (consumerResourceId: string, batch: LeasedBatch, queueName: string) => Promise<DeliveryResult> {
  return async (consumerResourceId: string, batch: LeasedBatch, queueName: string): Promise<DeliveryResult> => {
    const resource = ctx.store.getResource(consumerResourceId)
    if (resource === null || resource.kind !== 'worker') {
      return UNREACHABLE_CONSUMER_RESULT
    }
    return deliverBatch(resource.config.controlPort, batch, queueName)
  }
}
