import { useMemo, useState } from 'react'
import type { FormEvent } from 'react'
import * as api from '../api.js'
import { navigate } from '../lib/router.js'
import { formatBytes, formatSince, readStats } from '../lib/format.js'
import { State, summarise } from '../components/State.js'
import { MachineStrip } from '../components/MachineStrip.js'
import { SpotCrate } from '../components/Spot.js'
import { Modal } from '../components/Modal.js'
import type { RailProject } from '../components/Shell.js'

interface Props {
  rows: RailProject[]
  freeBytes: number | null
  onChanged: () => void
}

type Filter = 'all' | 'awake' | 'sleeping'

export function Projects({ rows, freeBytes, onChanged }: Props) {
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<Filter>('all')
  const [creating, setCreating] = useState(false)

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return rows.filter((row) => {
      if (needle.length > 0 && !row.project.name.toLowerCase().includes(needle)) return false
      const awake = row.resources.some((r) => r.state === 'running')
      if (filter === 'awake') return awake
      if (filter === 'sleeping') return !awake
      return true
    })
  }, [rows, query, filter])

  const totals = useMemo(() => {
    const resources = rows.flatMap((row) => row.resources)
    return {
      databases: resources.length,
      awake: resources.filter((r) => r.state === 'running').length,
      bytes: resources.reduce((sum, r) => sum + (readStats(r).sizeBytes ?? 0), 0),
    }
  }, [rows])

  return (
    <div className="page measure">
      <MachineStrip awake={totals.awake} total={totals.databases} freeBytes={freeBytes} />
      <div className="page-head">
        <div>
          <h1 className="page-title">Projects</h1>
          <p className="page-sub">
            {rows.length === 0
              ? 'Nothing here yet'
              : `${rows.length} project${rows.length === 1 ? '' : 's'}, ${totals.awake} awake`}
          </p>
        </div>
        <div className="page-actions">
          <button type="button" className="btn btn-primary" onClick={() => setCreating(true)}>
            New project
          </button>
        </div>
      </div>

      {creating && (
        <NewProjectModal
          onClose={() => setCreating(false)}
          onCreated={(name) => {
            setCreating(false)
            onChanged()
            navigate(`/projects/${encodeURIComponent(name)}`)
          }}
        />
      )}

      <div className="projects-layout">
        <div>
          {rows.length > 0 && (
            <div className="row" style={{ marginBottom: 12 }}>
              <div className="search" style={{ flex: 1, maxWidth: 320 }}>
                <svg width="13" height="13" viewBox="0 0 13 13" fill="none" aria-hidden="true">
                  <circle cx="5.6" cy="5.6" r="3.9" stroke="currentColor" strokeWidth="1.3" />
                  <path d="M8.6 8.6 11.3 11.3" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
                </svg>
                <input
                  className="input"
                  placeholder="Search projects"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  aria-label="Search projects"
                />
              </div>
              <div className="segmented" role="group" aria-label="Filter by state">
                {(
                  [
                    ['all', 'All'],
                    ['awake', 'Awake'],
                    ['sleeping', 'Sleeping'],
                  ] as [Filter, string][]
                ).map(([value, label]) => (
                  <button
                    key={value}
                    type="button"
                    className="segment"
                    aria-pressed={filter === value}
                    onClick={() => setFilter(value)}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
          )}

          {rows.length === 0 ? (
            <div className="empty">
              <SpotCrate />
              <h3>No projects yet</h3>
              <p>
                A project holds your databases. Creating one gives you a Postgres and a
                connection string, and it goes to sleep on its own when nothing is using it.
              </p>
              <button type="button" className="btn btn-primary" style={{ marginTop: 14 }} onClick={() => setCreating(true)}>
                New project
              </button>
            </div>
          ) : visible.length === 0 ? (
            <div className="empty">
              <h3>Nothing matches</h3>
              <p>No project matches that search and filter.</p>
            </div>
          ) : (
            <div className="grid">
              {visible.map((row) => {
                const stats = row.resources.map((r) => readStats(r))
                const summary = summarise(row.resources.map((r) => r.state))
                const bytes = stats.reduce((sum, s) => sum + (s.sizeBytes ?? 0), 0)
                const lastActive = stats
                  .map((s) => s.lastActiveAt ?? null)
                  .filter((v): v is string => v !== null)
                  .sort()
                  .pop()
                return (
                  <a className={summary.state === 'running' ? 'card is-awake' : 'card'} key={row.project.id} href={`#/projects/${encodeURIComponent(row.project.name)}`}>
                    <div className="card-body">
                      {/* The project name is data, not chrome: validateName in core
                          enforces lowercase, so it is shown exactly as it is stored. */}
                      <div className="card-title">{row.project.name}</div>
                      <div className="card-meta">
                        {row.resources.length === 0
                          ? 'No services'
                          : `${row.resources.length} service${row.resources.length === 1 ? '' : 's'} · ${formatBytes(bytes)}`}
                      </div>
                    </div>
                    <div className="card-foot">
                      <State state={summary.state} label={summary.label} />
                      <span className="dim" style={{ marginLeft: 'auto', fontSize: 12 }}>
                        {formatSince(lastActive)}
                      </span>
                    </div>
                  </a>
                )
              })}
            </div>
          )}
        </div>

        {/* Where a hosted product shows plan quota, the honest local answer is
            the machine itself. These are the only capacity numbers that exist
            without inventing one: RAM headroom needs a daemon field that does
            not exist yet, so it is not shown rather than estimated. */}
        <aside className="panel capacity">
          <div className="panel-head">
            <span className="panel-title">This machine</span>
            <span className="panel-note">Live</span>
          </div>

          <div className="meter-row">
            <div className="meter-head">
              <span className="meter-label">Awake</span>
              <span className="meter-value">
                {totals.awake} <span className="of">of {totals.databases}</span>
              </span>
            </div>
            <div className="meter-track">
              <div
                className="meter-fill is-awake"
                style={{ width: totals.databases === 0 ? '0%' : `${(totals.awake / totals.databases) * 100}%` }}
              />
            </div>
          </div>

          <div className="meter-row">
            <div className="meter-head">
              <span className="meter-label">Data on disk</span>
              <span className="meter-value">{formatBytes(totals.bytes)}</span>
            </div>
          </div>

          <div className="meter-row">
            <div className="meter-head">
              <span className="meter-label">Disk free</span>
              <span className="meter-value">{freeBytes === null ? '--' : formatBytes(freeBytes)}</span>
            </div>
          </div>

          <p className="dim" style={{ margin: '12px 0 0', fontSize: 12, lineHeight: 1.45 }}>
            Sleeping databases use no memory and no CPU. They cost only the disk they sit on.
          </p>
        </aside>
      </div>
    </div>
  )
}

function NewProjectModal({ onClose, onCreated }: { onClose: () => void; onCreated: (name: string) => void }) {
  const [name, setName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  function submit(event: FormEvent): void {
    event.preventDefault()
    const trimmed = name.trim()
    if (trimmed.length === 0 || busy) return
    setBusy(true)
    setError(null)
    api
      .createProject(trimmed)
      .then(() => api.createResource(trimmed, 'primary'))
      .then(() => onCreated(trimmed))
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : String(err))
        setBusy(false)
      })
  }

  return (
    <Modal
      title="New project"
      description="A project holds your databases. This one starts with a Postgres named primary."
      onClose={busy ? () => undefined : onClose}
      footer={
        <>
          <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="submit" form="new-project-form" className="btn btn-primary" disabled={busy || name.trim().length === 0}>
            {busy && <span className="spinner" />}
            {busy ? 'Creating' : 'Create project'}
          </button>
        </>
      }
    >
      <form id="new-project-form" onSubmit={submit}>
        <div className="field">
          <label htmlFor="new-project-name">Name</label>
          <input
            id="new-project-name"
            className="input mono"
            value={name}
            placeholder="blog"
            spellCheck={false}
            autoComplete="off"
            onChange={(e) => setName(e.target.value)}
          />
          <p className="dim" style={{ margin: 0, fontSize: 12.5, lineHeight: 1.45 }}>
            Lowercase letters, numbers and dashes. This becomes the database name in your
            connection string.
          </p>
        </div>
        {error !== null && (
          <div className="notice notice-danger" style={{ marginTop: 12 }}>
            {error}
          </div>
        )}
      </form>
    </Modal>
  )
}
