// The `worker` entry in core's resource kind registry.

import type { ActivityGuardResult, ResourceKindHandler, WorkerResource } from '@hobby.sh/core'
import { durableObjectAlarmGuard } from '@hobby.sh/do'
import { queueDeliveryGuard } from '@hobby.sh/queue'
import { destroyWorker, probeWorker, startWorker, stopWorker, type WorkerDeps } from './worker.js'

export const workerKindHandler: ResourceKindHandler<WorkerResource> = {
  kind: 'worker',

  start(deps: WorkerDeps, resource: WorkerResource): Promise<void> {
    return startWorker(deps, resource)
  },

  stop(deps: WorkerDeps, resource: WorkerResource): Promise<void> {
    return stopWorker(deps, resource)
  },

  destroy(deps: WorkerDeps, resource: WorkerResource): Promise<void> {
    return destroyWorker(deps, resource)
  },

  probe(deps: WorkerDeps, resource: WorkerResource): Promise<boolean> {
    return probeWorker(deps, resource)
  },

  // The guard this file reserved a hole for, now filled twice over. It is NOT
  // about in-flight requests: a Durable Object alarm due shortly, or a queue
  // batch mid-delivery, are both reasons not to sleep, because a stopped
  // container has no timer to fire the alarm and no process to finish the
  // batch.
  //
  // Composes two independently owned predicates rather than growing one of
  // them to know about the other's concern:
  //
  //   - durableObjectAlarmGuard (@hobby.sh/do): reading a stopped namespace's
  //     schedule and deciding what it means is that package's whole job, and
  //     the same reading feeds the alarm mirror, which wakes a worker when a
  //     deadline arrives while it is asleep. See
  //     docs/durable-objects/specs/2026-08-10-the-alarm-mirror-and-object-catalog.md.
  //   - queueDeliveryGuard (@hobby.sh/queue): 'active' while any queue this
  //     worker consumes has a message under an unexpired lease, i.e. a batch
  //     mid-delivery. See docs/queues/specs/2026-08-13-queues-design.md,
  //     "The kind, and the guard".
  //
  // 'active' if either says so. 'unreachable' if either could not answer, even
  // if the other says 'active': core's own rule (packages/core/src/kinds.ts)
  // is that a guard which could not fully answer must never be read as
  // permission to stop, and this composed guard did not fully answer whenever
  // either half did not. Only 'idle' when both agree there is nothing here to
  // protect.
  async guard(deps: WorkerDeps, resource: WorkerResource): Promise<ActivityGuardResult> {
    const now = deps.now ?? Date.now
    const alarmResult = await durableObjectAlarmGuard(deps, resource)
    const queueResult = queueDeliveryGuard(deps.paths, deps.store, resource.id, now())

    if (alarmResult === 'unreachable' || queueResult === 'unreachable') {
      return 'unreachable'
    }
    if (alarmResult === 'active' || queueResult === 'active') {
      return 'active'
    }
    return 'idle'
  },
}
