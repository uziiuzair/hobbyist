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

export interface TableInfo {
  name: string
  columns: ColumnInfo[]
  primaryKey: string[]
  foreignKeys: ForeignKeyInfo[]
  indexes: IndexInfo[]
}

const TABLES_SQL = `
  select table_name
  from information_schema.tables
  where table_schema = 'public' and table_type = 'BASE TABLE'
  order by table_name
`

const COLUMNS_SQL = `
  select table_name, column_name, data_type, is_nullable, column_default
  from information_schema.columns
  where table_schema = 'public'
  order by table_name, ordinal_position
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

function nullableStr(row: Record<string, unknown>, key: string): string | null {
  const value = row[key]
  return value === null || value === undefined ? null : String(value)
}

export async function loadTableNames(run: RunQueryFn): Promise<string[]> {
  const result = await run(TABLES_SQL)
  return result.rows.map((row) => str(row, 'table_name'))
}

export async function loadSchema(run: RunQueryFn): Promise<TableInfo[]> {
  const [tables, columns, primaryKeys, foreignKeys, indexes] = await Promise.all([
    run(TABLES_SQL),
    run(COLUMNS_SQL),
    run(PRIMARY_KEYS_SQL),
    run(FOREIGN_KEYS_SQL),
    run(INDEXES_SQL),
  ])

  const byTable = new Map<string, TableInfo>()
  for (const row of tables.rows) {
    const name = str(row, 'table_name')
    byTable.set(name, { name, columns: [], primaryKey: [], foreignKeys: [], indexes: [] })
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
      nullable: str(row, 'is_nullable') === 'YES',
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
