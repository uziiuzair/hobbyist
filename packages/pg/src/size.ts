// pg_database_size, one connection, one query: the single Postgres touch
// needed to answer "how big is this resource" (see WireResource.sizeBytes,
// packages/cli/src/daemon/wire.ts). Same one-shot-Client shape as query.ts
// and activity-guard.ts's checkActiveQuery: connect, query, always end,
// never a pool.
//
// This file only ever answers the factual question, "what does Postgres
// report right now." It never decides whether asking is a good idea for a
// given resource (a sleeping resource must not be woken just to answer
// this); that policy lives in packages/cli/src/daemon/size.ts, the same
// split activity-guard.ts's own file comment describes for its guard.

import { Client } from 'pg'
import type { PostgresConfig } from '@hobby.sh/core'

const SIZE_CONNECTION_TIMEOUT_MS = 2000

const SIZE_QUERY = 'SELECT pg_database_size(current_database())::bigint AS size'

// null on any failure: unreachable, mid-boot, the query itself erroring.
// There is no failure mode here worth surfacing as an error to a caller
// whose whole point is rendering a dash instead of a number; see
// daemon/size.ts for what a caller does with null.
export async function getDatabaseSize(
  config: PostgresConfig,
  connectionTimeoutMs: number = SIZE_CONNECTION_TIMEOUT_MS
): Promise<number | null> {
  const client = new Client({
    host: '127.0.0.1',
    port: config.hostPort,
    user: config.superuser,
    password: config.password,
    database: config.database,
    connectionTimeoutMillis: connectionTimeoutMs,
  })

  try {
    await client.connect()
  } catch {
    return null
  }

  try {
    const result = await client.query(SIZE_QUERY)
    const raw = (result.rows[0] as { size?: string | number } | undefined)?.size
    if (raw === undefined) {
      return null
    }
    // pg_database_size returns bigint, which node-postgres hands back as a
    // string by default to avoid silent precision loss past
    // Number.MAX_SAFE_INTEGER. A single-box hobby database is nowhere near
    // that boundary (it is petabytes away), so converting to Number here is
    // safe and is what lets the wire shape stay a plain JSON number rather
    // than a string callers would have to parse.
    const size = typeof raw === 'string' ? Number(raw) : raw
    return Number.isFinite(size) ? size : null
  } catch {
    return null
  } finally {
    try {
      await client.end()
    } catch {
      // ignore, same reasoning as pgProbe / checkActiveQuery
    }
  }
}
