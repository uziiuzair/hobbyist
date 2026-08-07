// Readiness detection. A TCP-level port check succeeds long before Postgres
// actually accepts connections (the port is open during initdb, during
// crash recovery, during any of the several seconds the postmaster spends
// starting up), so it would make the readiness signal a lie. The default
// probe here opens a real `pg` connection instead: if `Client#connect()`
// resolves, Postgres is genuinely ready to take queries.

import { Client } from 'pg'
import type { PostgresConfig } from '@hobby.sh/core'

// Short on purpose: this is a poll, called repeatedly by waitReady, not a
// single long-lived connection attempt. A slow, still-booting Postgres just
// means the next poll tries again.
const PROBE_CONNECTION_TIMEOUT_MS = 1000

// client.end() performs a graceful protocol termination, which can itself
// hang on a socket that is open but unresponsive. Unbounded, that turns one
// poll of a wake into an await with no ceiling, and this probe sits on the
// daemon's startup path through reconcile as well as inside every wake. The
// result carries no information the probe needs, so it gets its own deadline
// and the answer is returned regardless. Same reasoning, same numbers as
// checkActiveQuery's GUARD_END_TIMEOUT_MS in activity-guard.ts; the two are
// siblings and this one was left unfixed when that was.
// Precautionary rather than observed: against a port that accepts and then
// stays silent, end() returns immediately today (readiness.test.ts covers
// that case). The bound is here because a wedged socket is the one shape
// where it would not, and because the sibling path already carries it.
const PROBE_END_TIMEOUT_MS = 1000

function deadline(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    // Never let this timer be the reason the process stays alive.
    timer.unref?.()
  })
}

export function pgProbe(config: PostgresConfig): () => Promise<boolean> {
  return async (): Promise<boolean> => {
    const client = new Client({
      host: '127.0.0.1',
      port: config.hostPort,
      user: config.superuser,
      password: config.password,
      database: config.database,
      connectionTimeoutMillis: PROBE_CONNECTION_TIMEOUT_MS,
    })
    try {
      await client.connect()
      return true
    } catch {
      return false
    } finally {
      // client.end() can itself throw if connect() never succeeded (no
      // socket to close); that failure carries no information we need.
      await Promise.race([
        client.end().catch(() => {
          // ignore
        }),
        deadline(PROBE_END_TIMEOUT_MS),
      ])
    }
  }
}

function defaultSleepFor(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export interface WaitReadyResult {
  ready: boolean
  attempts: number
  waitedMs: number
}

// probe, sleepFor and now are all injectable so the poll loop itself is
// testable with a fake clock and zero Postgres, zero Docker, zero real
// waiting. Production callers omit all three and get the real thing: a
// live pg connection attempt, a real setTimeout, and Date.now.
export async function waitReady(opts: {
  config: PostgresConfig
  pollMs: number
  timeoutMs: number
  probe?: () => Promise<boolean>
  sleepFor?: (ms: number) => Promise<void>
  now?: () => number
}): Promise<WaitReadyResult> {
  const probe = opts.probe ?? pgProbe(opts.config)
  const sleepFor = opts.sleepFor ?? defaultSleepFor
  const now = opts.now ?? Date.now

  const start = now()
  let attempts = 0

  for (;;) {
    attempts++
    const ready = await probe()
    const waitedMs = now() - start

    if (ready) {
      return { ready: true, attempts, waitedMs }
    }
    if (waitedMs >= opts.timeoutMs) {
      return { ready: false, attempts, waitedMs }
    }
    await sleepFor(opts.pollMs)
  }
}
