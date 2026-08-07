// The one Postgres touch Studio's Tables/Sql/Schema views all rest on (see
// packages/studio/src/api.ts's runQuery and the task report): run exactly
// one parameterized query against a resource's own Postgres and hand back
// its rows, columns, row count and command tag, or a structured error if
// Postgres itself rejected the query.
//
// One Client per call, connect, query, end, same shape as readiness.ts's
// pgProbe and activity-guard.ts's checkActiveQuery: never a pool. A pool
// held against a resource that can sleep at any moment (see root CLAUDE.md)
// would either pin it permanently awake or silently hold dead connections
// against a container that stopped underneath it; a fresh, short-lived
// connection per query is the only shape that is honest about that.
//
// Parameters are always passed through to the driver's own parameterized
// query path (`client.query({ text, values })`), never interpolated into
// the SQL string by this file. Whether the SQL itself is safe is the
// caller's problem (Studio's own views build every statement they send),
// not this function's; what this function guarantees is that whatever
// `params` the caller supplies never becomes part of the SQL text.

import { Client } from 'pg'
import { HobbyError, type PostgresConfig } from '@hobby.sh/core'

const QUERY_CONNECTION_TIMEOUT_MS = 5000

export interface QueryColumn {
  name: string
  dataType: string
}

export interface QueryResultShape {
  columns: QueryColumn[]
  rows: Array<Record<string, unknown>>
  rowCount: number
  command: string
}

// Only the handful of built-in type OIDs a database inspector actually
// needs a human label for (see packages/studio/src/views/Sql.tsx's column
// header, and schema.ts's own column rendering). Not an exhaustive OID
// table: an OID this map does not recognize renders as its own numeric
// string, which is an honest "unlabeled" rather than a guess, and never
// blocks the query result itself.
const OID_NAMES: Record<number, string> = {
  16: 'boolean',
  20: 'bigint',
  21: 'smallint',
  23: 'integer',
  25: 'text',
  114: 'json',
  700: 'real',
  701: 'double precision',
  1042: 'char',
  1043: 'varchar',
  1082: 'date',
  1083: 'time',
  1114: 'timestamp',
  1184: 'timestamptz',
  1700: 'numeric',
  2950: 'uuid',
  3802: 'jsonb',
}

function dataTypeName(oid: number): string {
  return OID_NAMES[oid] ?? `oid:${oid}`
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

// The `pg` driver's own error shape for a failed query: a real Error with
// two extra fields node-postgres always sets from Postgres's own
// ErrorResponse, `code` being the five-character SQLSTATE. Duck-typed
// rather than imported from a `pg` type, since the package does not export
// one specifically for this.
interface PgDriverError {
  message: string
  code?: string
  hint?: string
}

function isPgDriverError(err: unknown): err is PgDriverError {
  return err instanceof Error && 'code' in err
}

// A SQL error from Postgres is a normal outcome of running a query, not a
// server fault (the task brief's own framing): it is reported through the
// exact same { error: { code, message, hint } } envelope every other
// HobbyError already renders through (see packages/cli/src/daemon/routes.ts's
// toHobbyError / HobbyError.toWire in packages/core/src/errors.ts), never a
// bare 500. The SQLSTATE has nowhere else to go in that fixed envelope
// (HobbyError.code is this project's own closed ErrorCode union, not a
// pass-through for Postgres's own error codes), so it travels in `hint`,
// prefixed plainly, alongside whatever hint Postgres itself supplied.
function toQueryError(err: unknown): HobbyError {
  if (isPgDriverError(err)) {
    const sqlstate = err.code ?? 'unknown'
    const hint = err.hint === undefined ? `SQLSTATE ${sqlstate}` : `SQLSTATE ${sqlstate}: ${err.hint}`
    return new HobbyError('usage', err.message, hint)
  }
  return new HobbyError('usage', errorMessage(err))
}

export async function runQuery(
  config: PostgresConfig,
  sql: string,
  params: unknown[],
  connectionTimeoutMs: number = QUERY_CONNECTION_TIMEOUT_MS
): Promise<QueryResultShape> {
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
  } catch (err) {
    // A connection failure here is not a bad query, it is this resource not
    // actually being reachable yet (or any more): 'not_ready' rather than
    // 'usage', so a caller can tell "your SQL was wrong" apart from "the
    // database was not there to ask."
    throw new HobbyError(
      'not_ready',
      `could not connect to run the query: ${errorMessage(err)}`,
      'the resource may still be starting; try again in a moment'
    )
  }

  try {
    const result = await client.query({ text: sql, values: params })
    const columns: QueryColumn[] = (result.fields ?? []).map((field) => ({
      name: field.name,
      dataType: dataTypeName(field.dataTypeID),
    }))
    return {
      columns,
      rows: result.rows as Array<Record<string, unknown>>,
      rowCount: result.rowCount ?? result.rows.length,
      command: result.command,
    }
  } catch (err) {
    throw toQueryError(err)
  } finally {
    // client.end() can itself throw if connect() never truly settled; that
    // failure carries no information this function needs. Same reasoning
    // as pgProbe / checkActiveQuery.
    try {
      await client.end()
    } catch {
      // ignore
    }
  }
}
