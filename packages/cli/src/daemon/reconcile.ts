// Reconcile runs once, on every daemon start, before the daemon accepts any
// request. Its whole job is stated in one sentence: observed reality always
// beats recorded state. The store is a set of promises a previous daemon
// process made; if that process died mid-operation, some of those promises
// were never kept, and the only source of truth left is what the runtime
// (Docker) actually reports right now.
//
// The full table, recorded state x observed container reality, with the
// reasoning behind every cell:
//
//   observed bucket is one of:
//     missing  runtime.inspect says the container does not exist at all
//     stopped  the container exists but is not running
//     running  the container exists and is running
//
//   recorded   | missing | stopped  | running | reasoning
//   -----------|---------|----------|---------|----------------------------
//   creating   | failed  | failed   | running | `stopped` here is genuinely
//              |         |          |         | ambiguous: the process may
//              |         |          |         | have died before Postgres
//              |         |          |         | ever became ready (the
//              |         |          |         | readiness gate inside
//              |         |          |         | createPostgres never
//              |         |          |         | passed), or after. There is
//              |         |          |         | no way to tell from
//              |         |          |         | ContainerStatus alone, and
//              |         |          |         | claiming `sleeping` without
//              |         |          |         | being sure is claiming "you
//              |         |          |         | can wake this cheaply" for
//              |         |          |         | a resource that was never
//              |         |          |         | proven to boot. `failed`
//              |         |          |         | surfaces that honestly.
//   running    | failed  | failed   | running | Brief's own example: absent
//              |         |          |         | means failed, not sleeping,
//              |         |          |         | because a user reading
//              |         |          |         | `sleeping` expects a cheap
//              |         |          |         | wake, and there is nothing
//              |         |          |         | left to wake. `stopped`
//              |         |          |         | (container present but not
//              |         |          |         | running while we thought it
//              |         |          |         | was) means Postgres exited,
//              |         |          |         | crashed or was stopped
//              |         |          |         | outside Hobbyist, without
//              |         |          |         | going through stopPostgres's
//              |         |          |         | own clean-stop path, so it
//              |         |          |         | does not get to claim the
//              |         |          |         | clean-stop guarantee that
//              |         |          |         | `sleeping` carries either.
//   starting   | failed  | failed   | running | Mirrors startPostgres's own
//              |         |          |         | two outcomes (running on
//              |         |          |         | success, failed on any
//              |         |          |         | throw or timeout, see
//              |         |          |         | packages/pg/src/postgres.ts).
//              |         |          |         | A `starting` that outlived
//              |         |          |         | its daemon never reached
//              |         |          |         | either outcome on its own,
//              |         |          |         | so reconcile picks the one
//              |         |          |         | that matches what is true
//              |         |          |         | now.
//   sleeping   | failed  | sleeping | running | `stopped` is exactly what
//              |         | (no-op)  |         | `sleeping` already asserts:
//              |         |          |         | no correction needed.
//              |         |          |         | `missing` means the
//              |         |          |         | container was removed
//              |         |          |         | outside Hobbyist (a manual
//              |         |          |         | `docker rm`); startPostgres
//              |         |          |         | only ever calls
//              |         |          |         | runtime.start on an
//              |         |          |         | existing container, so this
//              |         |          |         | resource cannot actually be
//              |         |          |         | woken until someone
//              |         |          |         | notices, hence `failed`.
//   stopping   | failed  | sleeping | running | Unlike `creating`, this one
//              |         |          |         | is not ambiguous:
//              |         |          |         | stopPostgres only reaches
//              |         |          |         | its own `sleeping` write
//              |         |          |         | after runtime.stop already
//              |         |          |         | resolved without throwing,
//              |         |          |         | and observing `stopped`
//              |         |          |         | directly confirms that
//              |         |          |         | postcondition already held.
//              |         |          |         | The daemon just died before
//              |         |          |         | it could write it down.
//   failed     | failed  | failed   | running | Already failed and still
//              | (no-op) | (no-op)  |         | is, unless it is now
//              |         |          |         | observed running (someone
//              |         |          |         | fixed it by hand, or it
//              |         |          |         | came back), in which case
//              |         |          |         | reality wins as everywhere
//              |         |          |         | else.
//
// `destroying` is not in the table above because it is not a relabeling
// problem at all. See the comment on the function below.

import { destroyPostgres } from '@hobby.sh/pg'
import type { Resource, ResourceState } from '@hobby.sh/core'
import type { DaemonContext } from './context.js'

type ObservedBucket = 'missing' | 'stopped' | 'running'

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

// The table above collapses to three rules because "running" and "missing"
// observed reality overrule every recorded state identically, and "stopped"
// only ever differs by whether the recorded state was already mid-shutdown
// (stopping/sleeping) or not.
function correctedState(recorded: ResourceState, bucket: ObservedBucket): ResourceState {
  if (bucket === 'running') return 'running'
  if (bucket === 'missing') return 'failed'
  return recorded === 'sleeping' || recorded === 'stopping' ? 'sleeping' : 'failed'
}

// A resource recorded `destroying` means a previous daemon called (or was
// about to call) destroyPostgres and died before it finished. destroyPostgres
// deletes the resource row as its very last step (see
// packages/pg/src/postgres.ts), so if the row is still here, destruction did
// not complete. There is no ambiguity to resolve and no state to relabel: the
// user already asked for this resource to be gone, and destroyPostgres is
// built to be resumed from any partial point (stop and remove are no-ops on
// an already-gone container, the data directory removal is force:true). So
// reconcile does not guess a label, it finishes the job. If that still fails
// (a genuinely stuck disk, Docker unreachable), the row is deleted anyway
// because destroyPostgres guarantees that, and the failure is only logged:
// one stuck resource must not stop the daemon from starting.
async function resumeDestroy(ctx: DaemonContext, resource: Resource): Promise<void> {
  try {
    await destroyPostgres(ctx, resource)
  } catch (err) {
    console.error(
      `reconcile: resuming destroy of resource ${resource.id} (${resource.name}) did not finish cleanly: ${errorMessage(err)}`
    )
  }
}

export async function reconcile(ctx: DaemonContext): Promise<void> {
  for (const resource of ctx.store.listResources()) {
    if (resource.state === 'destroying') {
      await resumeDestroy(ctx, resource)
      continue
    }

    const status = await ctx.runtime.inspect(resource.config.containerName)
    const bucket: ObservedBucket = !status.exists ? 'missing' : status.running ? 'running' : 'stopped'
    const corrected = correctedState(resource.state, bucket)
    if (corrected !== resource.state) {
      ctx.store.setResourceState(resource.id, corrected)
    }
  }
}
