// The proxy is also the activity sensor (see docs/proxy/CLAUDE.md): every
// client connection passes through here, so the number of live connections
// per resource is known for free. ActivityTracker is the piece of state
// that turns "a connection opened or closed" into "how many are open now"
// and "how long has this resource had zero." The daemon owns one instance
// (DaemonContext), threads it through ProxyDeps, and hibernation reads
// idleSeconds off it rather than inventing its own tracking.

export class ActivityTracker {
  private readonly counts = new Map<string, number>()
  private readonly lastCloseAt = new Map<string, number>()

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
    this.lastCloseAt.delete(resourceId)
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
      this.lastCloseAt.set(resourceId, this.now())
    }
  }

  count(resourceId: string): number {
    return this.counts.get(resourceId) ?? 0
  }

  // null means "not idle, or never seen": either the count is above zero
  // right now, or this resourceId has never had a connection close on it.
  // A caller (hibernation) that gets null has no basis for suspending
  // anything, which is the point: idle time is only ever reported for a
  // resource this tracker has actually watched drop to zero.
  idleSeconds(resourceId: string, now: number = this.now()): number | null {
    if (this.count(resourceId) > 0) {
      return null
    }
    const closedAt = this.lastCloseAt.get(resourceId)
    if (closedAt === undefined) {
      return null
    }
    return (now - closedAt) / 1000
  }

  // Every resourceId this tracker has ever opened a connection for, whether
  // or not it is currently idle. Hibernation's poll loop uses this to know
  // what to check, rather than needing its own registry of resources.
  resources(): string[] {
    return [...this.counts.keys()]
  }
}
