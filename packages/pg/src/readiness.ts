// Readiness detection. A TCP-level port check succeeds long before Postgres
// actually accepts connections (the port is open during initdb, during
// crash recovery, during any of the several seconds the postmaster spends
// starting up), so it would make the readiness signal a lie. The default
// probe here opens a real `pg` connection instead: if `Client#connect()`
// resolves, Postgres is genuinely ready to take queries.

import { Client, DatabaseError } from 'pg'
import type { PostgresConfig } from '@hobby.sh/core'

// What one probe learned. `true` and `false` are the two answers this probe
// always gave: Postgres accepted a session, or nothing usable answered yet
// (refused, reset, timed out, or a server saying it is still starting). The
// third shape is the one a boolean could not carry: a server answered, with
// an ErrorResponse, and the error is not one a boot in progress produces. A
// wrong password, a pg_hba.conf with no entry for this host, a database that
// does not exist. Polling a server that says that for the rest of
// wakeTimeoutMs (30 seconds by default) cannot change its answer, it only
// holds every waiting client that long before telling them the same thing,
// so waitReady concludes on it at once. `broken` carries the server's own words so the
// resulting error names the actual failure rather than "did not become
// ready". A plain `() => Promise<boolean>` is still a valid probe (boolean is
// a member of this union), which is what keeps every existing probeFactory
// fake working unchanged.
export type ProbeOutcome = boolean | { broken: string }

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

// SQLSTATE classes a server answers with while it is momentarily unable to
// take a session, as opposed to unable to take this one ever. Class 57 is
// operator intervention: 57P03 cannot_connect_now is exactly "the database
// system is starting up" (also "is in recovery mode" and "is shutting down"),
// and 57P01/57P02 are a server going down underneath the probe, which a
// restart or the next poll resolves rather than a fault in this resource's
// configuration. Class 53 is insufficient resources (53300
// too_many_connections the obvious one), which clears on its own as sessions
// end. Treating any of these as broken would fail a wake that was about to
// succeed, which is the worse of the two mistakes: a cold database misread
// as broken fails its wake, and the daemon then refuses to wake it again
// until someone runs `hobby wake`, while a broken one misread as cold only
// costs the timeout it always cost before.
const TRANSIENT_SQLSTATE_CLASSES = new Set(['57', '53'])

// The line between "nothing answered" and "a server answered badly".
// DatabaseError is what the pg driver builds from a real ErrorResponse on the
// wire and nothing else: a refused dial, a reset socket and the driver's own
// connection timeout all arrive as plain Errors. Exported for its unit test.
export function classifyProbeError(err: unknown): ProbeOutcome {
  if (!(err instanceof DatabaseError)) {
    return false
  }
  const code = typeof err.code === 'string' ? err.code : ''
  if (TRANSIENT_SQLSTATE_CLASSES.has(code.slice(0, 2))) {
    return false
  }
  return { broken: code === '' ? err.message : `${err.message} (SQLSTATE ${code})` }
}

export function pgProbe(config: PostgresConfig): () => Promise<ProbeOutcome> {
  return async (): Promise<ProbeOutcome> => {
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
    } catch (err) {
      return classifyProbeError(err)
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
  // Set only when the wait ended early because a probe reported the server
  // broken (see ProbeOutcome). Absent on success and on a plain timeout, so
  // a caller can tell "gave up waiting" from "was told no".
  broken?: string
}

// probe, sleepFor and now are all injectable so the poll loop itself is
// testable with a fake clock and zero Postgres, zero Docker, zero real
// waiting. Production callers omit all three and get the real thing: a
// live pg connection attempt, a real setTimeout, and Date.now.
export async function waitReady(opts: {
  config: PostgresConfig
  pollMs: number
  timeoutMs: number
  probe?: () => Promise<ProbeOutcome>
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
    const outcome = await probe()
    const waitedMs = now() - start

    if (outcome === true) {
      return { ready: true, attempts, waitedMs }
    }
    // Before the timeout check, not after it: a broken answer on the last
    // poll is still more useful to the caller than "timed out".
    if (outcome !== false) {
      return { ready: false, attempts, waitedMs, broken: outcome.broken }
    }
    if (waitedMs >= opts.timeoutMs) {
      return { ready: false, attempts, waitedMs }
    }
    await sleepFor(opts.pollMs)
  }
}
