import { useEffect, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import * as api from '../api.js'
import { useResource } from '../lib/useResource.js'
import { useWakeAwareRun } from '../lib/useWaking.js'
import { WakingBanner } from '../components/WakingBanner.js'
import { Modal } from '../components/Modal.js'
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
  const [namingSnippet, setNamingSnippet] = useState(false)

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

  // PRODUCT.md: every form lives in a modal. window.prompt is a form with no
  // styling, no validation and no escape from the browser's own chrome.
  function handleSaveSnippet(): void {
    if (sql.trim().length === 0) return
    setNamingSnippet(true)
  }

  function commitSnippet(name: string): void {
    const snippet: Snippet = { id: randomId(), name: name.trim(), sql, savedAt: new Date().toISOString() }
    setSnippets(saveSnippet(window.localStorage, snippet))
    setNamingSnippet(false)
  }

  function handleDeleteSnippet(id: string): void {
    setSnippets(deleteSnippet(window.localStorage, id))
  }

  function loadIntoEditor(text: string): void {
    setSql(text)
    textareaRef.current?.focus()
  }

  if (resourceError !== null) {
    return (
      <div className="page measure">
        <div className="error-banner">{resourceError}</div>
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

  return (
    <div className="page measure stack">
      <ResourceTabs projectName={projectName} resourceName={resourceName} active="sql" />
      <WakingBanner resourceName={resourceName} snapshot={snapshot} />

      {namingSnippet && <SnippetNameModal onClose={() => setNamingSnippet(false)} onSave={commitSnippet} />}

      <div className="sql-editor-shell">
        <div className="side-index">
          <div className="side-list">
            <div className="side-list-title">Snippets</div>
            {snippets.length === 0 && <div className="side-list-empty">Nothing saved yet</div>}
            {snippets.map((s) => (
              <div key={s.id} className="side-list-row">
                <button type="button" className="side-list-item mono" onClick={() => loadIntoEditor(s.sql)}>
                  <span>{s.name}</span>
                </button>
                <button
                  type="button"
                  className="side-list-remove"
                  aria-label={`Delete snippet ${s.name}`}
                  title="Delete snippet"
                  onClick={() => handleDeleteSnippet(s.id)}
                >
                  <svg width="11" height="11" viewBox="0 0 11 11" fill="none" aria-hidden="true">
                    <path d="M2 2l7 7M9 2l-7 7" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
                  </svg>
                </button>
              </div>
            ))}
          </div>

          <div className="side-list">
            <div className="side-list-title">History</div>
            {history.length === 0 && <div className="side-list-empty">No queries run yet</div>}
            {history.map((h) => (
              <button
                type="button"
                key={h.id}
                className="side-list-item mono"
                onClick={() => loadIntoEditor(h.sql)}
                title={h.sql}
              >
                {!h.ok && <span className="dot-failed" aria-label="Failed" />}
                <span>{h.sql.replace(/\s+/g, ' ').slice(0, 44)}</span>
              </button>
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
              Run
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

function SnippetNameModal({ onClose, onSave }: { onClose: () => void; onSave: (name: string) => void }) {
  const [name, setName] = useState('')
  return (
    <Modal
      title="Save snippet"
      description="Saved snippets live in this browser only. They are not stored on the server."
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button
            type="submit"
            form="snippet-name-form"
            className="btn btn-primary"
            disabled={name.trim().length === 0}
          >
            Save snippet
          </button>
        </>
      }
    >
      <form
        id="snippet-name-form"
        onSubmit={(event) => {
          event.preventDefault()
          if (name.trim().length > 0) onSave(name)
        }}
      >
        <div className="field">
          <label htmlFor="snippet-name">Name</label>
          <input
            id="snippet-name"
            className="input"
            value={name}
            autoComplete="off"
            onChange={(event) => setName(event.target.value)}
          />
        </div>
      </form>
    </Modal>
  )
}
