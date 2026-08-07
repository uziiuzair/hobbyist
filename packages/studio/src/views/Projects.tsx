import { useCallback, useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import type { Project, Resource } from '@hobby.sh/core'
import * as api from '../api.js'
import { navigate } from '../lib/router.js'
import { ResourceBadge, formatBytes } from '../components/ResourceBadge.js'

// GET /v1/projects returns bare Project rows: no resource, no state, no
// size, no connection count (see packages/core/src/types.ts). Everything
// this view needs beyond the name comes from GET /v1/projects/:name, one
// call per project, run in parallel. That is an existing route used N+1
// times, not an invented one; see the report for why a list-shaped route
// that embeds a resource summary would be worth adding once project counts
// grow past a screenful.
interface ProjectRow {
  project: Project
  resources: Resource[]
  error?: string
}

// sizeBytes and connectionCount are not yet part of Resource's wire shape
// (packages/core/src/types.ts has no such fields). Read them defensively
// off the JSON in case the daemon starts sending them before core's type
// catches up; render a dash otherwise. See the report.
interface ResourceStats {
  sizeBytes?: number
  connectionCount?: number
}

function asStats(resource: Resource): ResourceStats {
  return resource as unknown as ResourceStats
}

export function Projects() {
  const [rows, setRows] = useState<ProjectRow[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')
  const [createError, setCreateError] = useState<string | null>(null)

  const load = useCallback(() => {
    setLoadError(null)
    api
      .listProjects()
      .then(async ({ projects }) => {
        const detailed = await Promise.all(
          projects.map(async (project): Promise<ProjectRow> => {
            try {
              const detail = await api.getProject(project.name)
              return { project: detail.project, resources: detail.resources }
            } catch (err) {
              return { project, resources: [], error: err instanceof api.ApiError ? err.message : 'failed to load' }
            }
          })
        )
        setRows(detailed)
      })
      .catch((err: unknown) => {
        setLoadError(err instanceof api.ApiError ? err.message : 'could not reach the daemon')
        setRows([])
      })
  }, [])

  useEffect(() => {
    load()
  }, [load])

  async function handleCreate(event: FormEvent): Promise<void> {
    event.preventDefault()
    const name = newName.trim()
    if (name.length === 0 || creating) return
    setCreating(true)
    setCreateError(null)
    try {
      const { project } = await api.createProject(name)
      // Mirrors `hobby new`: a project alone is not the promise, a
      // project with a ready postgres resource is. See docs/cli/specs.
      await api.createResource(project.name, 'primary')
      setNewName('')
      load()
      navigate(`/projects/${encodeURIComponent(project.name)}`)
    } catch (err) {
      setCreateError(err instanceof api.ApiError ? err.message : 'failed to create project')
    } finally {
      setCreating(false)
    }
  }

  async function handleCopyConnection(resource: Resource): Promise<void> {
    try {
      const { connectionString } = await api.connectionString(resource.id)
      await navigator.clipboard.writeText(connectionString)
    } catch {
      // Clipboard access can be denied by the browser; there is nothing
      // useful to recover into beyond leaving the string uncopied.
    }
  }

  return (
    <div className="stack">
      <form className="card row" onSubmit={(event) => void handleCreate(event)}>
        <div className="field" style={{ flex: 1 }}>
          <label htmlFor="new-project">New project</label>
          <input
            id="new-project"
            className="input"
            placeholder="project name"
            value={newName}
            onChange={(event) => setNewName(event.target.value)}
          />
        </div>
        <button type="submit" className="btn btn-primary" disabled={creating || newName.trim().length === 0}>
          {creating ? 'Creating...' : 'Create'}
        </button>
      </form>
      {createError !== null && <div className="error-banner">{createError}</div>}
      {loadError !== null && <div className="error-banner">{loadError}</div>}

      {rows === null ? (
        <div className="hint-text">Loading projects...</div>
      ) : rows.length === 0 ? (
        <div className="empty-state">No projects yet. Create one above.</div>
      ) : (
        <div className="project-grid">
          {rows.map(({ project, resources, error }) => {
            const primary = resources[0]
            const stats = primary !== undefined ? asStats(primary) : undefined
            return (
              <div key={project.id} className="card project-card-wrap">
                <a className="project-card" href={`#/projects/${encodeURIComponent(project.name)}`}>
                  <div className="project-card-name">{project.name}</div>
                  <div className="project-card-meta">
                    {primary !== undefined ? (
                      <ResourceBadge state={primary.state} />
                    ) : (
                      <span className="hint-text">no resources</span>
                    )}
                    <span>{stats?.sizeBytes !== undefined ? formatBytes(stats.sizeBytes) : '-'}</span>
                    <span>{stats?.connectionCount !== undefined ? `${stats.connectionCount} conn` : '- conn'}</span>
                  </div>
                  {error !== undefined && <div className="error-text">{error}</div>}
                </a>
                {primary !== undefined && (
                  <button type="button" className="btn btn-small" onClick={() => void handleCopyConnection(primary)}>
                    Copy connection string
                  </button>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
