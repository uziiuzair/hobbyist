// One image build at a time, for the whole daemon.
//
// `docs/compute/CLAUDE.md` asked what stops a build from starving the box
// that is also serving a database. Two concurrent builds on a five dollar
// VPS is the case this exists for, and a per-project lock would not prevent
// it, so the lock is global and process-wide rather than per project or per
// kind. It lives in core, not in the app package, because the worker kind
// builds images too and skipped the lock for as long as the lock was
// something only `@hobby.sh/app` could import (issue #83).
//
// This is also the ONLY mechanism. The `--memory` and `--cpu-shares` flags
// that used to accompany it are accepted and ignored by `docker build` under
// BuildKit (issue #150, measured in docs/compute/CLAUDE.md), so a build is
// not capped; it is merely never concurrent with another build.
//
// Serialised through a promise chain rather than a semaphore because the
// daemon is one process and the queue depth is "however many deploys the
// operator typed", not a number worth managing.

let buildChain: Promise<unknown> = Promise.resolve()
let waiting = 0

export interface BuildLockOptions {
  // Called once, synchronously, if the build has to wait for another build
  // to finish before it can start. The deploy routes use it to say "queued
  // behind another build" rather than going silent (issue #83).
  onWait?: (buildsAhead: number) => void
}

export function withBuildLock<T>(fn: () => Promise<T>, opts: BuildLockOptions = {}): Promise<T> {
  if (waiting > 0) {
    opts.onWait?.(waiting)
  }
  waiting += 1
  const release = (): void => {
    waiting -= 1
  }
  const run = async (): Promise<T> => {
    try {
      return await fn()
    } finally {
      release()
    }
  }
  // Chained off a settled-either-way promise, so one failed build does not
  // wedge every build after it.
  const result = buildChain.then(run, run)
  buildChain = result.catch(() => undefined)
  return result
}

// The line a deploy prepends to its build output when the build had to wait
// (issue #83): the compute spec says a second deploy "queues and says so",
// and the deploy's logs are the one channel that reaches the user. Shared
// by the app and worker kinds so the two never word it differently.
export function buildQueuedNote(buildsAhead: number): string {
  const others = buildsAhead === 1 ? 'another build' : `${buildsAhead} other builds`
  return `hobby: build queued behind ${others}; one image builds at a time on this box\n`
}

// How many builds are running or queued right now. Exposed for tests and
// for anything that wants to say "a build is in progress" without taking
// the lock itself.
export function pendingBuilds(): number {
  return waiting
}
