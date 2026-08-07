// The proxy is also the activity sensor (see docs/proxy/CLAUDE.md): every
// client connection passes through here, so the number of live connections
// per resource is known for free. ActivityTracker is the piece of state
// that turns "a connection opened or closed" into "how many are open now"
// and "how long has this resource had zero." The daemon owns one instance
// (DaemonContext), threads it through ProxyDeps, and hibernation reads
// idleSeconds off it rather than inventing its own tracking.
//
// It is deliberately not only the proxy's sensor. touch() and reset()
// (core's ActivitySink, which this class implements) are how the rest of
// the daemon reports the same fact from the other directions: a wake from
// `hobby wake` or Studio, a query through the control API, or reconcile
// finding a resource already up after a daemon restart. Before those
// existed, "activity" meant "connections the proxy has seen" and nothing
// else, so a resource woken any other way had no idle clock at all,
// idleSeconds returned null forever, and hibernation read that as "skip":
// it never slept. One tracker, one meaning of activity, for the proxy, the
// API and the hibernator alike.

import type { ActivitySink } from '@hobby.sh/core'

export class ActivityTracker implements ActivitySink {
  private readonly counts = new Map<string, number>()
  // When this resource's current idle stretch began: set when its last
  // connection closes, and by touch() when something else used it. Absent
  // means "no idle clock," which is either a live connection right now or a
  // resource this tracker knows nothing about.
  private readonly idleSince = new Map<string, number>()

  // now is injectable, same pattern as readiness.ts's waitReady, so
  // idleSeconds is testable against a fake clock with zero real waiting:
  // a test can advance `now` without a setTimeout in sight.
  constructor(private readonly now: () => number = Date.now) {}

  open(resourceId: string): void {
    this.counts.set(resourceId, (this.counts.get(resourceId) ?? 0) + 1)
    // A resource with at least one open connection is not idle, whatever
    // its previous close time was. Clearing it here is what makes
    // idleSeconds return null the instant a new connection lands, rather
    // than reporting a stale idle duration for a resource that is active
    // again.
    this.idleSince.delete(resourceId)
  }

  // Guarded so a resource that is already at zero cannot go negative. This
  // is the tracker's own defense, independent of proxy.ts's close-once
  // guard on the connection: the two guards protect different things. The
  // connection's guard flag makes sure THIS connection's close is reported
  // at most once. This one makes sure that even if it somehow were reported
  // twice, the count could not undercount into the negatives and produce a
  // false "idle" reading for a resource that still has a connection open.
  close(resourceId: string): void {
    const count = this.counts.get(resourceId) ?? 0
    if (count <= 0) {
      return
    }
    const next = count - 1
    this.counts.set(resourceId, next)
    if (next === 0) {
      this.idleSince.set(resourceId, this.now())
    }
  }

  // "Something used this resource just now," reported by whoever knows it:
  // startPostgres when a wake completes, the control API's query route,
  // reconcile when it confirms a resource is already up. Starting the idle
  // clock from this instant, rather than clearing it, is what makes "just
  // used" mean exactly what "the last connection just closed" means: the
  // resource is active as of now, and its sleep threshold is measured from
  // here. Registering it in `counts` (at zero, if it is not already there)
  // is what puts it in resources() below, so a caller enumerating the
  // tracker sees it at all.
  touch(resourceId: string): void {
    this.counts.set(resourceId, this.counts.get(resourceId) ?? 0)
    this.idleSince.set(resourceId, this.now())
  }

  // Forget this resource entirely. Called when it stops or is destroyed
  // (see stopPostgres/destroyPostgres): a connection count and an idle
  // clock that describe a container which is no longer running are not
  // merely stale, they are actively harmful. Leaving the old idle timestamp
  // behind is what made a freshly woken resource sleep again on the very
  // next hibernation tick, on an idle time measured against a container
  // that had already been stopped and started since.
  reset(resourceId: string): void {
    this.counts.delete(resourceId)
    this.idleSince.delete(resourceId)
  }

  count(resourceId: string): number {
    return this.counts.get(resourceId) ?? 0
  }

  // null means "not idle, or nothing known": either the count is above zero
  // right now, or this tracker has no idle clock for this resourceId at all
  // (never seen, or reset when it stopped). A caller (hibernation) that
  // gets null has no basis for suspending anything, which is the point:
  // idle time is only ever reported for a resource this tracker has
  // actually watched go quiet.
  idleSeconds(resourceId: string, now: number = this.now()): number | null {
    if (this.count(resourceId) > 0) {
      return null
    }
    const since = this.idleSince.get(resourceId)
    if (since === undefined) {
      return null
    }
    return (now - since) / 1000
  }

  // Every resourceId this tracker currently knows about, whether or not it
  // is idle. Hibernation's poll loop uses this to know what to check,
  // rather than needing its own registry of resources.
  resources(): string[] {
    return [...this.counts.keys()]
  }
}
