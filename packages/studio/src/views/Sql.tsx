import { useEffect, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import * as api from '../api.js'
import { useResource } from '../lib/useResource.js'
import { useWakeAwareRun } from '../lib/useWaking.js'
import { WakingBanner } from '../components/WakingBanner.js'
import { ResourceTabs } from '../components/ResourceTabs.js'
import {
  loadHistory,
  loadSnippets,
  pushHistory,
  saveSnippet,
  deleteSnippet,
  type HistoryEntry,
  type Snippet,
} from '../lib/sqlStorage.js'

function randomId(): string {
  return typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`
}

export function Sql({ projectName, resourceName }: { projectName: string; resourceName: string }) {
  const { resource, error: resourceError } = useResource(projectName, resourceName)
  const { snapshot, run } = useWakeAwareRun()

  const [sql, setSql] = useState('')
  const [result, setResult] = useState<api.QueryResult | null>(null)
  const [queryError, setQueryError] = useState<string | null>(null)
  const [history, setHistory] = useState<HistoryEntry[]>([])
  const [snippets, setSnippets] = useState<Snippet[]>([])
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)

  useEffect(() => {
    if (resource === null) return
    setHistory(loadHistory(window.localStorage, resource.id))
    setSnippets(loadSnippets(window.localStorage))
  }, [resource?.id])

  async function handleRun(): Promise<void> {
    if (resource === null || sql.trim().length === 0) return
    setQueryError(null)
    try {
      const queryResult = await run(resource.id, resource.state, () => api.runQuery(resource.id, sql))
      setResult(queryResult)
      const entry: HistoryEntry = { id: randomId(), resourceId: resource.id, sql, ranAt: new Date().toISOString(), ok: true }
      setHistory(pushHistory(window.localStorage, entry))
    } catch (err) {
      const message = err instanceof api.ApiError ? err.message : 'query failed'
      setQueryError(message)
      setResult(null)
      const entry: HistoryEntry = {
        id: randomId(),
        resourceId: resource.id,
        sql,
        ranAt: new Date().toISOString(),
        ok: false,
        errorMessage: message,
      }
      setHistory(pushHistory(window.localStorage, entry))
    }
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): void {
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
      event.preventDefault()
      void handleRun()
    }
  }

  function handleSaveSnippet(): void {
    if (sql.trim().length === 0) return
    const name = window.prompt('Snippet name')
    if (name === null || name.trim().length === 0) return
    const snippet: Snippet = { id: randomId(), name: name.trim(), sql, savedAt: new Date().toISOString() }
    setSnippets(saveSnippet(window.localStorage, snippet))
  }

  function handleDeleteSnippet(id: string): void {
    setSnippets(deleteSnippet(window.localStorage, id))
  }

  function loadIntoEditor(text: string): void {
    setSql(text)
    textareaRef.current?.focus()
  }

  if (resourceError !== null) {
    return <div className="error-banner">{resourceError}</div>
  }
  if (resource === null) {
    return <div className="hint-text">Loading {resourceName}...</div>
  }

  return (
    <div className="stack">
      <ResourceTabs projectName={projectName} resourceName={resourceName} active="sql" />
      <WakingBanner resourceName={resourceName} snapshot={snapshot} />

      <div className="sql-editor-shell">
        <div>
          <div className="side-list-title">Snippets</div>
          <div className="side-list">
            {snippets.length === 0 && <span className="hint-text">None saved yet.</span>}
            {snippets.map((s) => (
              <div key={s.id} className="side-list-item" onClick={() => loadIntoEditor(s.sql)}>
                <span>{s.name}</span>
                <button
                  type="button"
                  className="btn btn-small"
                  onClick={(event) => {
                    event.stopPropagation()
                    handleDeleteSnippet(s.id)
                  }}
                >
                  x
                </button>
              </div>
            ))}
          </div>

          <div className="side-list-title">History</div>
          <div className="side-list">
            {history.length === 0 && <span className="hint-text">No queries run yet.</span>}
            {history.map((h) => (
              <div key={h.id} className="side-list-item" onClick={() => loadIntoEditor(h.sql)} title={h.sql}>
                <span className={h.ok ? '' : 'error-text'}>{h.sql.slice(0, 40)}</span>
              </div>
            ))}
          </div>
        </div>

        <div className="stack">
          <textarea
            ref={textareaRef}
            className="input sql-editor"
            placeholder="select * from ..."
            value={sql}
            onChange={(event) => setSql(event.target.value)}
            onKeyDown={handleKeyDown}
            spellCheck={false}
          />
          <div className="row">
            <button type="button" className="btn btn-primary" disabled={sql.trim().length === 0} onClick={() => void handleRun()}>
              Run (Cmd/Ctrl + Enter)
            </button>
            <button type="button" className="btn" disabled={sql.trim().length === 0} onClick={handleSaveSnippet}>
              Save snippet
            </button>
          </div>

          {queryError !== null && <div className="error-banner">{queryError}</div>}

          {result !== null && (
            <div className="stack">
              <div className="hint-text">
                {result.command} - {result.rowCount} row{result.rowCount === 1 ? '' : 's'}
              </div>
              {result.rows.length > 0 && (
                <div className="table-scroll">
                  <table className="data-table">
                    <thead>
                      <tr>
                        {result.columns.map((col) => (
                          <th key={col.name}>
                            {col.name}
                            <span className="hint-text"> {col.dataType}</span>
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {result.rows.map((row, i) => (
                        <tr key={i}>
                          {result.columns.map((col) => (
                            <td key={col.name}>{row[col.name] === null ? <span className="cell-null">null</span> : String(row[col.name])}</td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
