import type { ReactNode } from 'react'
import { useEffect, useRef, useState } from 'react'
import type { Project, Resource } from '@hobby.sh/core'
import { navigate } from '../lib/router.js'
import { stateClass, stateLabel } from './State.js'

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

// A browser window: the app kind serves pages.
function AppIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
      <rect x="1.5" y="2" width="11" height="10" rx="1.6" stroke="currentColor" strokeWidth="1.2" />
      <path d="M1.5 4.8h11" stroke="currentColor" strokeWidth="1.2" />
      <circle cx="3.4" cy="3.4" r="0.5" fill="currentColor" />
    </svg>
  )
}

// A bolt: the worker kind runs on demand and goes away.
function WorkerIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
      <path d="M7.8 1.5 3 8h3.4l-.9 4.5L10.8 6H7.4l.4-4.5Z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
    </svg>
  )
}

// The dot alone, pushed to the row's trailing edge. The state word still
// exists for screen readers: colour and shape are never the only carrier.
function RailDot({ state }: { state: string }) {
  return (
    <span className={`state rail-dot ${stateClass(state)}`}>
      <span className="dot" aria-hidden="true" />
      <span className="sr-only">{stateLabel(state)}</span>
    </span>
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

// The caret a Cloudflare style group carries: it points right when the group
// is closed and rotates down when it opens, so the rail reads as a tree that
// is currently folded rather than a list that mysteriously grew.
function Caret() {
  return (
    <svg className="caret" width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
      <path d="M3.5 1.5 7 5l-3.5 3.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

// A disclosure is a destination and a group at once: the label navigates, the
// caret folds. Splitting them means clicking "Databases" never surprises you
// by doing the other thing.
function Disclosure({
  open,
  onToggle,
  label,
}: {
  open: boolean
  onToggle: () => void
  label: string
}) {
  return (
    <button
      type="button"
      className={`rail-toggle${open ? ' is-open' : ''}`}
      aria-expanded={open}
      aria-label={`${open ? 'Collapse' : 'Expand'} ${label}`}
      onClick={onToggle}
    >
      <Caret />
    </button>
  )
}

export function Shell({
  projects,
  currentProject,
  currentSection,
  currentResource,
  currentView,
  wide,
  crumbs,
  onLogout,
  children,
}: {
  projects: RailProject[]
  currentProject?: string
  currentSection?: 'databases'
  currentResource?: string
  currentView?: RailSection
  wide?: boolean
  crumbs: ReactNode
  onLogout: () => void
  children: ReactNode
}) {
  const anyAwake = projects.some((row) => row.resources.some((r) => r.state === 'running'))
  const active = projects.find((row) => row.project.name === currentProject)
  const databases = active?.resources.filter((r) => r.kind === 'postgres') ?? []
  // The rail is generic over resource kind: a node is a kind, a name, a state.
  // Only postgres has inner views today, so apps and workers render as facts
  // rather than destinations, and their groups appear only when a project
  // actually holds one: a reader must never execute an aspiration.
  const apps = active?.resources.filter((r) => r.kind === 'app') ?? []
  const workers = active?.resources.filter((r) => r.kind === 'worker') ?? []

  // Each node remembers whether it was folded, falling back to a default the
  // route decides: the database you are inside starts open, the rest start
  // closed. Storing the override rather than seeding state from the route
  // matters, because the route changes on every click and would otherwise keep
  // reopening a group you deliberately folded.
  const [folds, setFolds] = useState<Record<string, boolean>>({})
  const isOpen = (key: string, fallback: boolean): boolean => folds[key] ?? fallback
  const toggle = (key: string, fallback: boolean) => () =>
    setFolds((prev) => ({ ...prev, [key]: !(prev[key] ?? fallback) }))

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
          <>
            <div className="rail-group">
              <div className="rail-label">Project</div>
              <a
                className="rail-link"
                href={`#/projects/${encodeURIComponent(currentProject)}`}
                aria-current={currentSection === 'databases' && currentResource === undefined ? 'page' : undefined}
              >
                <GridIcon />
                Overview
              </a>
            </div>

            {/* Cloudflare's rail is a tree you can fold, not a list that
                changes shape as you navigate. Every database is present at
                every moment, and its views hang off it, so the rail answers
                "what else is in here" without making you leave the page you
                are on. */}
            {databases.length > 0 && (
              <div className="rail-group">
                <div className="rail-label">Databases</div>
                {databases.map((db) => {
                  const key = `db:${db.name}`
                  const here = db.name === currentResource
                  const open = isOpen(key, here)
                  const base = `#/projects/${encodeURIComponent(currentProject)}/resources/${encodeURIComponent(db.name)}`
                  return (
                    <div className="rail-node" key={db.name}>
                      <div className="rail-row">
                        <a className={`rail-link${here ? ' is-trail' : ''}`} href={`${base}/tables`}>
                          <DatabaseIcon />
                          <span className="rail-name">{db.name}</span>
                          <RailDot state={db.state} />
                        </a>
                        <Disclosure open={open} onToggle={toggle(key, here)} label={db.name} />
                      </div>
                      {open && (
                        <div className="rail-sub">
                          {DB_VIEWS.map((view) => (
                            <a
                              key={view.id}
                              className="rail-link rail-link-sub"
                              href={`${base}/${view.id}`}
                              aria-current={here && currentView === view.id ? 'page' : undefined}
                            >
                              {view.label}
                            </a>
                          ))}
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            )}

            {/* Apps and workers exist in the daemon since Phase 2. They have
                no Studio views yet, so each renders as a fact: kind, name,
                state. The group itself appears only when the project holds
                one. */}
            {apps.length > 0 && (
              <div className="rail-group">
                <div className="rail-label">Apps</div>
                {apps.map((r) => (
                  <div className="rail-item" key={r.name}>
                    <AppIcon />
                    <span className="rail-name">{r.name}</span>
                    <RailDot state={r.state} />
                  </div>
                ))}
              </div>
            )}
            {workers.length > 0 && (
              <div className="rail-group">
                <div className="rail-label">Workers</div>
                {workers.map((r) => (
                  <div className="rail-item" key={r.name}>
                    <WorkerIcon />
                    <span className="rail-name">{r.name}</span>
                    <RailDot state={r.state} />
                  </div>
                ))}
              </div>
            )}
          </>
        )}

        <div className="rail-foot">
          <button type="button" className="rail-link" onClick={onLogout} style={{ width: '100%', cursor: 'pointer', background: 'none', font: 'inherit', textAlign: 'left' }}>
            Sign out
          </button>
        </div>
      </nav>

      <div className="main">
        <header className="topbar">
          {/* The bar has to agree with the page beneath it. A full bleed
              workbench under a breadcrumb centred in the reading measure
              leaves the crumb floating over nothing. */}
          <div className={wide === true ? 'bleed' : 'measure'}>
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
