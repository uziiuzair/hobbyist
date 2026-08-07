import { useCallback, useEffect, useState } from 'react'
import * as api from './api.js'
import { navigate, useHashRoute } from './lib/router.js'
import { Shell, Crumb } from './components/Shell.js'
import type { RailProject } from './components/Shell.js'
import { Login } from './views/Login.js'
import { Projects } from './views/Projects.js'
import { Project } from './views/Project.js'
import { Tables } from './views/Tables.js'
import { Sql } from './views/Sql.js'
import { Schema } from './views/Schema.js'

type SessionState = 'checking' | 'anonymous' | 'authenticated'

export function App() {
  const [session, setSession] = useState<SessionState>('checking')
  const segments = useHashRoute()

  // The rail and every page read one copy of the project list, so the
  // switcher can never disagree with the page it is sitting next to.
  const [rows, setRows] = useState<RailProject[] | null>(null)
  const [freeBytes, setFreeBytes] = useState<number | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)

  const load = useCallback(() => {
    api
      .listProjects()
      .then(async ({ projects }) => {
        const detailed = await Promise.all(
          projects.map(async (project): Promise<RailProject> => {
            try {
              const detail = await api.getProject(project.name)
              return { project: detail.project, resources: detail.resources }
            } catch {
              return { project, resources: [] }
            }
          }),
        )
        setRows(detailed)
        setLoadError(null)
      })
      .catch((err: unknown) => {
        setRows([])
        setLoadError(err instanceof Error ? err.message : String(err))
      })
    api
      .preflight()
      .then((report) => setFreeBytes(report.filesystem.freeBytes))
      .catch(() => setFreeBytes(null))
  }, [])

  useEffect(() => {
    api
      .session()
      .then((result) => setSession(result.authenticated ? 'authenticated' : 'anonymous'))
      .catch(() => setSession('anonymous'))
  }, [])

  useEffect(() => {
    if (session === 'authenticated') load()
  }, [session, load])

  const handleLoggedIn = useCallback(() => {
    setSession('authenticated')
    navigate('/')
  }, [])

  const handleLogout = useCallback(() => {
    api
      .logout()
      .catch(() => {
        // Best effort: drop the local session view either way so the gate returns.
      })
      .finally(() => {
        setSession('anonymous')
        setRows(null)
        navigate('/')
      })
  }, [])

  if (session === 'checking') {
    return (
      <div className="login-wrap">
        <span className="dim">Loading</span>
      </div>
    )
  }

  if (session === 'anonymous') return <Login onLoggedIn={handleLoggedIn} />

  const projectName = segments[0] === 'projects' ? segments[1] : undefined
  const resourceName = segments[2] === 'resources' ? segments[3] : undefined
  const tab = segments[4]

  return (
    <Shell
      projects={rows ?? []}
      currentProject={projectName}
      currentSection={projectName === undefined ? undefined : 'databases'}
      currentResource={resourceName}
      currentView={tab === 'tables' || tab === 'sql' || tab === 'schema' ? tab : undefined}
      crumbs={
        <>
          <Crumb href="#/" here={projectName === undefined}>
            Projects
          </Crumb>
          {projectName !== undefined && (
            <Crumb
              href={`#/projects/${encodeURIComponent(projectName)}`}
              here={resourceName === undefined}
            >
              {projectName}
            </Crumb>
          )}
          {resourceName !== undefined && <Crumb here>{resourceName}</Crumb>}
        </>
      }
      onLogout={handleLogout}
    >
      {loadError !== null && (
        <div className="page measure" style={{ paddingBottom: 0 }}>
          <div className="notice notice-danger">{loadError}</div>
        </div>
      )}
      {rows === null ? (
        <div className="page measure">
          <span className="dim">Loading</span>
        </div>
      ) : (
        <Route
          segments={segments}
          rows={rows}
          freeBytes={freeBytes}
          onChanged={load}
          projectName={projectName}
          resourceName={resourceName}
          tab={tab}
        />
      )}
    </Shell>
  )
}

function Route({
  rows,
  freeBytes,
  onChanged,
  projectName,
  resourceName,
  tab,
  segments,
}: {
  rows: RailProject[]
  freeBytes: number | null
  onChanged: () => void
  projectName?: string
  resourceName?: string
  tab?: string
  segments: string[]
}) {
  if (projectName === undefined) {
    return <Projects rows={rows} freeBytes={freeBytes} onChanged={onChanged} />
  }

  if (resourceName === undefined) {
    return <Project projectName={projectName} onChanged={onChanged} />
  }

  if (tab === 'tables') {
    return <Tables projectName={projectName} resourceName={resourceName} tableName={segments[5]} onChanged={onChanged} />
  }
  if (tab === 'sql') {
    return <Sql projectName={projectName} resourceName={resourceName} onChanged={onChanged} />
  }
  if (tab === 'schema') {
    return <Schema projectName={projectName} resourceName={resourceName} onChanged={onChanged} />
  }

  return <Project projectName={projectName} onChanged={onChanged} />
}
