import { useCallback, useEffect, useState } from 'react'
import type { Project as ProjectModel, Resource } from '@hobby.sh/core'
import * as api from '../api.js'
import { navigate } from '../lib/router.js'
import { formatBytes, formatSince, readStats } from '../lib/format.js'
import { State } from '../components/State.js'
import { Modal } from '../components/Modal.js'

export function Project({ projectName, onChanged }: { projectName: string; onChanged: () => void }) {
  const [project, setProject] = useState<ProjectModel | null>(null)
  const [resources, setResources] = useState<Resource[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(() => {
    api
      .getProject(projectName)
      .then((detail) => {
        setProject(detail.project)
        setResources(detail.resources)
        setError(null)
      })
      .catch((err: unknown) =>
        setError(err instanceof api.ApiError ? err.message : 'Could not reach the daemon'),
      )
  }, [projectName])

  useEffect(load, [load])

  const refresh = useCallback(() => {
    load()
    onChanged()
  }, [load, onChanged])

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
          <DestroyProject name={project.name} onDone={onChanged} />
        </div>
      </div>

      <h2 className="section-title">Databases</h2>

      {resources.length === 0 ? (
        <div className="empty">
          <h3>No databases in this project</h3>
          <p>A project with no database has nothing to connect to yet.</p>
        </div>
      ) : (
        <div className="stack">
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
  const [conn, setConn] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

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

  async function copy(): Promise<void> {
    try {
      const value = conn ?? (await api.connectionString(resource.id)).connectionString
      setConn(value)
      await navigator.clipboard.writeText(value)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1600)
    } catch (err) {
      setActionError(err instanceof api.ApiError ? err.message : 'Could not read the connection string')
    }
  }

  return (
    <div className="card">
      <div className="db-head">
        <div style={{ minWidth: 0 }}>
          <div className="card-title">{resource.name}</div>
          <div className="card-meta">
            Postgres · {formatBytes(stats.sizeBytes)} · {stats.connectionCount ?? 0} connection
            {(stats.connectionCount ?? 0) === 1 ? '' : 's'} · Active {formatSince(stats.lastActiveAt)}
          </div>
        </div>
        <State state={resource.state} />
        <div className="row" style={{ gap: 6 }}>
          {resource.state === 'running' ? (
            <button type="button" className="btn btn-sm" onClick={() => act('sleep')} disabled={busy !== null}>
              {busy === 'sleep' && <span className="spinner" />}
              sleep
            </button>
          ) : (
            <button type="button" className="btn btn-sm" onClick={() => act('wake')} disabled={busy !== null}>
              {busy === 'wake' && <span className="spinner" />}
              wake
            </button>
          )}
        </div>
      </div>

      <div className="db-conn">
        <div className="connstring">
          <code>{conn ?? `postgres://...@127.0.0.1:5432/${projectName}`}</code>
          <button type="button" className="btn btn-sm btn-ghost" onClick={copy}>
            {copied ? 'Copied' : 'Copy'}
          </button>
        </div>
      </div>

      {actionError !== null && (
        <div style={{ padding: '0 15px 12px' }}>
          <div className="notice notice-danger">{actionError}</div>
        </div>
      )}

      <div className="card-foot">
        <a className="btn btn-sm btn-ghost" href={`${base}/tables`}>
          Tables
        </a>
        <a className="btn btn-sm btn-ghost" href={`${base}/sql`}>
          SQL
        </a>
        <a className="btn btn-sm btn-ghost" href={`${base}/schema`}>
          Schema
        </a>
      </div>
    </div>
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
