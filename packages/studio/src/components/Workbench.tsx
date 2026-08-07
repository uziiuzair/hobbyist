import type { ReactNode } from 'react'

// The shell every database view shares: a sidebar carrying navigation and
// whatever index that view needs, and a main area that owns the rest of the
// viewport. Navigation lives in the sidebar rather than as a tab strip above
// the content, so the grid starts at the top of the page and the full height
// is actually usable.

export type Section = 'tables' | 'sql' | 'schema'

const SECTIONS: Array<{ id: Section; label: string; icon: ReactNode }> = [
  {
    id: 'tables',
    label: 'Tables',
    icon: (
      <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
        <rect x="1.5" y="2" width="11" height="10" rx="1.5" stroke="currentColor" strokeWidth="1.2" />
        <path d="M1.5 5.5h11M5.5 5.5V12" stroke="currentColor" strokeWidth="1.2" />
      </svg>
    ),
  },
  {
    id: 'sql',
    label: 'SQL',
    icon: (
      <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
        <path d="M3 4.5 5.5 7 3 9.5M7 10h4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
        <rect x="1.5" y="1.5" width="11" height="11" rx="2" stroke="currentColor" strokeWidth="1.2" />
      </svg>
    ),
  },
  {
    id: 'schema',
    label: 'Schema',
    icon: (
      <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
        <rect x="1.5" y="1.5" width="4.5" height="4" rx="1" stroke="currentColor" strokeWidth="1.2" />
        <rect x="8" y="8.5" width="4.5" height="4" rx="1" stroke="currentColor" strokeWidth="1.2" />
        <path d="M3.75 5.5v3.5a1 1 0 0 0 1 1H8" stroke="currentColor" strokeWidth="1.2" />
      </svg>
    ),
  },
]

export function Workbench({
  projectName,
  resourceName,
  section,
  sidebar,
  children,
}: {
  projectName: string
  resourceName: string
  section: Section
  sidebar?: ReactNode
  children: ReactNode
}) {
  const base = `#/projects/${encodeURIComponent(projectName)}/resources/${encodeURIComponent(resourceName)}`

  return (
    <div className="workbench">
      <div className="workbench-body">
        <aside className="wb-side">
          <nav className="wb-nav" aria-label="Database views">
            {SECTIONS.map((entry) => (
              <a
                key={entry.id}
                className="wb-nav-link"
                href={`${base}/${entry.id}`}
                aria-current={entry.id === section ? 'page' : undefined}
              >
                {entry.icon}
                {entry.label}
              </a>
            ))}
          </nav>
          {sidebar}
        </aside>

        <section className="wb-main">{children}</section>
      </div>
    </div>
  )
}
