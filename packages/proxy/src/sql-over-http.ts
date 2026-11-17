// SQL over HTTP: the `POST /sql` endpoint that `@neondatabase/serverless`'s
// `neon()` query function, and `Pool.query` with `poolQueryViaFetch`, talk
// to. The request and response shapes follow Neon's proxy, which is
// Apache-2.0 and is the ground truth here: proxy/src/serverless/
// sql_over_http.rs (headers, payload, the result object, error fields),
// json.rs (parameters to text, and text to JSON when raw output is off) and
// mod.rs (the OPTIONS preflight).
//
// What differs from Neon, deliberately:
//
// - **One connection per request, no pool.** Neon keeps a pool of
//   authenticated connections behind `/sql`. This opens a fresh connection
//   through the proxy for each request and closes it after. It is simpler,
//   and it is what makes every request a real proxied connection: routed
//   by database name, woken if asleep, and counted as activity by the same
//   ActivityTracker the hibernator reads, exactly as a TCP client is. The
//   cost is one Postgres backend start and one SCRAM exchange per request,
//   a few milliseconds on loopback.
// - **The connection never leaves the process.** The `pg` client's stream
//   is one side of an in-memory socket pair whose other side is handed to
//   the proxy's connection handler (serverless.ts), so there is no
//   loopback listener this depends on, and no TLS question for the hop.
// - **Routing is by database name**, as for every other connection
//   (docs/proxy/CLAUDE.md, "Routing key"). The host in
//   Neon-Connection-String, which Neon uses to pick an endpoint, is ignored.
// - **No JWT.** An Authorization header is refused; the password goes in
//   the connection string, as it does for a TCP client.
// - A DatabaseError from the connection itself (the proxy's own wake
//   failure, a wrong password) is a 400 with its SQLSTATE, so the driver
//   raises a NeonDbError with a `code`, rather than Neon's 500 for compute
//   connection failures.

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'
import pg from 'pg'
import { buildCancelRequest } from './startup.js'

// Neon's defaults for both (proxy/src/binary/proxy.rs,
// sql_over_http_max_request_size_bytes and ..._max_response_size_bytes).
export const MAX_SQL_REQUEST_BYTES = 10 * 1024 * 1024
export const MAX_SQL_RESPONSE_BYTES = 10 * 1024 * 1024

// The daemon's own sessions call themselves this, and the hibernator's
// pre-sleep guard ignores sessions with this name
// (HOBBY_APPLICATION_NAME, packages/pg/src/activity-guard.ts). A request
// that asks for it gets SERVERLESS_APPLICATION_NAME instead, so driver
// traffic is never mistaken for the daemon's. packages/cli's tests assert
// the two constants agree.
export const RESERVED_APPLICATION_NAME = 'hobby'
export const SERVERLESS_APPLICATION_NAME = 'hobby-serverless-driver'

const ISOLATION_LEVELS: Record<string, string> = {
  Serializable: 'SERIALIZABLE',
  ReadUncommitted: 'READ UNCOMMITTED',
  ReadCommitted: 'READ COMMITTED',
  RepeatableRead: 'REPEATABLE READ',
}

// What the browser preflight lists. Neon's list (mod.rs) leaves out
// Neon-Batch-Deferrable, which the driver does send; it is included here.
export const ALLOWED_REQUEST_HEADERS =
  'Authorization, Neon-Connection-String, Neon-Raw-Text-Output, Neon-Array-Mode, Neon-Pool-Opt-In, Neon-Batch-Read-Only, Neon-Batch-Isolation-Level, Neon-Batch-Deferrable'

interface QueryData {
  query: string
  params: Array<string | null>
  arrayMode: boolean | undefined
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly fields: Record<string, unknown> = {}
  ) {
    super(message)
  }
}

// ---------------------------------------------------------------------------
// Parameters: JSON values to Postgres text (Neon's json.rs json_to_pg_text).

function jsonArrayToPgArray(value: unknown): string | null {
  if (value === null) return null
  if (Array.isArray(value)) {
    return `{${value.map((item) => jsonArrayToPgArray(item) ?? 'NULL').join(',')}}`
  }
  if (typeof value === 'object') return JSON.stringify(JSON.stringify(value))
  // Strings are quoted and escaped inside an array, numbers and booleans as
  // their JSON text: JSON.stringify does both, as serde's to_string does.
  return JSON.stringify(value)
}

export function jsonToPgText(value: unknown): string | null {
  if (value === null || value === undefined) return null
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return jsonArrayToPgArray(value)
  return JSON.stringify(value)
}

// ---------------------------------------------------------------------------
// Results: Postgres text to JSON when Neon-Raw-Text-Output is not "true"
// (Neon's json.rs pg_text_to_json). The driver always asks for raw text and
// parses on the client, so this path serves other HTTP clients.

const BOOL = 16
const INT2 = 21
const INT4 = 23
const FLOAT4 = 700
const FLOAT8 = 701
const JSON_OID = 114
const JSONB = 3802

// Array type to element type, for the array types the scalar conversion
// below distinguishes plus the common ones whose elements stay strings.
// Neon reads this from the type catalog; an array type missing here is
// returned as its text, unparsed.
const ARRAY_ELEMENT: Record<number, number> = {
  1000: BOOL,
  1005: INT2,
  1007: INT4,
  1021: FLOAT4,
  1022: FLOAT8,
  199: JSON_OID,
  3807: JSONB,
  1009: 25, // text
  1015: 1043, // varchar
  1014: 1042, // bpchar
  1016: 20, // int8
  1231: 1700, // numeric
  2951: 2950, // uuid
  1182: 1082, // date
  1115: 1114, // timestamp
  1185: 1184, // timestamptz
  1183: 1083, // time
  1187: 1186, // interval
  1001: 17, // bytea
  1028: 26, // oid
}

export function pgTextToJson(text: string, typeId: number): unknown {
  const element = ARRAY_ELEMENT[typeId]
  if (element !== undefined) return parsePgArray(text, element)
  switch (typeId) {
    case BOOL:
      return text === 't'
    case INT2:
    case INT4:
      return Number.parseInt(text, 10)
    case FLOAT4:
    case FLOAT8: {
      const value = Number(text)
      // NaN and the infinities stay strings, as in Neon: JSON has no
      // spelling for them.
      return Number.isFinite(value) ? value : text
    }
    case JSON_OID:
    case JSONB:
      return JSON.parse(text)
    default:
      return text
  }
}

// The array output format (https://www.postgresql.org/docs/current/arrays.html#ARRAYS-IO),
// following Neon's pg_array_parse: dimension decoration is skipped, nested
// braces become nested arrays, quoted items are unescaped, NULL is null.
export function parsePgArray(text: string, element: number): unknown[] {
  let input = text
  if (input.startsWith('[')) {
    const eq = input.indexOf('=')
    if (eq === -1) throw new Error('unbalanced array')
    input = input.slice(eq + 1)
  }
  let pos = 0
  const skipSpace = (): void => {
    while (pos < input.length && /\s/.test(input[pos]!)) pos++
  }
  const parseList = (): unknown[] => {
    skipSpace()
    if (input[pos] !== '{') throw new Error('unbalanced array')
    pos++
    const items: unknown[] = []
    skipSpace()
    if (input[pos] === '}') {
      pos++
      return items
    }
    for (;;) {
      skipSpace()
      if (input[pos] === '{') {
        items.push(parseList())
      } else if (input[pos] === '"') {
        pos++
        let value = ''
        for (;;) {
          const ch = input[pos]
          if (ch === undefined) throw new Error('unbalanced array')
          pos++
          if (ch === '\\') {
            value += input[pos] ?? ''
            pos++
          } else if (ch === '"') {
            break
          } else {
            value += ch
          }
        }
        items.push(pgTextToJson(value, element))
      } else {
        const start = pos
        while (pos < input.length && input[pos] !== ',' && input[pos] !== '}') pos++
        const item = input.slice(start, pos).trim()
        items.push(item === 'NULL' ? null : pgTextToJson(item, element))
      }
      skipSpace()
      if (input[pos] === ',') {
        pos++
        continue
      }
      if (input[pos] === '}') {
        pos++
        return items
      }
      throw new Error('unbalanced array')
    }
  }
  const result = parseList()
  skipSpace()
  if (pos !== input.length) throw new Error('unbalanced array')
  return result
}

// ---------------------------------------------------------------------------
// Request parsing.

function header(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name]
  return Array.isArray(value) ? value[0] : value
}

interface ConnectionInfo {
  user: string
  password: string | undefined
  database: string
  applicationName: string
  options: string | undefined
}

export function parseConnectionString(value: string | undefined): ConnectionInfo {
  if (value === undefined || value.length === 0) {
    throw new HttpError(400, 'missing Neon-Connection-String header')
  }
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new HttpError(400, 'Neon-Connection-String is not a valid URL')
  }
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
    throw new HttpError(400, 'Neon-Connection-String must use the postgres:// or postgresql:// scheme')
  }
  const user = decodeURIComponent(url.username)
  if (user.length === 0) throw new HttpError(400, 'Neon-Connection-String has no user')
  const database = decodeURIComponent(url.pathname.replace(/^\//, '').split('/')[0] ?? '')
  if (database.length === 0) throw new HttpError(400, 'Neon-Connection-String has no database name')
  const requested = url.searchParams.get('application_name')
  const applicationName =
    requested === null || requested.length === 0 || requested === RESERVED_APPLICATION_NAME
      ? SERVERLESS_APPLICATION_NAME
      : requested
  return {
    user,
    password: url.password.length > 0 ? decodeURIComponent(url.password) : undefined,
    database,
    applicationName,
    options: url.searchParams.get('options') ?? undefined,
  }
}

function toQueryData(value: unknown): QueryData {
  if (typeof value !== 'object' || value === null) throw new HttpError(400, 'request body must be a JSON object')
  const item = value as Record<string, unknown>
  if (typeof item['query'] !== 'string') throw new HttpError(400, 'request body has no "query" string')
  const rawParams = item['params'] ?? []
  if (!Array.isArray(rawParams)) throw new HttpError(400, '"params" must be an array')
  const arrayMode = item['arrayMode']
  return {
    query: item['query'],
    params: rawParams.map(jsonToPgText),
    arrayMode: typeof arrayMode === 'boolean' ? arrayMode : undefined,
  }
}

export function parsePayload(body: Buffer): { single: QueryData } | { batch: QueryData[] } {
  let json: unknown
  try {
    json = JSON.parse(body.toString('utf8'))
  } catch (err) {
    throw new HttpError(400, `request body is not valid JSON: ${err instanceof Error ? err.message : String(err)}`)
  }
  if (typeof json === 'object' && json !== null && Array.isArray((json as Record<string, unknown>)['queries'])) {
    return { batch: ((json as Record<string, unknown>)['queries'] as unknown[]).map(toQueryData) }
  }
  return { single: toQueryData(json) }
}

function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > limit) {
        reject(new HttpError(413, `request is too large (max is ${limit} bytes)`))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

// ---------------------------------------------------------------------------
// Execution.

interface FieldJson {
  name: string
  dataTypeID: number
  tableID: number
  columnID: number
  dataTypeSize: number
  dataTypeModifier: number
  format: 'text'
}

// Every value as the text Postgres sent, whatever its type: the driver (or,
// with raw output off, pgTextToJson) does the parsing.
const RAW_TYPES = { getTypeParser: () => (value: string) => value }

class ResponseBudget {
  used = 0
  constructor(readonly limit: number) {}
  spend(bytes: number): boolean {
    this.used += bytes
    return this.used <= this.limit
  }
}

class TooLarge extends Error {}

// Runs one statement on the extended protocol, as Neon's query_raw_txt does
// (so, as on Neon, one statement per query: Postgres refuses several in a
// prepared statement), and builds the result object row by row so the size
// cap can stop a runaway result rather than buffer it.
function runQuery(
  client: pg.Client,
  data: QueryData,
  defaultArrayMode: boolean,
  rawOutput: boolean,
  budget: ResponseBudget,
  onTooLarge: () => void
): Promise<string> {
  const arrayMode = data.arrayMode ?? defaultArrayMode
  return new Promise((resolve, reject) => {
    const rows: string[] = []
    let tooLarge = false
    const query = new pg.Query({
      text: data.query,
      values: data.params,
      rowMode: 'array',
      types: RAW_TYPES,
      queryMode: 'extended',
    } as pg.QueryConfig)
    query.on('row', (row: Array<string | null>, result?: pg.QueryResult) => {
      if (tooLarge) return
      const fields = result?.fields ?? []
      const values = rawOutput ? row : row.map((value, i) => (value === null ? null : pgTextToJson(value, fields[i]?.dataTypeID ?? 0)))
      const json = arrayMode
        ? JSON.stringify(values)
        : JSON.stringify(Object.fromEntries(fields.map((field, i) => [field.name, values[i] ?? null])))
      if (!budget.spend(json.length + 1)) {
        tooLarge = true
        onTooLarge()
        return
      }
      rows.push(json)
    })
    query.on('error', (err: Error) => reject(tooLarge ? new TooLarge() : err))
    query.on('end', (result: pg.QueryResult) => {
      if (tooLarge) {
        reject(new TooLarge())
        return
      }
      const fields: FieldJson[] = (result.fields ?? []).map((field) => ({
        name: field.name,
        dataTypeID: field.dataTypeID,
        tableID: field.tableID,
        columnID: field.columnID,
        dataTypeSize: field.dataTypeSize,
        dataTypeModifier: field.dataTypeModifier,
        format: 'text',
      }))
      // Neon's command and rowCount come from the command tag: the first
      // word, and the count when there is one (the second number for
      // INSERT). node-postgres parses the tag the same way.
      const command = result.command ?? ''
      const rowCount = typeof result.rowCount === 'number' ? result.rowCount : null
      resolve(
        `{"fields":${JSON.stringify(fields)},"rows":[${rows.join(',')}],"command":${JSON.stringify(command)},"rowCount":${JSON.stringify(rowCount)},"rowAsArray":${arrayMode}}`
      )
    })
    client.query(query)
  })
}

function errorJson(err: unknown): { status: number; body: Record<string, unknown> } {
  if (err instanceof HttpError) return { status: err.status, body: { message: err.message, ...err.fields } }
  if (err instanceof TooLarge) {
    return { status: 507, body: { message: `response is too large (max is ${MAX_SQL_RESPONSE_BYTES} bytes)` } }
  }
  if (err instanceof pg.DatabaseError) {
    // The fields Neon returns (sql_over_http.rs, the json! in `handle`),
    // which the driver copies onto its NeonDbError. 28000 is a refusal of
    // the client itself, the project's IP allowlist (access.ts) or a
    // pg_hba.conf reject, so it is a 403 rather than a bad query.
    return {
      status: err.code === '28000' ? 403 : 400,
      body: {
        message: err.message,
        code: err.code,
        detail: err.detail,
        hint: err.hint,
        position: err.position,
        internalPosition: err.internalPosition,
        internalQuery: err.internalQuery,
        severity: err.severity,
        where: err.where,
        table: err.table,
        column: err.column,
        schema: err.schema,
        dataType: err.dataType,
        constraint: err.constraint,
        file: err.file,
        line: err.line,
        routine: err.routine,
      },
    }
  }
  return { status: 500, body: { message: err instanceof Error ? err.message : String(err) } }
}

export interface SqlOverHttpDeps {
  // A fresh in-process connection to the proxy: the client side of a socket
  // pair whose other side the proxy's connection handler is already reading.
  openConnection(): Duplex
  maxRequestBytes?: number
  maxResponseBytes?: number
}

function send(res: ServerResponse, status: number, body: string, extraHeaders: Record<string, string> = {}): void {
  if (res.headersSent || res.destroyed) return
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Content-Length': Buffer.byteLength(body),
    ...extraHeaders,
  })
  res.end(body)
}

export function handleSqlPreflight(res: ServerResponse): void {
  res.writeHead(200, {
    Allow: 'OPTIONS, POST',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': ALLOWED_REQUEST_HEADERS,
    'Access-Control-Max-Age': '86400',
    'Content-Length': 0,
  })
  res.end()
}

export async function handleSql(req: IncomingMessage, res: ServerResponse, deps: SqlOverHttpDeps): Promise<void> {
  const maxRequest = deps.maxRequestBytes ?? MAX_SQL_REQUEST_BYTES
  const budget = new ResponseBudget(deps.maxResponseBytes ?? MAX_SQL_RESPONSE_BYTES)
  let client: pg.Client | null = null
  let finished = false

  // A client that goes away mid-query gets its query cancelled, as on Neon,
  // through the proxy's own cancel routing: the key node-postgres holds is
  // the one the proxy minted for this connection (docs/proxy/CLAUDE.md,
  // "Cancels route on a key the proxy mints").
  const cancel = (): void => {
    const c = client as (pg.Client & { processID?: number | null; secretKey?: number | null }) | null
    if (c === null || typeof c.processID !== 'number' || typeof c.secretKey !== 'number') return
    const stream = deps.openConnection()
    stream.on('error', () => {})
    stream.end(buildCancelRequest({ processId: c.processID, secretKey: c.secretKey }))
  }
  res.on('close', () => {
    if (!finished) {
      cancel()
      void client?.end().catch(() => {})
    }
  })

  try {
    if (header(req, 'authorization') !== undefined) {
      throw new HttpError(400, 'Hobbyist does not accept JWT authorization; put the password in the connection string')
    }
    const conn = parseConnectionString(header(req, 'neon-connection-string'))
    const rawOutput = header(req, 'neon-raw-text-output') === 'true'
    const defaultArrayMode = header(req, 'neon-array-mode') === 'true'
    const isolationHeader = header(req, 'neon-batch-isolation-level')
    const isolation = isolationHeader === undefined ? undefined : ISOLATION_LEVELS[isolationHeader]
    if (isolationHeader !== undefined && isolation === undefined) throw new HttpError(400, 'invalid isolation level')
    const readOnly = header(req, 'neon-batch-read-only') === 'true'
    const deferrable = header(req, 'neon-batch-deferrable') === 'true'

    const payload = parsePayload(await readBody(req, maxRequest))

    client = new pg.Client({
      user: conn.user,
      ...(conn.password === undefined ? {} : { password: conn.password }),
      database: conn.database,
      application_name: conn.applicationName,
      ...(conn.options === undefined ? {} : { options: conn.options }),
      stream: () => deps.openConnection(),
    } as pg.ClientConfig)
    client.on('error', () => {})
    await client.connect()

    const tooLarge = (): void => cancel()
    let body: string
    const headers: Record<string, string> = {}
    if ('single' in payload) {
      body = await runQuery(client, payload.single, defaultArrayMode, rawOutput, budget, tooLarge)
    } else {
      let begin = 'BEGIN'
      if (isolation !== undefined) begin += ` ISOLATION LEVEL ${isolation}`
      if (readOnly) begin += ' READ ONLY'
      if (deferrable) begin += ' DEFERRABLE'
      await client.query(begin)
      const results: string[] = []
      for (const query of payload.batch) {
        // A failure leaves the transaction open; closing the connection
        // below rolls it back, as Neon's discard of the connection does.
        results.push(await runQuery(client, query, defaultArrayMode, rawOutput, budget, tooLarge))
      }
      await client.query('COMMIT')
      body = `{"results":[${results.join(',')}]}`
      if (readOnly) headers['Neon-Batch-Read-Only'] = 'true'
      if (deferrable) headers['Neon-Batch-Deferrable'] = 'true'
      if (isolationHeader !== undefined) headers['Neon-Batch-Isolation-Level'] = isolationHeader
    }
    finished = true
    send(res, 200, body, headers)
  } catch (err) {
    finished = true
    const { status, body } = errorJson(err)
    send(res, status, JSON.stringify(body))
  } finally {
    finished = true
    if (client !== null) await client.end().catch(() => {})
  }
}
