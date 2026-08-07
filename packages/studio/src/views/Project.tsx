import { useCallback, useEffect, useMemo, useState } from 'react'
import type { FormEvent } from 'react'
import type { Project as ProjectModel, Resource } from '@hobby.sh/core'
import * as api from '../api.js'
import { navigate } from '../lib/router.js'
import { formatBytes, formatSince, readStats } from '../lib/format.js'
import { State } from '../components/State.js'
import { Modal } from '../components/Modal.js'
import { ActivityChart } from '../components/ActivityChart.js'
import type { Sample } from '../components/ActivityChart.js'
import { ConnectModal, ExportModal, ImportModal } from '../components/Connect.js'

// The dashboard answers four questions in the order they get asked: what is in
// here, what is it doing, how do I connect, and how do I get my data out.
//
// It is modelled on Neon's project dashboard and departs from it wherever the
// number underneath would have to be invented. There is no compute-hour figure
// because nothing is metered, no region because there is one box, and no
// retention window because nothing is retained. What replaces them is the
// machine itself: bytes on disk, connections right now, and the disk that is
// left. Those are the only capacity numbers that are true on hardware you own.

// The window matches the daemon's own idle threshold, so watching this chart
// is watching the sleep timer run.
const WINDOW_MS = 300_000
const POLL_MS = 5000

export function Project({ projectName, onChanged }: { projectName: string; onChanged: () => void }) {
  const [project, setProject] = useState<ProjectModel | null>(null)
  const [resources, setResources] = useState<Resource[] | null>(null)
  const [free, setFree] = useState<{ freeBytes: number; reflink: boolean } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [samples, setSamples] = useState<Record<string, Sample[]>>({})
  const [focus, setFocus] = useState<string | null>(null)
  const [dialog, setDialog] = useState<'connect' | 'export' | 'import' | 'new' | null>(null)

  // The sampler runs off the same fetch the page renders from, so the chart can
  // never disagree with the table beside it.
  const record = useCallback((rows: Resource[]) => {
    const at = Date.now()
    setSamples((prev) => {
      const next: Record<string, Sample[]> = {}
      for (const row of rows) {
        const stats = readStats(row)
        const kept = (prev[row.id] ?? []).filter((s) => at - s.at <= WINDOW_MS)
        kept.push({ at, connections: stats.connectionCount ?? 0, awake: row.state === 'running' })
        next[row.id] = kept
      }
      return next
    })
  }, [])

  const load = useCallback(() => {
    api
      .getProject(projectName)
      .then((detail) => {
        setProject(detail.project)
        setResources(detail.resources)
        record(detail.resources)
        setError(null)
      })
      .catch((err: unknown) =>
        setError(err instanceof api.ApiError ? err.message : 'Could not reach the daemon'),
      )
  }, [projectName, record])

  useEffect(load, [load])

  useEffect(() => {
    api
      .preflight()
      .then((report) => setFree({ freeBytes: report.filesystem.freeBytes, reflink: report.filesystem.reflinkSupported }))
      .catch(() => setFree(null))
  }, [])

  // Polling exists for the chart, and it stops when the tab is hidden: each
  // round trip asks a running Postgres for its size, and doing that every five
  // seconds against a database nobody is looking at is work for nothing.
  useEffect(() => {
    const tick = (): void => {
      if (document.visibilityState === 'visible') load()
    }
    const timer = window.setInterval(tick, POLL_MS)
    return () => window.clearInterval(timer)
  }, [load])

  const refresh = useCallback(() => {
    load()
    onChanged()
  }, [load, onChanged])

  const totals = useMemo(() => {
    const rows = resources ?? []
    const stats = rows.map((r) => readStats(r))
    return {
      databases: rows.length,
      awake: rows.filter((r) => r.state === 'running').length,
      bytes: stats.reduce((sum, s) => sum + (s.sizeBytes ?? 0), 0),
      connections: stats.reduce((sum, s) => sum + (s.connectionCount ?? 0), 0),
    }
  }, [resources])

  if (error !== null) {
    return (
      <div className="page measure">
        <div className="notice notice-danger">{error}</div>
      </div>
    )
  }

  if (resources === null || project === null) {
    return (
      <div className="page measure">
        <span className="dim">Loading</span>
      </div>
    )
  }

  const idleMinutes = project.sleepAfterSeconds === null ? null : Math.round(project.sleepAfterSeconds / 60)
  const selected = resources.find((r) => r.id === focus) ?? resources[0]

  return (
    <div className="page measure">
      <div className="page-head">
        <div>
          <h1 className="page-title">{project.name}</h1>
          <p className="page-sub">
            {idleMinutes === null
              ? 'Pinned awake, never sleeps on its own'
              : `Sleeps after ${idleMinutes} minute${idleMinutes === 1 ? '' : 's'} with nothing connected`}
          </p>
        </div>
        <div className="page-actions">
          {/* One selection governs the chart and the three buttons beside it,
              which is why it sits here rather than inside the Activity panel:
              a picker tucked into a card looks like it only steers that card. */}
          {resources.length > 1 && (
            <select
              className="select select-sm"
              aria-label="Selected database"
              value={selected?.id ?? ''}
              onChange={(e) => setFocus(e.target.value)}
            >
              {resources.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </select>
          )}
          <button
            type="button"
            className="btn"
            disabled={selected === undefined}
            onClick={() => setDialog('import')}
          >
            Import data
          </button>
          <button
            type="button"
            className="btn"
            disabled={selected === undefined}
            onClick={() => setDialog('export')}
          >
            Export
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={selected === undefined}
            onClick={() => setDialog('connect')}
          >
            Connect
          </button>
        </div>
      </div>

      <StatStrip totals={totals} free={free} />

      <div className="dash">
        <section className="panel">
          <div className="panel-head">
            <span className="panel-title">Activity</span>
            <span className="panel-note">
              {selected === undefined ? 'Last 5 minutes' : `${selected.name}, last 5 minutes`}
            </span>
          </div>

          {selected === undefined ? (
            <p className="dim" style={{ margin: 0, fontSize: 13 }}>
              Nothing to chart until this project has a database.
            </p>
          ) : (
            <>
              <ActivityChart samples={samples[selected.id] ?? []} windowMs={WINDOW_MS} />
              <p className="panel-foot">
                Sampled every {POLL_MS / 1000} seconds while this page is open, and kept nowhere else. Nothing
                writes a metrics history to your disk, so closing this tab starts the chart over.
              </p>
            </>
          )}
        </section>

        <div className="dash-side">
          <section className="panel">
            <div className="panel-head">
              <span className="panel-title">Databases</span>
              <button type="button" className="btn btn-sm" style={{ marginLeft: 'auto' }} onClick={() => setDialog('new')}>
                New database
              </button>
            </div>

            {resources.length === 0 ? (
              <p className="dim" style={{ margin: 0, fontSize: 13 }}>
                A project with no database has nothing to connect to yet.
              </p>
            ) : (
              <div className="db-list">
                {resources.map((resource) => (
                  <DatabaseRow
                    key={resource.id}
                    projectName={project.name}
                    resource={resource}
                    onChanged={refresh}
                  />
                ))}
              </div>
            )}
          </section>

          <section className="panel">
            <div className="panel-head">
              <span className="panel-title">Project</span>
            </div>

            <Row label="Sleeps after" value={idleMinutes === null ? 'Never' : `${idleMinutes} min idle`} />
            {selected !== undefined && <Row label="Postgres" value={selected.config.image} mono />}
            {selected !== undefined && <Row label="Data directory" value={selected.config.dataDir} mono />}
            <Row label="Network" value={project.networkName} mono />
            <Row
              label="Instant branching"
              value={free === null ? '--' : free.reflink ? 'Supported' : 'Copies instead'}
            />
            <Row label="Created" value={formatSince(String(project.createdAt))} />

            <div className="panel-danger">
              <div>
                <div className="danger-title">Delete this project</div>
                <p className="danger-note">Destroys the databases and their data directories on disk.</p>
              </div>
              <DestroyProject name={project.name} onDone={onChanged} />
            </div>
          </section>
        </div>
      </div>

      {dialog === 'connect' && selected !== undefined && (
        <ConnectModal resource={selected} onClose={() => setDialog(null)} />
      )}
      {dialog === 'export' && selected !== undefined && (
        <ExportModal resource={selected} projectName={project.name} onClose={() => setDialog(null)} />
      )}
      {dialog === 'import' && selected !== undefined && (
        <ImportModal resource={selected} onClose={() => setDialog(null)} />
      )}
      {dialog === 'new' && (
        <NewDatabaseModal
          projectName={project.name}
          onClose={() => setDialog(null)}
          onCreated={() => {
            setDialog(null)
            refresh()
          }}
        />
      )}
    </div>
  )
}

function StatStrip({
  totals,
  free,
}: {
  totals: { databases: number; awake: number; bytes: number; connections: number }
  free: { freeBytes: number; reflink: boolean } | null
}) {
  return (
    <div className="stats">
      <div className="stat-row">
        <Stat label="Databases" value={String(totals.databases)} />
        <Stat label="Awake" value={`${totals.awake}`} unit={`of ${totals.databases}`} live={totals.awake > 0} />
        <Stat label="Data on disk" value={formatBytes(totals.bytes)} />
        <Stat label="Connections" value={String(totals.connections)} />
        <Stat label="Disk free" value={free === null ? '--' : formatBytes(free.freeBytes)} />
      </div>
      <p className="stats-note">
        Read from this machine, right now. Size comes from a running database; a sleeping one reports the last
        figure the daemon saw, because waking it to answer would defeat the point.
      </p>
    </div>
  )
}

function Stat({ label, value, unit, live }: { label: string; value: string; unit?: string; live?: boolean }) {
  return (
    <div className="stat">
      <div className="stat-label">{label}</div>
      <div className={`stat-value${live === true ? ' is-live' : ''}`}>
        {value}
        {unit !== undefined && <span className="stat-unit">{unit}</span>}
      </div>
    </div>
  )
}

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="kv">
      <span className="kv-label">{label}</span>
      <span className={`kv-value${mono === true ? ' mono' : ''}`} title={value}>
        {value}
      </span>
    </div>
  )
}

function DatabaseRow({
  projectName,
  resource,
  onChanged,
}: {
  projectName: string
  resource: Resource
  onChanged: () => void
}) {
  const [busy, setBusy] = useState<'wake' | 'sleep' | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)

  const stats = readStats(resource)
  const base = `#/projects/${encodeURIComponent(projectName)}/resources/${encodeURIComponent(resource.name)}`

  async function act(kind: 'wake' | 'sleep'): Promise<void> {
    setBusy(kind)
    setActionError(null)
    try {
      if (kind === 'wake') await api.wakeResource(resource.id)
      else await api.sleepResource(resource.id)
      onChanged()
    } catch (err) {
      setActionError(err instanceof api.ApiError ? err.message : `Could not ${kind} this database`)
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="db-row">
      <div className="db-row-main">
        <a className="db-name" href={`${base}/tables`}>
          {resource.name}
        </a>
        <State state={resource.state} />
      </div>

      <div className="db-row-meta">
        <span>{formatBytes(stats.sizeBytes)}</span>
        <span>
          {stats.connectionCount ?? 0} connection{(stats.connectionCount ?? 0) === 1 ? '' : 's'}
        </span>
        <span>Last active {formatSince(stats.lastActiveAt)}</span>
        <button
          type="button"
          className="btn btn-sm btn-ghost"
          style={{ marginLeft: 'auto' }}
          onClick={() => act(resource.state === 'running' ? 'sleep' : 'wake')}
          disabled={busy !== null}
        >
          {busy !== null && <span className="spinner" />}
          {resource.state === 'running' ? 'Sleep' : 'Wake'}
        </button>
      </div>

      {actionError !== null && <div className="notice notice-danger">{actionError}</div>}
    </div>
  )
}

function NewDatabaseModal({
  projectName,
  onClose,
  onCreated,
}: {
  projectName: string
  onClose: () => void
  onCreated: () => void
}) {
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
      .createResource(projectName, trimmed)
      .then(() => onCreated())
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : String(err))
        setBusy(false)
      })
  }

  return (
    <Modal
      title="New database"
      description="A second Postgres in this project, with its own data directory and its own sleep clock."
      onClose={busy ? () => undefined : onClose}
      footer={
        <>
          <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button
            type="submit"
            form="new-database-form"
            className="btn btn-primary"
            disabled={busy || name.trim().length === 0}
          >
            {busy && <span className="spinner" />}
            {busy ? 'Creating' : 'Create database'}
          </button>
        </>
      }
    >
      <form id="new-database-form" onSubmit={submit}>
        <div className="field">
          <label htmlFor="new-database-name">Name</label>
          <input
            id="new-database-name"
            className="input mono"
            value={name}
            placeholder="analytics"
            spellCheck={false}
            autoComplete="off"
            onChange={(e) => setName(e.target.value)}
          />
          <p className="field-hint">Lowercase letters, numbers and dashes.</p>
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

function DestroyProject({ name, onDone }: { name: string; onDone: () => void }) {
  const [open, setOpen] = useState(false)
  const [typed, setTyped] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  function destroy(): void {
    setBusy(true)
    setError(null)
    api
      .deleteProject(name, { force: true })
      .then(() => {
        onDone()
        navigate('/')
      })
      .catch((err: unknown) => {
        setError(err instanceof api.ApiError ? err.message : 'Could not delete this project')
        setBusy(false)
      })
  }

  return (
    <>
      <button type="button" className="btn btn-danger" onClick={() => setOpen(true)}>
        Delete project
      </button>

      {open && (
        <Modal
          title="Delete this project"
          description="This destroys the database and its data directory on disk. It cannot be undone."
          onClose={busy ? () => undefined : () => setOpen(false)}
          footer={
            <>
              <button type="button" className="btn btn-ghost" onClick={() => setOpen(false)} disabled={busy}>
                Cancel
              </button>
              <button type="button" className="btn btn-danger" disabled={typed !== name || busy} onClick={destroy}>
                {busy && <span className="spinner" />}
                {busy ? 'Deleting' : 'Delete project'}
              </button>
            </>
          }
        >
          <div className="field">
            <label htmlFor="confirm-delete">
              Type <span className="mono">{name}</span> to confirm
            </label>
            <input
              id="confirm-delete"
              className="input mono"
              value={typed}
              spellCheck={false}
              autoComplete="off"
              onChange={(e) => setTyped(e.target.value)}
            />
          </div>
          {error !== null && (
            <div className="notice notice-danger" style={{ marginTop: 12 }}>
              {error}
            </div>
          )}
        </Modal>
      )}
    </>
  )
}
