import type { ReactNode } from "react";

// The shell every database view shares: the database's own view switcher, an
// optional index panel, and a main area that owns the rest of the viewport.
//
// The switcher used to live in the app rail, nested under the database it
// belonged to. It moved here when the rail stopped listing individual
// resources: a rail that shows sections rather than services has nowhere to
// hang three views of one database, and these three are a property of the
// database you are looking at rather than of the project.

export type WorkbenchView = "tables" | "sql" | "schema";

const VIEWS: Array<{ id: WorkbenchView; label: string }> = [
  { id: "tables", label: "Tables" },
  { id: "sql", label: "SQL" },
  { id: "schema", label: "Schema" },
];

export function Workbench({
  projectName,
  resourceName,
  view,
  sidebar,
  children,
}: {
  projectName: string;
  resourceName: string;
  view: WorkbenchView;
  sidebar?: ReactNode;
  children: ReactNode;
}) {
  const base = `#/projects/${encodeURIComponent(projectName)}/resources/${encodeURIComponent(resourceName)}`;

  return (
    <div className="workbench">
      <div className="wb-head">
        <span className="wb-head-name">{resourceName}</span>
        <nav className="wb-tabs" aria-label="database views">
          {VIEWS.map((entry) => (
            <a
              key={entry.id}
              className="wb-tab"
              href={`${base}/${entry.id}`}
              aria-current={view === entry.id ? "page" : undefined}
            >
              {entry.label}
            </a>
          ))}
        </nav>
      </div>
      <div className="workbench-body">
        {sidebar !== undefined && <aside className="wb-side">{sidebar}</aside>}
        <section className="wb-main">{children}</section>
      </div>
    </div>
  );
}
