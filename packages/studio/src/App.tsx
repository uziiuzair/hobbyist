import { useCallback, useEffect, useState } from 'react'
import * as api from './api.js'
import { navigate, useHashRoute } from './lib/router.js'
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

  useEffect(() => {
    api
      .session()
      .then((result) => setSession(result.authenticated ? 'authenticated' : 'anonymous'))
      .catch(() => setSession('anonymous'))
  }, [])

  const handleLoggedIn = useCallback(() => {
    setSession('authenticated')
    navigate('/')
  }, [])

  const handleLogout = useCallback(() => {
    api
      .logout()
      .catch(() => {
        // Logging out is best-effort client side regardless: drop the
        // local session view so the login gate reappears either way.
      })
      .finally(() => {
        setSession('anonymous')
        navigate('/')
      })
  }, [])

  if (session === 'checking') {
    return (
      <div className="login-shell">
        <span className="hint-text">Loading Studio...</span>
      </div>
    )
  }

  if (session === 'anonymous') {
    return <Login onLoggedIn={handleLoggedIn} />
  }

  return (
    <div className="app-shell">
      <Topbar segments={segments} onLogout={handleLogout} />
      <div className="main">
        <Router segments={segments} />
      </div>
    </div>
  )
}

function Topbar({ segments, onLogout }: { segments: string[]; onLogout: () => void }) {
  const project = segments[0] === 'projects' ? segments[1] : undefined
  const resource = segments[2] === 'resources' ? segments[3] : undefined

  return (
    <header className="topbar">
      <a href="#/" className="topbar-brand">
        Hobbyist Studio
      </a>
      <nav className="topbar-crumbs">
        {project !== undefined && (
          <>
            <span>/</span>
            <a href={`#/projects/${encodeURIComponent(project)}`}>{project}</a>
          </>
        )}
        {resource !== undefined && (
          <>
            <span>/</span>
            <span>{resource}</span>
          </>
        )}
      </nav>
      <div className="topbar-spacer" />
      <button type="button" className="btn btn-small" onClick={onLogout}>
        Log out
      </button>
    </header>
  )
}

// Six views, matched by hand against a small, fixed set of hash shapes.
// Resources are addressed by name in the URL for legibility and resolved
// to an id by the view itself (via getProject), the same way the CLI
// resolves project/resource targets; see docs/cli/specs.
function Router({ segments }: { segments: string[] }) {
  if (segments.length === 0) {
    return <Projects />
  }

  if (segments[0] === 'projects' && segments[1] !== undefined) {
    const projectName = segments[1]

    if (segments.length === 2) {
      return <Project projectName={projectName} />
    }

    if (segments[2] === 'resources' && segments[3] !== undefined) {
      const resourceName = segments[3]
      const tab = segments[4]

      if (tab === 'tables') {
        return <Tables projectName={projectName} resourceName={resourceName} tableName={segments[5]} />
      }
      if (tab === 'sql') {
        return <Sql projectName={projectName} resourceName={resourceName} />
      }
      if (tab === 'schema') {
        return <Schema projectName={projectName} resourceName={resourceName} />
      }
    }
  }

  return (
    <div className="empty-state">
      Nothing here.
      <div style={{ marginTop: 8 }}>
        <a href="#/">Back to projects</a>
      </div>
    </div>
  )
}
