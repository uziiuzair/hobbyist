import { useMemo, useState } from 'react'
import type { FormEvent } from 'react'
import * as api from '../api.js'
import { navigate } from '../lib/router.js'
import { formatBytes, formatSince, readStats } from '../lib/format.js'
import { State, summarise } from '../components/State.js'
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
  const [name, setName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

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

  function submit(event: FormEvent): void {
    event.preventDefault()
    const trimmed = name.trim()
    if (trimmed.length === 0) return
    setBusy(true)
    setError(null)
    api
      .createProject(trimmed)
      .then(() => api.createResource(trimmed, 'primary'))
      .then(() => {
        setCreating(false)
        setName('')
        onChanged()
        navigate(`/projects/${encodeURIComponent(trimmed)}`)
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setBusy(false))
  }

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1 className="page-title">projects</h1>
          <p className="page-sub">
            {rows.length === 0
              ? 'nothing here yet'
              : `${rows.length} project${rows.length === 1 ? '' : 's'}, ${totals.awake} awake`}
          </p>
        </div>
        <div className="page-actions">
          <button type="button" className="btn btn-primary" onClick={() => setCreating((v) => !v)}>
            new project
          </button>
        </div>
      </div>

      {creating && (
        <form className="panel" onSubmit={submit} style={{ marginBottom: 16, maxWidth: 460 }}>
          <div className="field">
            <label htmlFor="new-project">name</label>
            <input
              id="new-project"
              className="input"
              value={name}
              autoFocus
              placeholder="blog"
              onChange={(e) => setName(e.target.value)}
            />
            <p className="dim" style={{ margin: 0, fontSize: 12.5 }}>
              lowercase letters, numbers and dashes. this becomes the database name in your
              connection string.
            </p>
          </div>
          {error !== null && <div className="notice notice-danger" style={{ marginTop: 10 }}>{error}</div>}
          <div className="row" style={{ marginTop: 12 }}>
            <button type="submit" className="btn btn-primary" disabled={busy || name.trim().length === 0}>
              {busy && <span className="spinner" />}
              {busy ? 'creating' : 'create'}
            </button>
            <button type="button" className="btn btn-ghost" onClick={() => setCreating(false)} disabled={busy}>
              cancel
            </button>
          </div>
        </form>
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
                  placeholder="search projects"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  aria-label="search projects"
                />
              </div>
              <div className="segmented" role="group" aria-label="filter by state">
                {(['all', 'awake', 'sleeping'] as Filter[]).map((value) => (
                  <button
                    key={value}
                    type="button"
                    className="segment"
                    aria-pressed={filter === value}
                    onClick={() => setFilter(value)}
                  >
                    {value}
                  </button>
                ))}
              </div>
            </div>
          )}

          {rows.length === 0 ? (
            <div className="empty">
              <h3>no projects yet</h3>
              <p>
                a project holds your databases. creating one gives you a postgres and a
                connection string, and it goes to sleep on its own when nothing is using it.
              </p>
              <button type="button" className="btn btn-primary" style={{ marginTop: 14 }} onClick={() => setCreating(true)}>
                new project
              </button>
            </div>
          ) : visible.length === 0 ? (
            <div className="empty">
              <h3>nothing matches</h3>
              <p>no project matches that search and filter.</p>
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
                  <a className="card" key={row.project.id} href={`#/projects/${encodeURIComponent(row.project.name)}`}>
                    <div className="card-body">
                      <div className="card-title">{row.project.name}</div>
                      <div className="card-meta">
                        {row.resources.length === 0
                          ? 'no databases'
                          : `${row.resources.length} database${row.resources.length === 1 ? '' : 's'}, ${formatBytes(bytes)}`}
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
            <span className="panel-title">this machine</span>
            <span className="panel-note">live</span>
          </div>

          <div className="meter-row">
            <div className="meter-head">
              <span className="meter-label">awake</span>
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
              <span className="meter-label">data on disk</span>
              <span className="meter-value">{formatBytes(totals.bytes)}</span>
            </div>
          </div>

          <div className="meter-row">
            <div className="meter-head">
              <span className="meter-label">disk free</span>
              <span className="meter-value">{freeBytes === null ? '--' : formatBytes(freeBytes)}</span>
            </div>
          </div>

          <p className="dim" style={{ margin: '12px 0 0', fontSize: 12, lineHeight: 1.45 }}>
            sleeping databases use no memory and no cpu. they cost only the disk they sit on.
          </p>
        </aside>
      </div>
    </div>
  )
}
