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

// 'active' means at least one real client backend, other than this guard's
// own connection, is doing something other than sitting fully idle: a
// running query, or idle inside an open transaction (which must not be
// interrupted mid-transaction). 'idle' means every other client backend is
// genuinely at rest. 'unreachable' means the connection attempt itself
// failed or the query against it did.
//
// 'unreachable' matters for a reason specific to this codebase: reconcile
// and the control API report a resource `running` from the container
// process alone, never from Postgres readiness (see task-4-report.md's
// parked item, carried forward as a constraint on this task). A `running`
// resource can still be mid-boot the instant hibernation checks it. Reading
// 'unreachable' as "no activity" would let hibernation sleep a database it
// could not even confirm was idle, which is the worst possible reading of
// that signal; callers must treat it the same as 'active'.
export type ActivityGuardResult = 'active' | 'idle' | 'unreachable'

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
    // Connected, but the query itself failed (permissions changed mid-flight,
    // the connection dropped mid-query). The conservative reading is the
    // same as a failed connect: block sleep, do not assume idle.
    return 'unreachable'
  } finally {
    // client.end() can itself throw if connect() never truly settled; that
    // failure carries no information this guard needs. Same reasoning as
    // pgProbe in readiness.ts.
    try {
      await client.end()
    } catch {
      // ignore
    }
  }
}
