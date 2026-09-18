// The "sleep until the next tick, unless stop() arrives first" primitive that
// the daemon's three background loops share: the hibernator
// (packages/cli/src/daemon/hibernator.ts), the alarm mirror
// (packages/do/src/mirror.ts) and the queue tick (packages/queue/src/tick.ts).
//
// Why it is not simply Promise.race([sleep, stopSignal.then(...)]) against
// one long-lived stop promise, which is what all three loops used to do:
// every .then() on a promise that is still pending adds a reaction to it, and
// a pending promise keeps every reaction it has ever been given. The stop
// promise stays pending for the whole life of the daemon, so each wait left
// its reaction, the derived promise and the closure behind for good.
// Measured under bun by driving the real startQueueTick for 300,000 ticks:
// two promises, a function and its scope kept per tick, 43MB of heap in
// total, against a flat heap with this file. The queue tick waits every
// 250ms, which is about 9.7 million waits in four weeks. A daemon on a real
// box after 28 days of uptime was holding 2.6GB of anonymous memory, with no
// queues configured at all, because the tick loop runs regardless.
//
// So each wait gets its own short-lived promise, registered in a set that
// stop() resolves, and it removes itself from that set when it settles,
// whichever way it settled. Nothing outlives the wait that created it.

export interface StopSignal {
  // True once stop() has been called. Never goes back to false.
  readonly stopped: boolean
  // Resolves true when `sleep` settles first, false when stop() arrives
  // first, and false at once if stop() was already called. The caller builds
  // `sleep` (a real timer in production, an injected one in tests), so this
  // file has no clock of its own.
  wait(sleep: Promise<void>): Promise<boolean>
  // Interrupts every wait in flight and every one started later. Idempotent.
  stop(): void
  // Waits currently in flight. Nothing in the daemon reads it; it is how a
  // test proves a finished wait left nothing behind, which is the whole
  // property this file exists for.
  readonly pending: number
}

export function createStopSignal(): StopSignal {
  let stopped = false
  const waiters = new Set<() => void>()

  return {
    get stopped(): boolean {
      return stopped
    },

    get pending(): number {
      return waiters.size
    },

    async wait(sleep: Promise<void>): Promise<boolean> {
      if (stopped) {
        return false
      }
      let wake: () => void = () => {}
      const interrupted = new Promise<boolean>((resolve) => {
        wake = () => resolve(false)
      })
      waiters.add(wake)
      try {
        return await Promise.race([sleep.then(() => true), interrupted])
      } finally {
        // The line that matters. Without it the set grows by one entry per
        // wait, which is the same leak moved from the promise into a Set.
        waiters.delete(wake)
      }
    },

    stop(): void {
      if (stopped) {
        return
      }
      stopped = true
      for (const wake of waiters) {
        wake()
      }
      waiters.clear()
    },
  }
}
