import { useCallback, useEffect, useState } from 'react'
import type { Project as ProjectModel, Resource } from '@hobby.sh/core'
import * as api from '../api.js'
import { navigate } from '../lib/router.js'
import { formatBytes, formatSince, readStats } from '../lib/format.js'
import { State } from '../components/State.js'

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
        setError(err instanceof api.ApiError ? err.message : 'could not reach the daemon'),
      )
  }, [projectName])

  useEffect(load, [load])

  const refresh = useCallback(() => {
    load()
    onChanged()
  }, [load, onChanged])

  if (error !== null) {
    return (
      <div className="page">
        <div className="notice notice-danger">{error}</div>
      </div>
    )
  }

  if (resources === null || project === null) {
    return (
      <div className="page">
        <span className="dim">loading</span>
      </div>
    )
  }

  const idleMinutes = project.sleepAfterSeconds === null ? null : Math.round(project.sleepAfterSeconds / 60)

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1 className="page-title">{project.name}</h1>
          <p className="page-sub">
            {idleMinutes === null
              ? 'pinned awake, never sleeps on its own'
              : `sleeps after ${idleMinutes} minute${idleMinutes === 1 ? '' : 's'} with nothing connected`}
          </p>
        </div>
        <div className="page-actions">
          <DestroyProject name={project.name} onDone={onChanged} />
        </div>
      </div>

      <h2 className="section-title">databases</h2>

      {resources.length === 0 ? (
        <div className="empty">
          <h3>no databases in this project</h3>
          <p>a project with no database has nothing to connect to yet.</p>
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
      setActionError(err instanceof api.ApiError ? err.message : `failed to ${kind}`)
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
      setActionError(err instanceof api.ApiError ? err.message : 'could not read the connection string')
    }
  }

  return (
    <div className="card">
      <div className="db-head">
        <div style={{ minWidth: 0 }}>
          <div className="card-title">{resource.name}</div>
          <div className="card-meta">
            postgres · {formatBytes(stats.sizeBytes)} · {stats.connectionCount ?? 0} connection
            {(stats.connectionCount ?? 0) === 1 ? '' : 's'} · active {formatSince(stats.lastActiveAt)}
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
            {copied ? 'copied' : 'copy'}
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
          tables
        </a>
        <a className="btn btn-sm btn-ghost" href={`${base}/sql`}>
          sql
        </a>
        <a className="btn btn-sm btn-ghost" href={`${base}/schema`}>
          schema
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

  if (!open) {
    return (
      <button type="button" className="btn btn-danger" onClick={() => setOpen(true)}>
        delete project
      </button>
    )
  }

  return (
    <div className="panel" style={{ minWidth: 300 }}>
      <p style={{ margin: '0 0 10px', fontSize: 13 }}>
        this destroys the database and its data directory. type <strong>{name}</strong> to confirm.
      </p>
      <input
        className="input"
        value={typed}
        autoFocus
        onChange={(e) => setTyped(e.target.value)}
        aria-label={`type ${name} to confirm`}
      />
      {error !== null && <div className="notice notice-danger" style={{ marginTop: 10 }}>{error}</div>}
      <div className="row" style={{ marginTop: 10 }}>
        <button
          type="button"
          className="btn btn-danger"
          disabled={typed !== name || busy}
          onClick={() => {
            setBusy(true)
            api
              .deleteProject(name, { force: true })
              .then(() => {
                onDone()
                navigate('/')
              })
              .catch((err: unknown) =>
                setError(err instanceof api.ApiError ? err.message : 'could not delete'),
              )
              .finally(() => setBusy(false))
          }}
        >
          {busy && <span className="spinner" />}
          delete
        </button>
        <button type="button" className="btn btn-ghost" onClick={() => setOpen(false)} disabled={busy}>
          cancel
        </button>
      </div>
    </div>
  )
}
