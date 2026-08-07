import type { ReactNode } from 'react'

// The shell every database view shares: an optional index panel and a main
// area that owns the rest of the viewport. Navigation between Tables, SQL and
// Schema lives in the app rail, nested under the database it belongs to, so
// this panel carries only the index the view itself needs.

export function Workbench({ sidebar, children }: { sidebar?: ReactNode; children: ReactNode }) {
  return (
    <div className="workbench">
      <div className="workbench-body">
        {sidebar !== undefined && <aside className="wb-side">{sidebar}</aside>}
        <section className="wb-main">{children}</section>
      </div>
    </div>
  )
}
