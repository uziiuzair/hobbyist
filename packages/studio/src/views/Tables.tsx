import { useCallback, useEffect, useState } from 'react'
import * as api from '../api.js'
import { navigate } from '../lib/router.js'
import { useResource } from '../lib/useResource.js'
import { useWakeAwareRun } from '../lib/useWaking.js'
import { WakingBanner } from '../components/WakingBanner.js'
import { Workbench } from '../components/Workbench.js'
import { SpotRows } from '../components/Spot.js'
import { quoteIdentifier } from '../lib/identifiers.js'
import { loadSchema, type TableInfo } from '../lib/schema.js'

const PAGE_SIZE = 50

export function Tables({
  projectName,
  resourceName,
  tableName,
  onChanged,
}: {
  projectName: string
  resourceName: string
  tableName: string | undefined
  onChanged?: () => void
}) {
  const { resource, error: resourceError, refresh } = useResource(projectName, resourceName)
  const { snapshot, run } = useWakeAwareRun(() => {
    refresh()
    onChanged?.()
  })

  const [tables, setTables] = useState<TableInfo[] | null>(null)
  const [schemaError, setSchemaError] = useState<string | null>(null)

  const [rows, setRows] = useState<Array<Record<string, unknown>> | null>(null)
  const [queryMs, setQueryMs] = useState<number | null>(null)
  const [tableQuery, setTableQuery] = useState('')
  const [page, setPage] = useState(0)
  const [filter, setFilter] = useState('')
  const [appliedFilter, setAppliedFilter] = useState('')
  const [rowsError, setRowsError] = useState<string | null>(null)
  const [editing, setEditing] = useState<{ rowIndex: number; column: string; popout: boolean } | null>(null)
  const [editValue, setEditValue] = useState('')
  const [saveError, setSaveError] = useState<string | null>(null)

  const base = `/projects/${encodeURIComponent(projectName)}/resources/${encodeURIComponent(resourceName)}/tables`

  useEffect(() => {
    if (resource === null) return
    run(resource.id, resource.state, () => loadSchema((sql, params) => api.runQuery(resource.id, sql, params)))
      .then(setTables)
      .catch((err: unknown) => setSchemaError(err instanceof api.ApiError ? err.message : 'failed to load tables'))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resource?.id])

  const active = tableName ?? tables?.[0]?.name

  const loadRows = useCallback(
    (pageToLoad: number, filterToApply: string) => {
      if (resource === null || active === undefined) return
      const table = tables?.find((t) => t.name === active)
      const columnNames = table !== undefined ? table.columns.map((c) => c.name) : ['*']
      const selectList = table !== undefined ? columnNames.map(quoteIdentifier).join(', ') : '*'
      let sql = `select ${selectList} from ${quoteIdentifier(active)}`
      if (filterToApply.trim().length > 0) sql += ` where ${filterToApply}`
      sql += ` limit $1 offset $2`
      setRowsError(null)
      const startedAt = Date.now()
      run(resource.id, resource.state, () => api.runQuery(resource.id, sql, [PAGE_SIZE, pageToLoad * PAGE_SIZE]))
        .then((result) => {
          setRows(result.rows)
          // Measured client side because the daemon does not report timing.
          // It therefore includes the wake, which is the honest number: it is
          // what the query cost you, not what the planner cost.
          setQueryMs(Date.now() - startedAt)
        })
        .catch((err: unknown) => setRowsError(err instanceof api.ApiError ? err.message : 'query failed'))
    },
    [resource, active, tables, run]
  )

  useEffect(() => {
    setPage(0)
    setAppliedFilter('')
    setFilter('')
    if (active !== undefined) loadRows(0, '')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, resource?.id])

  if (resourceError !== null) {
    return (
      <div className="page measure">
        <div className="notice notice-danger">{resourceError}</div>
      </div>
    )
  }
  if (resource === null) {
    return (
      <div className="page measure">
        <span className="hint-text">Loading {resourceName}</span>
      </div>
    )
  }

  const currentTable = tables?.find((t) => t.name === active)

  function handleSelectTable(name: string): void {
    navigate(`${base}/${encodeURIComponent(name)}`)
  }

  function handleApplyFilter(): void {
    setAppliedFilter(filter)
    setPage(0)
    loadRows(0, filter)
  }

  function handlePage(delta: number): void {
    const next = Math.max(0, page + delta)
    setPage(next)
    loadRows(next, appliedFilter)
  }

  const POPOUT_AT = 48

  function startEdit(rowIndex: number, column: string, currentValue: unknown): void {
    if (currentTable === undefined || currentTable.primaryKey.length === 0) return
    const text = currentValue === null ? '' : String(currentValue)
    setEditing({ rowIndex, column, popout: text.length > POPOUT_AT || text.includes('\n') })
    setEditValue(currentValue === null || currentValue === undefined ? '' : String(currentValue))
    setSaveError(null)
  }

  async function commitEdit(): Promise<void> {
    if (resource === null || editing === null || rows === null || currentTable === undefined || active === undefined) return
    const row = rows[editing.rowIndex]
    if (row === undefined) return
    const pk = currentTable.primaryKey
    if (pk.length === 0) return

    const setSql = `${quoteIdentifier(editing.column)} = $1`
    const whereSql = pk.map((col, i) => `${quoteIdentifier(col)} = $${i + 2}`).join(' and ')
    const returningSql = currentTable.columns.map((c) => quoteIdentifier(c.name)).join(', ')
    const sql = `update ${quoteIdentifier(active)} set ${setSql} where ${whereSql} returning ${returningSql}`
    const params: unknown[] = [editValue, ...pk.map((col) => row[col])]

    try {
      const result = await run(resource.id, resource.state, () => api.runQuery(resource.id, sql, params))
      const updated = result.rows[0]
      if (updated !== undefined) {
        setRows((prev) => (prev === null ? prev : prev.map((r, i) => (i === editing.rowIndex ? updated : r))))
      }
      setEditing(null)
      setSaveError(null)
    } catch (err) {
      setSaveError(err instanceof api.ApiError ? err.message : 'failed to save the edit')
    }
  }

  const visibleTables = (tables ?? []).filter((t) =>
    tableQuery.trim().length === 0 ? true : t.name.toLowerCase().includes(tableQuery.trim().toLowerCase()),
  )

  return (
    <Workbench
      sidebar={
        <>
          <div className="wb-side-head">
            <span className="wb-side-title">Tables</span>
            <span className="wb-side-count">{tables?.length ?? 0}</span>
          </div>
          <div className="wb-side-search">
            <div className="search">
              <svg width="13" height="13" viewBox="0 0 13 13" fill="none" aria-hidden="true">
                <circle cx="5.6" cy="5.6" r="3.9" stroke="currentColor" strokeWidth="1.3" />
                <path d="M8.6 8.6 11.3 11.3" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
              </svg>
              <input
                className="input"
                placeholder="Search tables"
                aria-label="Search tables"
                value={tableQuery}
                onChange={(event) => setTableQuery(event.target.value)}
              />
            </div>
          </div>
          <div className="wb-side-list">
            {tables === null && <div className="side-list-empty">Loading</div>}
            {tables?.length === 0 && <div className="side-list-empty">No tables in the public schema</div>}
            {tables !== null && tables.length > 0 && visibleTables.length === 0 && (
              <div className="side-list-empty">No table matches</div>
            )}
            {visibleTables.map((t) => (
              <button
                type="button"
                key={t.name}
                className={`wb-table${t.name === active ? ' active' : ''}`}
                aria-current={t.name === active ? 'page' : undefined}
                onClick={() => handleSelectTable(t.name)}
              >
                <svg width="13" height="13" viewBox="0 0 14 14" fill="none" aria-hidden="true">
                  <rect x="1.5" y="2" width="11" height="10" rx="1.5" stroke="currentColor" strokeWidth="1.2" />
                  <path d="M1.5 5.5h11M5.5 5.5V12" stroke="currentColor" strokeWidth="1.2" />
                </svg>
                <span className="wb-table-name">{t.name}</span>
                {t.primaryKey.length === 0 && <span className="wb-table-note">no pk</span>}
              </button>
            ))}
          </div>
        </>
      }
    >
      <WakingBanner resourceName={resourceName} snapshot={snapshot} />
      {schemaError !== null && <div className="notice notice-danger">{schemaError}</div>}
          {active === undefined ? (
            <div className="empty">
              <SpotRows />
              <h3>Pick a table</h3>
              <p>Choose a table on the left to browse its rows.</p>
            </div>
          ) : (
            <>
              <div className="grid-toolbar">
                <input
                  className="input grid-filter"
                  placeholder="Filter rows: status = 'active'"
                  aria-label="Filter rows with a SQL boolean expression"
                  value={filter}
                  onChange={(event) => setFilter(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') handleApplyFilter()
                  }}
                />
                <button type="button" className="btn btn-sm" onClick={handleApplyFilter}>
                  Apply
                </button>

                <div className="grid-toolbar-right">
                  {queryMs !== null && <span className="grid-timing">{queryMs}ms</span>}
                  <span className="grid-range">
                    {rows === null || rows.length === 0
                      ? 'No rows'
                      : `${page * PAGE_SIZE + 1} to ${page * PAGE_SIZE + rows.length}`}
                  </span>
                  <div className="grid-nav">
                    <button
                      type="button"
                      className="btn btn-sm"
                      aria-label="Previous page"
                      disabled={page === 0}
                      onClick={() => handlePage(-1)}
                    >
                      Previous
                    </button>
                    <button
                      type="button"
                      className="btn btn-sm"
                      aria-label="Next page"
                      disabled={rows === null || rows.length < PAGE_SIZE}
                      onClick={() => handlePage(1)}
                    >
                      Next
                    </button>
                  </div>
                </div>
              </div>

              {rowsError !== null && <div className="notice notice-danger">{rowsError}</div>}
              {saveError !== null && <div className="notice notice-danger">{saveError}</div>}
              {currentTable !== undefined && currentTable.primaryKey.length === 0 && (
                <div className="hint-text">No primary key found on this table: edits are disabled to avoid an ambiguous update.</div>
              )}

              {rows === null ? (
                <div className="hint-text">Loading rows</div>
              ) : rows.length === 0 ? (
                <div className="empty">No rows.</div>
              ) : (
                <div className="table-scroll">
                  <table className="data-table grid-table">
                    <thead>
                      <tr>
                        {Object.keys(rows[0] ?? {}).map((col) => {
                          const meta = currentTable?.columns.find((c) => c.name === col)
                          return (
                            <th key={col}>
                              <span className="col-name">{col}</span>
                              {meta !== undefined && <span className="col-type">{meta.dataType}</span>}
                              {meta?.isPrimaryKey === true && <span className="key-tag">PK</span>}
                            </th>
                          )
                        })}
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((row, rowIndex) => (
                        <tr key={rowIndex}>
                          {Object.entries(row).map(([col, value]) => {
                            const isEditing = editing !== null && editing.rowIndex === rowIndex && editing.column === col
                            const editable = currentTable !== undefined && currentTable.primaryKey.length > 0
                            return (
                              <td
                                key={col}
                                className={editable ? 'editable' : ''}
                                onClick={() => !isEditing && startEdit(rowIndex, col, value)}
                              >
                                {isEditing && editing?.popout === false ? (
                                  <input
                                    className="cell-input"
                                    autoFocus
                                    value={editValue}
                                    onChange={(event) => setEditValue(event.target.value)}
                                    onBlur={() => void commitEdit()}
                                    onKeyDown={(event) => {
                                      if (event.key === 'Enter') void commitEdit()
                                      if (event.key === 'Escape') setEditing(null)
                                    }}
                                  />
                                ) : isEditing ? (
                                  <CellPopout
                                    column={col}
                                    value={editValue}
                                    onChange={setEditValue}
                                    onCancel={() => setEditing(null)}
                                    onSave={() => void commitEdit()}
                                    onNull={() => {
                                      setEditValue('')
                                      void commitEdit()
                                    }}
                                  />
                                ) : value === null ? (
                                  <span className="cell-null">NULL</span>
                                ) : (
                                  // Truncation lives on a span rather than the
                                  // cell so an open editor is never clipped by
                                  // it. title carries the whole value, since a
                                  // column of json blobs is otherwise either
                                  // unreadable or a kilometre wide.
                                  <span className="cell-value" title={String(value)}>
                                    {String(value)}
                                  </span>
                                )}
                              </td>
                            )
                          })}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

            </>
          )}
    </Workbench>
  )
}

// Anything long or multiline gets room rather than a one line box the width of
// a column. Anchored over the cell it belongs to, so you never lose which
// value you are changing, with the keys it responds to written on the buttons.
function CellPopout({
  column,
  value,
  onChange,
  onCancel,
  onSave,
  onNull,
}: {
  column: string
  value: string
  onChange: (next: string) => void
  onCancel: () => void
  onSave: () => void
  onNull: () => void
}) {
  return (
    <div className="cell-popout" role="dialog" aria-label={`Edit ${column}`}>
      <textarea
        className="cell-popout-area"
        autoFocus
        value={value}
        spellCheck={false}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault()
            onCancel()
          }
          if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
            event.preventDefault()
            onSave()
          }
        }}
      />
      <div className="cell-popout-foot">
        <button type="button" className="btn btn-sm" onClick={onNull}>
          Set NULL
        </button>
        <div className="row" style={{ marginLeft: 'auto', gap: 6 }}>
          <button type="button" className="btn btn-sm" onClick={onCancel}>
            Cancel <kbd>Esc</kbd>
          </button>
          <button type="button" className="btn btn-sm btn-primary" onClick={onSave}>
            Save <kbd>{navigator.platform.includes('Mac') ? '\u2318' : 'Ctrl'}</kbd>
            <kbd>{'\u21B5'}</kbd>
          </button>
        </div>
      </div>
    </div>
  )
}
