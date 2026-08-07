import type { ReactNode } from 'react'
import { useEffect, useRef, useState } from 'react'
import type { Project, Resource } from '@hobby.sh/core'
import { navigate } from '../lib/router.js'

// The rail is the Cloudflare idea sized honestly to what exists. Cloudflare
// can carry four labelled groups because it has roughly fifteen destinations.
// Hobbyist has one service kind today, so the rail shows the project switcher,
// that project's services, and nothing invented. Compute and storage get
// groups when they get contents, not before: the repo rule is that a reader
// must never execute an aspiration.

export interface RailProject {
  project: Project
  resources: Resource[]
}

function Chevron() {
  return (
    <svg className="chev" width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
      <path d="M4 2.5 7.5 6 4 9.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function DatabaseIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
      <ellipse cx="7" cy="3.2" rx="4.6" ry="1.9" stroke="currentColor" strokeWidth="1.2" />
      <path d="M2.4 3.2v7.6c0 1.05 2.06 1.9 4.6 1.9s4.6-.85 4.6-1.9V3.2" stroke="currentColor" strokeWidth="1.2" />
      <path d="M2.4 7c0 1.05 2.06 1.9 4.6 1.9s4.6-.85 4.6-1.9" stroke="currentColor" strokeWidth="1.2" />
    </svg>
  )
}

function GridIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
      <rect x="1.5" y="1.5" width="4.5" height="4.5" rx="1" stroke="currentColor" strokeWidth="1.2" />
      <rect x="8" y="1.5" width="4.5" height="4.5" rx="1" stroke="currentColor" strokeWidth="1.2" />
      <rect x="1.5" y="8" width="4.5" height="4.5" rx="1" stroke="currentColor" strokeWidth="1.2" />
      <rect x="8" y="8" width="4.5" height="4.5" rx="1" stroke="currentColor" strokeWidth="1.2" />
    </svg>
  )
}

function ProjectSwitcher({ projects, current }: { projects: RailProject[]; current?: string }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (event: MouseEvent): void => {
      if (ref.current && !ref.current.contains(event.target as Node)) setOpen(false)
    }
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const label = current ?? 'All projects'

  return (
    <div className="switcher" ref={ref}>
      <button
        type="button"
        className="switcher-btn"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="name">{label}</span>
        <svg className="chev" width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
          <path d="M3.5 7.5 6 10l2.5-2.5M3.5 4.5 6 2l2.5 2.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {open && (
        <div className="switcher-menu" role="menu">
          <button
            type="button"
            className="switcher-item"
            role="menuitem"
            aria-current={current === undefined}
            onClick={() => {
              setOpen(false)
              navigate('/')
            }}
          >
            <GridIcon />
            All projects
          </button>
          {projects.map((row) => {
            const awake = row.resources.some((r) => r.state === 'running')
            return (
              <button
                key={row.project.id}
                type="button"
                className="switcher-item"
                role="menuitem"
                aria-current={row.project.name === current}
                onClick={() => {
                  setOpen(false)
                  navigate(`/projects/${encodeURIComponent(row.project.name)}`)
                }}
              >
                <span className={`state ${awake ? 'state-awake' : 'state-sleeping'}`}>
                  <span className="dot" />
                </span>
                {row.project.name}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

export type RailSection = 'tables' | 'sql' | 'schema'

const DB_VIEWS: Array<{ id: RailSection; label: string }> = [
  { id: 'tables', label: 'Tables' },
  { id: 'sql', label: 'SQL' },
  { id: 'schema', label: 'Schema' },
]

export function Shell({
  projects,
  currentProject,
  currentSection,
  currentResource,
  currentView,
  crumbs,
  onLogout,
  children,
}: {
  projects: RailProject[]
  currentProject?: string
  currentSection?: 'databases'
  currentResource?: string
  currentView?: RailSection
  crumbs: ReactNode
  onLogout: () => void
  children: ReactNode
}) {
  const anyAwake = projects.some((row) => row.resources.some((r) => r.state === 'running'))
  const active = projects.find((row) => row.project.name === currentProject)
  const databases = active?.resources.filter((r) => r.kind === 'postgres') ?? []

  return (
    <div className="shell">
      <nav className="rail" aria-label="main">
        <a className="rail-brand" href="#/">
          <span className={`rail-mark${anyAwake ? ' is-awake' : ''}`} aria-hidden="true">
            <i />
          </span>
          Hobbyist
        </a>

        <ProjectSwitcher projects={projects} current={currentProject} />

        {currentProject === undefined ? (
          <div className="rail-group">
            <div className="rail-label">Organisation</div>
            <a className="rail-link" href="#/" aria-current="page">
              <GridIcon />
              Projects
              <span className="count">{projects.length}</span>
            </a>
          </div>
        ) : (
          <div className="rail-group">
            <div className="rail-label">Services</div>
            <a
              className="rail-link"
              href={`#/projects/${encodeURIComponent(currentProject)}`}
              aria-current={currentSection === 'databases' && currentResource === undefined ? 'page' : undefined}
            >
              <DatabaseIcon />
              Databases
              <span className="count">{databases.length}</span>
            </a>

            {/* The database's own views nest under it, the way Neon nests
                Tables and SQL Editor under a Postgres database, rather than
                sitting as a tab strip above the content. They only appear
                once you are inside a database, because outside one they lead
                nowhere. */}
            {currentResource !== undefined && (
              <div className="rail-sub">
                {DB_VIEWS.map((view) => (
                  <a
                    key={view.id}
                    className="rail-link rail-link-sub"
                    href={`#/projects/${encodeURIComponent(currentProject)}/resources/${encodeURIComponent(currentResource)}/${view.id}`}
                    aria-current={currentView === view.id ? 'page' : undefined}
                  >
                    {view.label}
                  </a>
                ))}
              </div>
            )}
          </div>
        )}

        <div className="rail-foot">
          <button type="button" className="rail-link" onClick={onLogout} style={{ width: '100%', cursor: 'pointer', background: 'none', font: 'inherit', textAlign: 'left' }}>
            Sign out
          </button>
        </div>
      </nav>

      <div className="main">
        <header className="topbar">
          <div className="measure">
            <nav className="crumbs" aria-label="breadcrumb">
              {crumbs}
            </nav>
          </div>
        </header>
        {children}
      </div>
    </div>
  )
}

export function Crumb({ href, children, here }: { href?: string; children: ReactNode; here?: boolean }) {
  if (here === true || href === undefined) return <span className="here">{children}</span>
  return (
    <>
      <a href={href}>{children}</a>
      <Chevron />
    </>
  )
}
