// Reconcile runs once, on every daemon start, before the daemon accepts any
// request. Its whole job is stated in one sentence: observed reality always
// beats recorded state. The store is a set of promises a previous daemon
// process made; if that process died mid-operation, some of those promises
// were never kept, and the only source of truth left is what the runtime
// (Docker) actually reports right now.
//
// The full table, recorded state x observed reality, with the reasoning
// behind every cell:
//
//   observed bucket is one of:
//     missing  runtime.inspect says the container does not exist at all
//     stopped  the container exists but is not running
//     booting  the container is running, but Postgres inside it did not
//              accept a connection when probed (or the probe budget was
//              already spent, see PROBE_BUDGET_MS below)
//     ready    the container is running AND Postgres accepted a connection
//
//   `booting` and `ready` used to be one bucket, `running`, decided by
//   `docker inspect` alone. That was a lie with teeth: a container's port
//   accepts TCP the instant it starts, seconds before the postmaster is
//   done with crash recovery, so a resource was reported `running` while
//   Postgres was still starting up. The proxy skips the wake entirely for a
//   `running` target (packages/proxy/src/proxy.ts's handleStartup), dialed
//   that port, and spliced the client straight into a Postgres that
//   answered with a raw `FATAL: the database system is starting up`, which
//   is precisely the experience wake-on-connect exists to eliminate. So
//   `running` is now only ever written when Postgres itself answered;
//   `booting` maps to `starting`, which every consumer already treats as
//   "not usable yet, wait for it": the proxy wakes it (startPostgres is a
//   no-op `docker start` on an already-running container followed by the
//   real readiness wait) and the hibernator leaves it alone.
//
//   Every row below therefore reads `ready -> running`, and `booting ->
//   starting` regardless of the recorded state, because in both cases
//   observed reality is unambiguous and overrules whatever was written
//   down. The remaining two columns are the interesting ones:
//
//   (the `booting` column is omitted: it is `starting` on every row)
//
//   recorded   | missing | stopped  | ready   | reasoning
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

import { destroyPostgres, pgProbe } from '@hobby.sh/pg'
import type { Resource, ResourceState } from '@hobby.sh/core'
import type { DaemonContext } from './context.js'

export type ObservedBucket = 'missing' | 'stopped' | 'booting' | 'ready'

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

// The table above collapses to four rules because "ready", "booting" and
// "missing" observed reality overrule every recorded state identically, and
// "stopped" only ever differs by whether the recorded state was already
// mid-shutdown (stopping/sleeping) or not. Pure and exported so the whole
// table is testable without a runtime, a probe or a clock.
export function correctedState(recorded: ResourceState, bucket: ObservedBucket): ResourceState {
  if (bucket === 'ready') return 'running'
  if (bucket === 'booting') return 'starting'
  if (bucket === 'missing') return 'failed'
  return recorded === 'sleeping' || recorded === 'stopping' ? 'sleeping' : 'failed'
}

// The total wall-clock budget for readiness probing across every resource,
// not per resource. Reconcile runs before the daemon accepts a single
// request, so it is on the critical path of `hobby daemon` starting at all,
// and a box with a dozen resources whose containers are up but whose
// Postgres is wedged must not turn that into a dozen sequential connection
// timeouts. A healthy Postgres answers a local connection in single-digit
// milliseconds, so this budget is only ever consumed by genuinely unhealthy
// ones; once it is spent, the remaining resources are treated as `booting`
// without probing, which is the conservative direction (they get woken and
// properly waited for on first use, rather than being claimed `running`).
const PROBE_BUDGET_MS = 5000

export interface ReconcileOptions {
  // Test seams. Production omits both and gets Date.now and the constant
  // above. Setting probeBudgetMs to 0 is also the direct way to assert the
  // budget is real: nothing gets probed, so nothing is promoted to running.
  now?: () => number
  probeBudgetMs?: number
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

export async function reconcile(ctx: DaemonContext, opts: ReconcileOptions = {}): Promise<void> {
  const now = opts.now ?? Date.now
  const budgetMs = opts.probeBudgetMs ?? PROBE_BUDGET_MS
  const probeDeadline = now() + budgetMs
  let budgetExhaustedReported = false

  // "The container is up" and "Postgres is accepting connections" are
  // different questions, and only the second one is what `running` claims.
  // pgProbe opens a real connection and resolves false rather than throwing
  // (see packages/pg/src/readiness.ts), with its own connect timeout, so a
  // single call here is already bounded; the budget above bounds the sum of
  // them.
  async function isPostgresReady(resource: Resource): Promise<boolean> {
    if (now() >= probeDeadline) {
      if (!budgetExhaustedReported) {
        budgetExhaustedReported = true
        console.error(
          `reconcile: readiness probe budget of ${budgetMs}ms is spent; remaining resources are recorded as starting rather than running, and will be waited for on first use`
        )
      }
      return false
    }
    const probe = (ctx.probeFactory ?? pgProbe)(resource.config)
    try {
      return await probe()
    } catch (err) {
      // pgProbe never throws, but ctx.probeFactory is a seam and a throw
      // from it must read as "not ready," never abort the whole reconcile.
      console.error(`reconcile: readiness probe for resource ${resource.id} threw: ${errorMessage(err)}`)
      return false
    }
  }

  for (const resource of ctx.store.listResources()) {
    if (resource.state === 'destroying') {
      await resumeDestroy(ctx, resource)
      continue
    }

    // Released projects are skipped whole. Reconcile's job is to make the
    // world match the store, and for a released project the world is
    // deliberately not hobby's any more: the container it would find running
    // is the user's own compose stack on the same data directory, and
    // "correcting" that would stop somebody's database.
    if (ctx.store.getProject(resource.projectId)?.releasedAt != null) {
      continue
    }

    const status = await ctx.runtime.inspect(resource.config.containerName)
    let bucket: ObservedBucket
    if (!status.exists) {
      bucket = 'missing'
    } else if (!status.running) {
      bucket = 'stopped'
    } else {
      bucket = (await isPostgresReady(resource)) ? 'ready' : 'booting'
    }

    const corrected = correctedState(resource.state, bucket)
    if (corrected !== resource.state) {
      ctx.store.setResourceState(resource.id, corrected)
    }

    // A resource that is up and answering right now is active as of right
    // now. The activity tracker is in-memory, so a daemon restart wipes it:
    // without this, every resource that survived the restart had no idle
    // clock, idleSeconds returned null forever, and the hibernator skipped
    // it on every tick. Nothing would ever sleep again until a proxy
    // connection happened to open and close. This is the other half of
    // startPostgres's own touch (packages/pg/src/postgres.ts), for the one
    // path that reaches `running` without going through it.
    if (corrected === 'running') {
      ctx.activity.touch(resource.id)
    }
  }
}
