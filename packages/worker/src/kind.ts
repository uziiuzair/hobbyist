// The `worker` entry in core's resource kind registry.

import type { ResourceKindHandler, WorkerResource } from '@hobby.sh/core'
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

  // No guard today, which core reads as 'idle'. This is the one place a
  // guard will eventually be needed and it is NOT about in-flight requests:
  // a Durable Object alarm due in the next few minutes is a reason not to
  // sleep, because a stopped container has no timer and cannot fire it. That
  // predicate belongs to the durable objects work (docs/durable-objects/),
  // and this is where it plugs in.
}
