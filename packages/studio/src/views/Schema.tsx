import { useEffect, useState } from 'react'
import * as api from '../api.js'
import { useResource } from '../lib/useResource.js'
import { useWakeAwareRun } from '../lib/useWaking.js'
import { WakingBanner } from '../components/WakingBanner.js'
import { ResourceTabs } from '../components/ResourceTabs.js'
import { loadSchema, type TableInfo } from '../lib/schema.js'

// Read only, deliberately: root CLAUDE.md and docs/studio/CLAUDE.md both
// call out that a correct visual DDL editor has to generate safe
// migrations, and getting that wrong damages real data. Nothing here ever
// issues a write.

export function Schema({ projectName, resourceName }: { projectName: string; resourceName: string }) {
  const { resource, error: resourceError } = useResource(projectName, resourceName)
  const { snapshot, run } = useWakeAwareRun()
  const [tables, setTables] = useState<TableInfo[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (resource === null) return
    run(resource.id, resource.state, () => loadSchema((sql, params) => api.runQuery(resource.id, sql, params)))
      .then(setTables)
      .catch((err: unknown) => setError(err instanceof api.ApiError ? err.message : 'failed to load schema'))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resource?.id])

  if (resourceError !== null) {
    return <div className="error-banner">{resourceError}</div>
  }
  if (resource === null) {
    return <div className="hint-text">Loading {resourceName}...</div>
  }

  return (
    <div className="page measure stack">
      <ResourceTabs projectName={projectName} resourceName={resourceName} active="schema" />
      <WakingBanner resourceName={resourceName} snapshot={snapshot} />
      {error !== null && <div className="error-banner">{error}</div>}

      {tables === null ? (
        <div className="hint-text">Loading schema...</div>
      ) : tables.length === 0 ? (
        <div className="empty-state">No tables in the public schema.</div>
      ) : (
        tables.map((table) => (
          <div key={table.name} className="card schema-table">
            <div className="schema-table-name">{table.name}</div>
            <div className="table-scroll">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>column</th>
                    <th>type</th>
                    <th>nullable</th>
                    <th>default</th>
                  </tr>
                </thead>
                <tbody>
                  {table.columns.map((col) => {
                    const fk = table.foreignKeys.find((f) => f.column === col.name)
                    return (
                      <tr key={col.name}>
                        <td>
                          {col.name}
                          {col.isPrimaryKey && <span className="key-tag">PK</span>}
                          {fk !== undefined && (
                            <span className="fk-tag">
                              FK -&gt; {fk.referencesTable}.{fk.referencesColumn}
                            </span>
                          )}
                        </td>
                        <td>{col.dataType}</td>
                        <td>{col.nullable ? 'yes' : 'no'}</td>
                        <td>{col.defaultValue ?? <span className="cell-null">none</span>}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
            {table.indexes.length > 0 && (
              <div className="stack" style={{ marginTop: 10 }}>
                <div className="hint-text">Indexes</div>
                {table.indexes.map((idx) => (
                  <div key={idx.name} className="mono hint-text">
                    {idx.name}
                    {idx.unique ? ' (unique)' : ''}: {idx.definition}
                  </div>
                ))}
              </div>
            )}
          </div>
        ))
      )}
    </div>
  )
}
