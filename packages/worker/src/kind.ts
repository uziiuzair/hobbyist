// The `worker` entry in core's resource kind registry.

import type { ActivityGuardResult, ResourceKindHandler, WorkerResource } from '@hobby.sh/core'
import { durableObjectAlarmGuard } from '@hobby.sh/do'
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

  // The guard this file reserved a hole for, now filled. It is NOT about
  // in-flight requests: a Durable Object alarm due shortly is a reason not to
  // sleep, because a stopped container has no timer and cannot fire it.
  //
  // The predicate lives in @hobby.sh/do because reading a stopped namespace's
  // schedule and deciding what it means is that package's whole job, and
  // because the same reading feeds the alarm mirror, which wakes a worker when
  // a deadline arrives while it is asleep. One reader, two callers. See
  // docs/durable-objects/specs/2026-08-10-the-alarm-mirror-and-object-catalog.md.
  guard(deps: WorkerDeps, resource: WorkerResource): Promise<ActivityGuardResult> {
    return durableObjectAlarmGuard(deps, resource)
  },
}
