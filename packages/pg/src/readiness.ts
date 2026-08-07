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
      try {
        await client.end()
      } catch {
        // ignore
      }
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
