import { useCallback, useEffect, useState } from 'react'
import type { Project as ProjectModel, Resource } from '@hobby.sh/core'
import * as api from '../api.js'
import { ResourceBadge, formatBytes } from '../components/ResourceBadge.js'
import { WakingBanner } from '../components/WakingBanner.js'
import { useWakeAwareRun } from '../lib/useWaking.js'

interface ResourceStats {
  sizeBytes?: number
  connectionCount?: number
}

export function Project({ projectName }: { projectName: string }) {
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
      .catch((err: unknown) => {
        setError(err instanceof api.ApiError ? err.message : 'could not reach the daemon')
      })
  }, [projectName])

  useEffect(() => {
    load()
  }, [load])

  if (error !== null) {
    return <div className="error-banner">{error}</div>
  }

  if (project === null || resources === null) {
    return <div className="hint-text">Loading {projectName}...</div>
  }

  return (
    <div className="stack">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h2 style={{ margin: 0 }}>{project.name}</h2>
        <span className="hint-text">
          sleeps after {project.sleepAfterSeconds !== null ? `${project.sleepAfterSeconds}s idle` : 'never (manual only)'}
        </span>
      </div>

      {resources.length === 0 ? (
        <div className="empty-state">No resources in this project yet.</div>
      ) : (
        resources.map((resource) => <ResourceCard key={resource.id} projectName={projectName} resource={resource} onChanged={load} />)
      )}
    </div>
  )
}

function ResourceCard({
  projectName,
  resource,
  onChanged,
}: {
  projectName: string
  resource: Resource
  onChanged: () => void
}) {
  const [busy, setBusy] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const [connString, setConnString] = useState<string | null>(null)
  const [logsText, setLogsText] = useState<string | null>(null)
  const [logsOpen, setLogsOpen] = useState(false)
  const { snapshot, run } = useWakeAwareRun()

  const stats = resource as unknown as ResourceStats

  async function handleWake(): Promise<void> {
    setBusy(true)
    setActionError(null)
    try {
      await run(resource.id, resource.state, () => api.wakeResource(resource.id))
      onChanged()
    } catch (err) {
      setActionError(err instanceof api.ApiError ? err.message : 'failed to wake')
    } finally {
      setBusy(false)
    }
  }

  async function handleSleep(): Promise<void> {
    setBusy(true)
    setActionError(null)
    try {
      await api.sleepResource(resource.id)
      onChanged()
    } catch (err) {
      setActionError(err instanceof api.ApiError ? err.message : 'failed to sleep')
    } finally {
      setBusy(false)
    }
  }

  async function handleShowConnection(): Promise<void> {
    try {
      const { connectionString } = await api.connectionString(resource.id)
      setConnString(connectionString)
    } catch (err) {
      setActionError(err instanceof api.ApiError ? err.message : 'failed to load connection string')
    }
  }

  async function handleCopyConnection(): Promise<void> {
    const value = connString ?? (await api.connectionString(resource.id)).connectionString
    setConnString(value)
    await navigator.clipboard.writeText(value).catch(() => undefined)
  }

  async function handleToggleLogs(): Promise<void> {
    if (logsOpen) {
      setLogsOpen(false)
      return
    }
    setLogsOpen(true)
    try {
      const { logs } = await api.logs(resource.id, 200)
      setLogsText(logs)
    } catch (err) {
      setActionError(err instanceof api.ApiError ? err.message : 'failed to load logs')
    }
  }

  const base = `/projects/${encodeURIComponent(projectName)}/resources/${encodeURIComponent(resource.name)}`

  return (
    <div className="card stack">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <div className="row">
          <strong>{resource.name}</strong>
          <ResourceBadge state={resource.state} />
        </div>
        <div className="row">
          <button type="button" className="btn btn-small" disabled={busy || resource.state === 'running' || resource.state === 'starting'} onClick={() => void handleWake()}>
            Wake
          </button>
          <button
            type="button"
            className="btn btn-small"
            disabled={busy || resource.state === 'sleeping' || resource.state === 'stopping'}
            onClick={() => void handleSleep()}
          >
            Sleep
          </button>
        </div>
      </div>

      <WakingBanner resourceName={resource.name} snapshot={snapshot} />

      <div className="project-card-meta">
        <span>{stats.sizeBytes !== undefined ? formatBytes(stats.sizeBytes) : 'size unknown'}</span>
        <span>{stats.connectionCount !== undefined ? `${stats.connectionCount} connections` : 'connections unknown'}</span>
      </div>

      {actionError !== null && <div className="error-text">{actionError}</div>}

      <div className="stack">
        {connString === null ? (
          <button type="button" className="btn btn-small" onClick={() => void handleShowConnection()}>
            Show connection string
          </button>
        ) : (
          <div className="conn-string">
            <code>{connString}</code>
            <button type="button" className="btn btn-small" onClick={() => void handleCopyConnection()}>
              Copy
            </button>
          </div>
        )}
      </div>

      <div className="row">
        <a className="btn btn-small" href={`#${base}/tables`}>
          Tables
        </a>
        <a className="btn btn-small" href={`#${base}/sql`}>
          SQL
        </a>
        <a className="btn btn-small" href={`#${base}/schema`}>
          Schema
        </a>
        <button type="button" className="btn btn-small" onClick={() => void handleToggleLogs()}>
          {logsOpen ? 'Hide logs' : 'Show logs'}
        </button>
      </div>

      {logsOpen && (
        <pre className="mono" style={{ maxHeight: 240, overflow: 'auto', background: 'var(--bg-sunken)', padding: 10, borderRadius: 6, margin: 0 }}>
          {logsText ?? 'Loading logs...'}
        </pre>
      )}
    </div>
  )
}
