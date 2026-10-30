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

// The built-in type OIDs node-postgres itself knows (pg-types' builtins
// table, the same set the driver's own parsers are keyed on), labelled with
// Postgres's own type names as `format_type` prints them: `name`, `bytea`
// and `void` were the three a real query surfaced as `oid:N` in Studio's
// column headers (issue #116). Not an exhaustive OID table, and not a
// catalog lookup: a user-defined type, an enum or an array type renders as
// `oid:N`, which is an honest "unlabeled" rather than a guess, and never
// blocks the query result itself. The common array types are included
// because `select array_agg(...)` is an ordinary thing to type.
const OID_NAMES: Record<number, string> = {
  16: 'boolean',
  17: 'bytea',
  18: '"char"',
  19: 'name',
  20: 'bigint',
  21: 'smallint',
  23: 'integer',
  24: 'regproc',
  25: 'text',
  26: 'oid',
  27: 'tid',
  28: 'xid',
  29: 'cid',
  114: 'json',
  142: 'xml',
  194: 'pg_node_tree',
  602: 'path',
  604: 'polygon',
  650: 'cidr',
  700: 'real',
  701: 'double precision',
  718: 'circle',
  774: 'macaddr8',
  790: 'money',
  829: 'macaddr',
  869: 'inet',
  1033: 'aclitem',
  1042: 'char',
  1043: 'varchar',
  1082: 'date',
  1083: 'time',
  1114: 'timestamp',
  1184: 'timestamptz',
  1186: 'interval',
  1266: 'timetz',
  1560: 'bit',
  1562: 'varbit',
  1700: 'numeric',
  1790: 'refcursor',
  2202: 'regprocedure',
  2203: 'regoper',
  2204: 'regoperator',
  2205: 'regclass',
  2206: 'regtype',
  2278: 'void',
  2950: 'uuid',
  2970: 'txid_snapshot',
  3220: 'pg_lsn',
  3361: 'pg_ndistinct',
  3402: 'pg_dependencies',
  3614: 'tsvector',
  3615: 'tsquery',
  3642: 'gtsvector',
  3734: 'regconfig',
  3769: 'regdictionary',
  3802: 'jsonb',
  4089: 'regnamespace',
  4096: 'regrole',
  // Array types, by their element's OID, for the handful anyone aggregates
  // into interactively.
  1000: 'boolean[]',
  1001: 'bytea[]',
  1005: 'smallint[]',
  1007: 'integer[]',
  1009: 'text[]',
  1015: 'varchar[]',
  1016: 'bigint[]',
  1021: 'real[]',
  1022: 'double precision[]',
  1115: 'timestamp[]',
  1182: 'date[]',
  1185: 'timestamptz[]',
  1231: 'numeric[]',
  2951: 'uuid[]',
  199: 'json[]',
  3807: 'jsonb[]',
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

// The subset of node-postgres's Result this file reads, so the shaping below
// can be exercised without a server (query.test.ts) and stays honest about
// what it depends on.
export interface RawQueryResult {
  fields?: Array<{ name: string; dataTypeID: number }>
  rows: unknown[]
  rowCount: number | null
  command: string
}

// With no parameters, node-postgres sends the text over the simple query
// protocol, and the simple protocol runs every statement in the text:
// `insert ...; select count(*)` is two statements, both committed, and the
// driver answers with an ARRAY of results, one per statement. Reading
// `.rows` off that array was issue #115: every statement had already run and
// committed, then the route reported "Cannot read properties of undefined
// (reading 'length')" as a 400, so Studio showed an error for a write that
// happened. The last statement's result is the one a user wrote the text to
// see, so that is what comes back; the earlier ones ran exactly as they
// would in psql.
export function shapeQueryResult(result: RawQueryResult | RawQueryResult[]): QueryResultShape {
  const last = Array.isArray(result) ? result[result.length - 1] : result
  if (last === undefined) {
    return { columns: [], rows: [], rowCount: 0, command: '' }
  }
  const columns: QueryColumn[] = (last.fields ?? []).map((field) => ({
    name: field.name,
    dataType: dataTypeName(field.dataTypeID),
  }))
  return {
    columns,
    rows: last.rows as Array<Record<string, unknown>>,
    rowCount: last.rowCount ?? last.rows.length,
    command: last.command,
  }
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
    application_name: 'hobby',
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
    return shapeQueryResult(await client.query({ text: sql, values: params }))
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
