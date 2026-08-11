// The one Postgres-touching check hibernation needs, and needs only once,
// immediately before it stops a resource (see docs/hibernation/CLAUDE.md).
// The proxy's ActivityTracker (packages/proxy/src/activity.ts) already knows
// the live connection count for anything that came through the proxy, for
// free; this file exists for the connection that did not, a client dialing
// the container's published host port directly, and for refusing to sleep a
// resource mid-transaction. It is deliberately not a polling loop: the
// hibernator calls this exactly once per resource per sleep attempt, never
// on a schedule.
//
// Lives here, not in packages/cli, because it is a real `pg` Client
// connection against a real Postgres, the same pattern readiness.ts's
// pgProbe already uses. The policy question ("does this mean skip
// sleeping") belongs to the hibernator; this file only answers the factual
// one.

import { Client } from 'pg'
import type { PostgresConfig } from '@hobby.sh/core'

const GUARD_CONNECTION_TIMEOUT_MS = 2000

// Every step of this guard is bounded, not just the connect. A hibernator
// tick awaits this call; hibernator.stop() awaits the in-flight tick; and
// the daemon's SIGTERM path awaits hibernator.stop() before it cleanly
// stops each running Postgres (see packages/cli/src/daemon/server.ts's
// performShutdown). So an unbounded step here is not a slow check, it is a
// daemon that never finishes shutting down, and an unclean shutdown is
// exactly what puts the next wake into crash recovery, inside a user's
// first query. query_timeout is node-postgres's own client-side deadline
// (it rejects the pending query); statement_timeout asks the server to
// cancel its side too, so a wedged backend does not keep running the
// statement after this client has given up on it.
const GUARD_QUERY_TIMEOUT_MS = 2000

// client.end() performs a graceful protocol termination, which can itself
// hang on a socket that is open but unresponsive. It carries no information
// this guard needs, so it gets a deadline of its own and the result is
// returned regardless.
const GUARD_END_TIMEOUT_MS = 1000

function deadline(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    // Never let this timer be the reason the process stays alive: the same
    // reasoning as the hibernator's own defaultSleepFor.
    timer.unref?.()
  })
}

// 'active' means at least one real client backend, other than this guard's
// own connection, is doing something other than sitting fully idle: a
// running query, or idle inside an open transaction (which must not be
// interrupted mid-transaction). 'idle' means every other client backend is
// genuinely at rest. 'unreachable' means the connection attempt itself
// failed or the query against it did.
//
// 'unreachable' still matters even though every path to `running` now
// confirms Postgres itself answered at least once (startPostgres waits for
// real readiness, and reconcile probes rather than trusting `docker
// inspect`, see packages/cli/src/daemon/reconcile.ts). "It answered when it
// was started" is not "it is answering now": a Postgres can crash, be
// restarted outside Hobbyist, or be mid-recovery by the time hibernation
// looks at it. Reading 'unreachable' as "no activity" would let hibernation
// sleep a database it could not even confirm was idle, which is the worst
// possible reading of that signal; callers must treat it the same as
// 'active'.
// Declared in @hobby.sh/core (kinds.ts) since the resource kind registry
// arrived, because a kind handler's optional `guard` returns it and core
// cannot depend on this package. Re-exported here so every existing importer
// keeps working and so the reasoning above stays next to the one
// implementation that produces all three values.
import type { ActivityGuardResult } from '@hobby.sh/core'
export type { ActivityGuardResult }

const ACTIVE_QUERY_SQL = `
  SELECT count(*)::int AS active
  FROM pg_stat_activity
  WHERE backend_type = 'client backend'
    AND pid <> pg_backend_pid()
    AND state IS DISTINCT FROM 'idle'
`

export async function checkActiveQuery(
  config: PostgresConfig,
  timeoutMs: number = GUARD_CONNECTION_TIMEOUT_MS
): Promise<ActivityGuardResult> {
  const client = new Client({
    host: '127.0.0.1',
    port: config.hostPort,
    user: config.superuser,
    password: config.password,
    database: config.database,
    connectionTimeoutMillis: timeoutMs,
    query_timeout: GUARD_QUERY_TIMEOUT_MS,
    statement_timeout: GUARD_QUERY_TIMEOUT_MS,
  })

  try {
    await client.connect()
  } catch {
    return 'unreachable'
  }

  try {
    const result = await client.query(ACTIVE_QUERY_SQL)
    const active = Number((result.rows[0] as { active?: number } | undefined)?.active ?? 0)
    return active > 0 ? 'active' : 'idle'
  } catch {
    // Connected, but the query itself failed (permissions changed
    // mid-flight, the connection dropped mid-query, or it ran past
    // GUARD_QUERY_TIMEOUT_MS). The conservative reading is the same as a
    // failed connect: block sleep, do not assume idle.
    return 'unreachable'
  } finally {
    // client.end() can itself throw if connect() never truly settled; that
    // failure carries no information this guard needs. Same reasoning as
    // pgProbe in readiness.ts, plus the deadline described above.
    await Promise.race([
      client.end().catch(() => {
        // ignore
      }),
      deadline(GUARD_END_TIMEOUT_MS),
    ])
  }
}
