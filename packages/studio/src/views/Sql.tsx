import { useEffect, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import * as api from '../api.js'
import { formatSince } from '../lib/format.js'
import { useResource } from '../lib/useResource.js'
import { useWakeAwareRun } from '../lib/useWaking.js'
import { WakingBanner } from '../components/WakingBanner.js'
import { Modal } from '../components/Modal.js'
import { Workbench } from '../components/Workbench.js'
import { State } from '../components/State.js'
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

export function Sql({ projectName, resourceName, onChanged }: { projectName: string; resourceName: string; onChanged?: () => void }) {
  const { resource, error: resourceError, refresh } = useResource(projectName, resourceName)
  const { snapshot, run } = useWakeAwareRun(() => {
    refresh()
    onChanged?.()
  })

  const [sql, setSql] = useState('')
  const [result, setResult] = useState<api.QueryResult | null>(null)
  const [queryError, setQueryError] = useState<string | null>(null)
  const [history, setHistory] = useState<HistoryEntry[]>([])
  const [snippets, setSnippets] = useState<Snippet[]>([])
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)
  const [namingSnippet, setNamingSnippet] = useState(false)
  const [pane, setPane] = useState<'saved' | 'history'>('history')
  const [ranMs, setRanMs] = useState<number | null>(null)

  useEffect(() => {
    if (resource === null) return
    setHistory(loadHistory(window.localStorage, resource.id))
    setSnippets(loadSnippets(window.localStorage))
  }, [resource?.id])

  async function handleRun(): Promise<void> {
    const startedAt = Date.now()
    if (resource === null || sql.trim().length === 0) return
    setQueryError(null)
    try {
      const queryResult = await run(resource.id, resource.state, () => api.runQuery(resource.id, sql))
      setResult(queryResult)
      setRanMs(Date.now() - startedAt)
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
    <Workbench
      sidebar={
        <>
          <div className="wb-side-head">
            <span className="wb-side-title">SQL</span>
          </div>
          <div className="wb-side-search">
            <div className="segmented" role="group" aria-label="Show saved or history">
              <button type="button" className="segment" aria-pressed={pane === 'saved'} onClick={() => setPane('saved')}>
                Saved
              </button>
              <button type="button" className="segment" aria-pressed={pane === 'history'} onClick={() => setPane('history')}>
                History
              </button>
            </div>
          </div>
          <div className="wb-side-list">
            {pane === 'saved' ? (
              snippets.length === 0 ? (
                <div className="side-list-empty">Nothing saved yet</div>
              ) : (
                snippets.map((snippet) => (
                  <div key={snippet.id} className="q-item">
                    <button type="button" className="q-open" onClick={() => loadIntoEditor(snippet.sql)}>
                      <span className="q-name">{snippet.name}</span>
                      <span className="q-sql">{snippet.sql.replace(/\s+/g, ' ').slice(0, 52)}</span>
                    </button>
                    <button
                      type="button"
                      className="side-list-remove"
                      aria-label={`Delete snippet ${snippet.name}`}
                      onClick={() => handleDeleteSnippet(snippet.id)}
                    >
                      <svg width="11" height="11" viewBox="0 0 11 11" fill="none" aria-hidden="true">
                        <path d="M2 2l7 7M9 2l-7 7" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
                      </svg>
                    </button>
                  </div>
                ))
              )
            ) : history.length === 0 ? (
              <div className="side-list-empty">No queries run yet</div>
            ) : (
              history.map((entry) => (
                <button
                  type="button"
                  key={entry.id}
                  className="q-open"
                  onClick={() => loadIntoEditor(entry.sql)}
                  title={entry.sql}
                >
                  <span className="q-sql q-sql-lead">
                    {!entry.ok && <span className="dot-failed" aria-label="Failed" />}
                    {entry.sql.replace(/\s+/g, ' ').slice(0, 52)}
                  </span>
                  <span className="q-time">{formatSince(entry.ranAt)}</span>
                </button>
              ))
            )}
          </div>
        </>
      }
    >
      {namingSnippet && <SnippetNameModal onClose={() => setNamingSnippet(false)} onSave={commitSnippet} />}
      <WakingBanner resourceName={resourceName} snapshot={snapshot} />

      <div className="editor-pane">
        <textarea
          ref={textareaRef}
          className="sql-editor"
          placeholder="select * from ..."
          value={sql}
          onChange={(event) => setSql(event.target.value)}
          onKeyDown={handleKeyDown}
          spellCheck={false}
        />
      </div>

      {/* Where Neon says "Ready to connect", we can say the thing we actually
          know: whether this database is awake, and that running will wake it. */}
      <div className="editor-bar">
        <State state={resource.state} />
        {resource.state !== 'running' && <span className="dim">Running a query will wake it</span>}
        <div className="row" style={{ marginLeft: 'auto', gap: 8 }}>
          {ranMs !== null && <span className="grid-timing">{ranMs}ms</span>}
          <button type="button" className="btn btn-sm" disabled={sql.trim().length === 0} onClick={handleSaveSnippet}>
            Save snippet
          </button>
          <button
            type="button"
            className="btn btn-sm btn-primary"
            disabled={sql.trim().length === 0}
            onClick={() => void handleRun()}
          >
            Run <kbd>{navigator.platform.includes('Mac') ? '\u2318' : 'Ctrl'}</kbd>
            <kbd>{'\u21B5'}</kbd>
          </button>
        </div>
      </div>

      <div className="result-pane">
        {queryError !== null && <div className="error-banner">{queryError}</div>}
        {queryError === null && result === null && (
          <div className="result-idle">Results appear here once you run something.</div>
        )}
        {result !== null && (
          <>
            <div className="result-summary">
              {result.command} · {result.rowCount} row{result.rowCount === 1 ? '' : 's'}
            </div>
            {result.rows.length > 0 && (
              <div className="table-scroll">
                <table className="data-table grid-table">
                  <thead>
                    <tr>
                      {result.columns.map((col) => (
                        <th key={col.name}>
                          <span className="col-name">{col.name}</span>
                          <span className="col-type">{col.dataType}</span>
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {result.rows.map((row, i) => (
                      <tr key={i}>
                        {result.columns.map((col) => (
                          <td key={col.name}>
                            {row[col.name] === null ? (
                              <span className="cell-null">NULL</span>
                            ) : (
                              <span className="cell-value" title={String(row[col.name])}>
                                {String(row[col.name])}
                              </span>
                            )}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
      </div>
    </Workbench>
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
