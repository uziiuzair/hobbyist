// The queue delivery guard: the second half of the worker kind's pre-sleep
// check, composed with durableObjectAlarmGuard in packages/worker/src/kind.ts.
//
// 'active' while any queue this worker consumes has a message under an
// unexpired lease: that lease is a batch mid-delivery, and stopping the
// container now would abandon it rather than let tick.ts's own expireLeases
// requeue it cleanly on a later tick (see broker.ts's expireLeases comment).
// 'unreachable' when a queue's database cannot be opened, never folded into
// 'idle': packages/core/src/kinds.ts states the rule this exists to honour,
// "a guard that could not answer must never be read as permission to stop."
//
// Synchronous and read-only, unlike durableObjectAlarmGuard: hasOutstandingLease
// is a single indexed sqlite read with no async boundary to cross, and opening
// read-only means asking the question never perturbs a queue nobody is
// otherwise touching, the same reasoning @hobby.sh/do's own read-only opens
// carry for a Durable Object's alarm table.

import { existsSync } from 'node:fs'
import { openDatabaseReadOnly, type ActivityGuardResult, type Paths, type Store } from '@hobby.sh/core'
import { hasOutstandingLease } from './broker.js'
import { queueDbPath } from './kind.js'

export function queueDeliveryGuard(paths: Paths, store: Store, resourceId: string, nowMs: number): ActivityGuardResult {
  const consumed = store
    .listResources()
    .filter((resource) => resource.kind === 'queue' && resource.config.consumerResourceId === resourceId)

  // A worker consuming no queue at all reaches here with an empty list and
  // sleeps exactly as it did before this guard existed, the same shape
  // durableObjectAlarmGuard uses for a worker with no Durable Object classes.
  if (consumed.length === 0) {
    return 'idle'
  }

  let active = false
  for (const queue of consumed) {
    const project = store.getProject(queue.projectId)
    if (project === null) {
      return 'unreachable'
    }

    const dbPath = queueDbPath(paths, project.name, queue.name)
    if (!existsSync(dbPath)) {
      // Never started and never sent to: a queue with no file on disk has
      // nothing leased. Same reasoning @hobby.sh/do's readPendingAlarms
      // carries for a namespace directory with no metadata.sqlite: that is an
      // empty result, not a failure.
      continue
    }

    let db
    try {
      db = openDatabaseReadOnly(dbPath)
    } catch {
      return 'unreachable'
    }
    try {
      if (hasOutstandingLease(db, nowMs)) {
        active = true
      }
    } catch {
      return 'unreachable'
    } finally {
      db.close()
    }
  }

  return active ? 'active' : 'idle'
}
