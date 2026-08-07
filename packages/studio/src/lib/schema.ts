// Builds the read-only schema view out of the one query route Studio has
// (see api.ts's runQuery). No dedicated schema route exists on the daemon
// yet; this is the "route it should have" stand-in described in the task
// brief, reading information_schema and pg_indexes exactly the way a human
// would from psql. Kept as pure, injectable functions (RunQueryFn) so the
// assembly logic is testable without a network call.
//
// The daemon's own docs/studio/CLAUDE.md asks the open question of whether
// this should instead be cached server-side; see the report for that
// tradeoff. Everything here assumes the `public` schema, matching what
// hobby new creates and the only schema Phase 1 exposes.

export interface QueryColumn {
  name: string
  dataType: string
}

export interface QueryResultLike {
  columns: QueryColumn[]
  rows: Array<Record<string, unknown>>
  rowCount: number
  command: string
}

export type RunQueryFn = (sql: string, params?: unknown[]) => Promise<QueryResultLike>

export interface ColumnInfo {
  name: string
  dataType: string
  nullable: boolean
  defaultValue: string | null
  isPrimaryKey: boolean
}

export interface ForeignKeyInfo {
  column: string
  referencesTable: string
  referencesColumn: string
}

export interface IndexInfo {
  name: string
  definition: string
  unique: boolean
}

// contype straight from pg_constraint: p primary key, f foreign key,
// u unique, c check, x exclusion. Carried verbatim rather than translated,
// because the definition beside it is Postgres's own text and the two should
// not disagree.
export interface ConstraintInfo {
  name: string
  definition: string
  kind: string
}

export interface TableInfo {
  name: string
  columns: ColumnInfo[]
  primaryKey: string[]
  foreignKeys: ForeignKeyInfo[]
  constraints: ConstraintInfo[]
  indexes: IndexInfo[]
}

const TABLES_SQL = `
  select table_name
  from information_schema.tables
  where table_schema = 'public' and table_type = 'BASE TABLE'
  order by table_name
`

// pg_catalog rather than information_schema, for one reason: format_type
// returns the type as Postgres itself would write it, so a column reads
// `character varying(120)` and `numeric(10,2)` instead of the bare
// `character varying` and `numeric` that information_schema.data_type gives.
// The schema page renders these as DDL and offers to copy it, and DDL that
// silently drops every length and precision is DDL that does not round-trip.
const COLUMNS_SQL = `
  select
    c.relname as table_name,
    a.attname as column_name,
    pg_catalog.format_type(a.atttypid, a.atttypmod) as data_type,
    a.attnotnull as not_null,
    pg_get_expr(d.adbin, d.adrelid) as column_default
  from pg_attribute a
  join pg_class c on c.oid = a.attrelid
  join pg_namespace n on n.oid = c.relnamespace
  left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
  where n.nspname = 'public'
    and c.relkind = 'r'
    and a.attnum > 0
    and not a.attisdropped
  order by c.relname, a.attnum
`

// pg_get_constraintdef is the only honest source for a constraint: it is the
// text Postgres would print in \\d, ON DELETE clause and all, and assembling
// that string ourselves out of catalog columns is how a schema viewer starts
// quietly lying about a cascade.
//
// contype 'n' is excluded. Postgres 17 gave NOT NULL its own pg_constraint
// row, so every non-null column on PG18 (the version this ships against)
// produces a constraint named like wide_orders_id_not_null whose definition
// is "NOT NULL id". Listing those would repeat what the column line already
// says once per column, and emitting them inside a generated CREATE TABLE
// would produce a statement that does not replay.
const CONSTRAINTS_SQL = `
  select
    c.relname as table_name,
    con.conname as name,
    con.contype as kind,
    pg_get_constraintdef(con.oid) as definition
  from pg_constraint con
  join pg_class c on c.oid = con.conrelid
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and con.contype <> 'n'
  order by c.relname, con.contype, con.conname
`

const PRIMARY_KEYS_SQL = `
  select tc.table_name, kcu.column_name
  from information_schema.table_constraints tc
  join information_schema.key_column_usage kcu
    on tc.constraint_name = kcu.constraint_name and tc.table_schema = kcu.table_schema
  where tc.constraint_type = 'PRIMARY KEY' and tc.table_schema = 'public'
  order by tc.table_name, kcu.ordinal_position
`

const FOREIGN_KEYS_SQL = `
  select
    tc.table_name,
    kcu.column_name,
    ccu.table_name as references_table,
    ccu.column_name as references_column
  from information_schema.table_constraints tc
  join information_schema.key_column_usage kcu
    on tc.constraint_name = kcu.constraint_name and tc.table_schema = kcu.table_schema
  join information_schema.constraint_column_usage ccu
    on tc.constraint_name = ccu.constraint_name and tc.table_schema = ccu.table_schema
  where tc.constraint_type = 'FOREIGN KEY' and tc.table_schema = 'public'
  order by tc.table_name, kcu.column_name
`

const INDEXES_SQL = `
  select indexname, tablename, indexdef
  from pg_indexes
  where schemaname = 'public'
  order by tablename, indexname
`

function str(row: Record<string, unknown>, key: string): string {
  const value = row[key]
  return typeof value === 'string' ? value : String(value)
}

function isTrue(value: unknown): boolean {
  return value === true || value === 't' || value === 'true'
}

function nullableStr(row: Record<string, unknown>, key: string): string | null {
  const value = row[key]
  return value === null || value === undefined ? null : String(value)
}

export async function loadTableNames(run: RunQueryFn): Promise<string[]> {
  const result = await run(TABLES_SQL)
  return result.rows.map((row) => str(row, 'table_name'))
}

export async function loadSchema(run: RunQueryFn): Promise<TableInfo[]> {
  const [tables, columns, primaryKeys, foreignKeys, constraints, indexes] = await Promise.all([
    run(TABLES_SQL),
    run(COLUMNS_SQL),
    run(PRIMARY_KEYS_SQL),
    run(FOREIGN_KEYS_SQL),
    run(CONSTRAINTS_SQL),
    run(INDEXES_SQL),
  ])

  const byTable = new Map<string, TableInfo>()
  for (const row of tables.rows) {
    const name = str(row, 'table_name')
    byTable.set(name, { name, columns: [], primaryKey: [], foreignKeys: [], constraints: [], indexes: [] })
  }

  const primaryKeyColumns = new Map<string, Set<string>>()
  for (const row of primaryKeys.rows) {
    const table = str(row, 'table_name')
    const column = str(row, 'column_name')
    const set = primaryKeyColumns.get(table) ?? new Set<string>()
    set.add(column)
    primaryKeyColumns.set(table, set)
  }

  for (const row of columns.rows) {
    const tableName = str(row, 'table_name')
    const table = byTable.get(tableName)
    if (table === undefined) continue
    const columnName = str(row, 'column_name')
    table.columns.push({
      name: columnName,
      dataType: str(row, 'data_type'),
      // attnotnull arrives as a real boolean over the wire, but a driver that
      // hands back 't' or 'true' would otherwise read as nullable: false for
      // every column, which is the failure mode that looks correct.
      nullable: !isTrue(row['not_null']),
      defaultValue: nullableStr(row, 'column_default'),
      isPrimaryKey: primaryKeyColumns.get(tableName)?.has(columnName) ?? false,
    })
  }

  for (const [tableName, pkSet] of primaryKeyColumns) {
    const table = byTable.get(tableName)
    if (table !== undefined) table.primaryKey = [...pkSet]
  }

  for (const row of foreignKeys.rows) {
    const table = byTable.get(str(row, 'table_name'))
    if (table === undefined) continue
    table.foreignKeys.push({
      column: str(row, 'column_name'),
      referencesTable: str(row, 'references_table'),
      referencesColumn: str(row, 'references_column'),
    })
  }

  for (const row of constraints.rows) {
    const table = byTable.get(str(row, 'table_name'))
    if (table === undefined) continue
    table.constraints.push({
      name: str(row, 'name'),
      definition: str(row, 'definition'),
      kind: str(row, 'kind'),
    })
  }

  for (const row of indexes.rows) {
    const table = byTable.get(str(row, 'tablename'))
    if (table === undefined) continue
    const definition = str(row, 'indexdef')
    table.indexes.push({
      name: str(row, 'indexname'),
      definition,
      unique: definition.toUpperCase().startsWith('CREATE UNIQUE INDEX'),
    })
  }

  return [...byTable.values()]
}

export function primaryKeyOf(tables: TableInfo[], tableName: string): string[] {
  return tables.find((t) => t.name === tableName)?.primaryKey ?? []
}

// The column's own DDL fragment, the same string the page renders and the
// copy button writes to the clipboard. One function so those two can never
// drift: a schema page whose display and whose export disagree is worse than
// one that only displays.
export function columnDdl(column: ColumnInfo): string {
  const modifiers = columnModifiers(column)
  const head = `${quoted(column.name)} ${column.dataType}`
  return modifiers.length === 0 ? head : `${head} ${modifiers}`
}

// Split out so the page can rank the modifiers differently from the name and
// the type without slicing the assembled string back apart, which breaks the
// moment an identifier needs quoting.
export function columnModifiers(column: ColumnInfo): string {
  const parts: string[] = []
  if (!column.nullable) parts.push('NOT NULL')
  if (column.defaultValue !== null) parts.push(`DEFAULT ${column.defaultValue}`)
  return parts.join(' ')
}

// Quote only when Postgres would have to. An unconditional quote turns every
// ordinary lowercase name into "name", which is correct and unreadable.
function quoted(identifier: string): string {
  return /^[a-z_][a-z0-9_$]*$/.test(identifier) ? identifier : `"${identifier.replace(/"/g, '""')}"`
}

// CREATE TABLE plus the indexes that are not already implied by a constraint.
// Postgres reports a primary key twice, once as the constraint and once as
// the unique index backing it, and emitting both produces DDL that fails on
// replay.
export function tableDdl(table: TableInfo): string {
  const constraintNames = new Set(table.constraints.map((c) => c.name))
  const lines = [
    ...table.columns.map((column) => `  ${columnDdl(column)}`),
    ...table.constraints.map((constraint) => `  CONSTRAINT ${quoted(constraint.name)} ${constraint.definition}`),
  ]
  const extraIndexes = table.indexes.filter((index) => !constraintNames.has(index.name))
  const body = `CREATE TABLE ${quoted(table.name)} (\n${lines.join(',\n')}\n);`
  if (extraIndexes.length === 0) return body
  return `${body}\n\n${extraIndexes.map((index) => `${index.definition};`).join('\n')}`
}
