/**
 * App Shell
 *
 * @author Uzair Hayat <business@uziiuzair.com>
 *
 * Last updated: Aug 16, 2026
 */

import type { ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import type {
  Project,
  Resource,
  ResourceKind,
  WorkerResource,
} from "@hobby.sh/core";
import { navigate } from "../lib/router.js";
import { stateClass, stateLabel } from "./State.js";
import { Wrapper } from "./reusable/wrapper.js";
import { Button } from "./reusable/button.js";
import { Badge } from "./reusable/badge.js";
import { ACCOUNT_NAV, PROJECT_NAV } from "../nav.js";
import type { NavItem } from "../nav.js";

// The rail is the Cloudflare idea, and it now carries the same thing
// Cloudflare's does: the whole product, not the part of it that is finished.
// What it does not borrow is the silence. Cloudflare can list fifteen
// destinations because all fifteen work; here some of them are empty rooms,
// so every one that is not built is marked Soon on the row and says what it
// is and what it is not on the page it opens. The map lives in nav.ts, which
// is also what the router resolves against, so a destination cannot appear in
// the rail without a page behind it that admits its own state.

export interface RailProject {
  project: Project;
  resources: Resource[];
}

function Chevron() {
  return (
    <svg
      className="chev"
      width="12"
      height="12"
      viewBox="0 0 12 12"
      fill="none"
      aria-hidden="true"
    >
      <path
        d="M4 2.5 7.5 6 4 9.5"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function DatabaseIcon() {
  return (
    <svg
      className="ic-sage"
      width="14"
      height="14"
      viewBox="0 0 14 14"
      fill="none"
      aria-hidden="true"
    >
      <ellipse
        cx="7"
        cy="3.2"
        rx="4.6"
        ry="1.9"
        stroke="currentColor"
        strokeWidth="1.2"
      />
      <path
        d="M2.4 3.2v7.6c0 1.05 2.06 1.9 4.6 1.9s4.6-.85 4.6-1.9V3.2"
        stroke="currentColor"
        strokeWidth="1.2"
      />
      <path
        d="M2.4 7c0 1.05 2.06 1.9 4.6 1.9s4.6-.85 4.6-1.9"
        stroke="currentColor"
        strokeWidth="1.2"
      />
    </svg>
  );
}

function GridIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 14 14"
      fill="none"
      aria-hidden="true"
    >
      <rect
        x="1.5"
        y="1.5"
        width="4.5"
        height="4.5"
        rx="1"
        stroke="currentColor"
        strokeWidth="1.2"
      />
      <rect
        x="8"
        y="1.5"
        width="4.5"
        height="4.5"
        rx="1"
        stroke="currentColor"
        strokeWidth="1.2"
      />
      <rect
        x="1.5"
        y="8"
        width="4.5"
        height="4.5"
        rx="1"
        stroke="currentColor"
        strokeWidth="1.2"
      />
      <rect
        x="8"
        y="8"
        width="4.5"
        height="4.5"
        rx="1"
        stroke="currentColor"
        strokeWidth="1.2"
      />
    </svg>
  );
}

// A browser window: the app kind serves pages.
function AppIcon() {
  return (
    <svg
      className="ic-iris"
      width="14"
      height="14"
      viewBox="0 0 14 14"
      fill="none"
      aria-hidden="true"
    >
      <rect
        x="1.5"
        y="2"
        width="11"
        height="10"
        rx="1.6"
        stroke="currentColor"
        strokeWidth="1.2"
      />
      <path d="M1.5 4.8h11" stroke="currentColor" strokeWidth="1.2" />
      <circle cx="3.4" cy="3.4" r="0.5" fill="currentColor" />
    </svg>
  );
}

// A bolt: the worker kind runs on demand and goes away.
function WorkerIcon() {
  return (
    <svg
      className="ic-honey"
      width="14"
      height="14"
      viewBox="0 0 14 14"
      fill="none"
      aria-hidden="true"
    >
      <path
        d="M7.8 1.5 3 8h3.4l-.9 4.5L10.8 6H7.4l.4-4.5Z"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
    </svg>
  );
}

// The dot alone, pushed to the row's trailing edge. The state word still
// exists for screen readers: colour and shape are never the only carrier.
function RailDot({ state }: { state: string }) {
  return (
    <span className={`state rail-dot ${stateClass(state)}`}>
      <span className="dot" aria-hidden="true" />
      <span className="sr-only">{stateLabel(state)}</span>
    </span>
  );
}

function ProjectSwitcher({
  projects,
  current,
}: {
  projects: RailProject[];
  current?: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent): void => {
      if (ref.current && !ref.current.contains(event.target as Node))
        setOpen(false);
    };
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const label = current ?? "All projects";

  return (
    <div className="switcher" ref={ref}>
      <Button
        type="button"
        className="switcher-btn"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="name">{label}</span>
        <svg
          className="chev"
          width="12"
          height="12"
          viewBox="0 0 12 12"
          fill="none"
          aria-hidden="true"
        >
          <path
            d="M3.5 7.5 6 10l2.5-2.5M3.5 4.5 6 2l2.5 2.5"
            stroke="currentColor"
            strokeWidth="1.3"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </Button>

      {open && (
        <div className="switcher-menu" role="menu">
          <Button
            type="button"
            className="switcher-item"
            role="menuitem"
            aria-current={current === undefined}
            onClick={() => {
              setOpen(false);
              navigate("/");
            }}
          >
            <GridIcon />
            All projects
          </Button>
          {projects.map((row) => {
            const awake = row.resources.some((r) => r.state === "running");
            return (
              <Button
                key={row.project.id}
                type="button"
                className="switcher-item"
                role="menuitem"
                aria-current={row.project.name === current}
                onClick={() => {
                  setOpen(false);
                  navigate(`/projects/${encodeURIComponent(row.project.name)}`);
                }}
              >
                <span
                  className={`state ${awake ? "state-awake" : "state-sleeping"}`}
                >
                  <span className="dot" />
                </span>
                {row.project.name}
              </Button>
            );
          })}
        </div>
      )}
    </div>
  );
}

export type RailSection = "tables" | "sql" | "schema";

const DB_VIEWS: Array<{ id: RailSection; label: string }> = [
  { id: "tables", label: "Tables" },
  { id: "sql", label: "SQL" },
  { id: "schema", label: "Schema" },
];

// The caret a Cloudflare style group carries: it points right when the group
// is closed and rotates down when it opens, so the rail reads as a tree that
// is currently folded rather than a list that mysteriously grew.
function Caret() {
  return (
    <svg
      className="caret"
      width="10"
      height="10"
      viewBox="0 0 10 10"
      fill="none"
      aria-hidden="true"
    >
      <path
        d="M3.5 1.5 7 5l-3.5 3.5"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

// A disclosure is a destination and a group at once: the label navigates, the
// caret folds. Splitting them means clicking "Databases" never surprises you
// by doing the other thing.
function Disclosure({
  open,
  onToggle,
  label,
}: {
  open: boolean;
  onToggle: () => void;
  label: string;
}) {
  return (
    <Button
      type="button"
      className={`rail-toggle${open ? " is-open" : ""}`}
      aria-expanded={open}
      aria-label={`${open ? "Collapse" : "Expand"} ${label}`}
      onClick={onToggle}
    >
      <Caret />
    </Button>
  );
}

// How many of a kind this project holds. Durable Objects are the exception
// and are counted from what every worker declares, because they are not
// resources in the store: see views/DurableObjects.tsx.
function countFor(item: NavItem, resources: Resource[]): number | null {
  if (item.id === "durable-objects") {
    return resources
      .filter((r): r is WorkerResource => r.kind === "worker")
      .reduce(
        (sum, w) => sum + (w.config.manifest?.durableObjects.length ?? 0),
        0,
      );
  }
  if (item.kind === undefined) return null;
  return resources.filter((r) => r.kind === item.kind).length;
}

function iconFor(kind: ResourceKind) {
  if (kind === "postgres") return <DatabaseIcon />;
  if (kind === "app") return <AppIcon />;
  if (kind === "worker") return <WorkerIcon />;
  // A queue has no container and no icon of its own yet. The row still reads
  // as a resource because of where it sits, so an invented glyph would be
  // decoration standing in for a distinction that does not exist.
  return null;
}

// A resource under its section. Postgres is the only kind with views of its
// own, so it is the only kind that renders as a destination; the rest are
// facts (kind, name, state) until they have a page to go to, because a link
// to nothing is worse than no link.
function ResourceRow({
  resource,
  projectName,
  currentResource,
  currentView,
}: {
  resource: Resource;
  projectName: string;
  currentResource?: string;
  currentView?: RailSection;
}) {
  const icon = iconFor(resource.kind);

  if (resource.kind !== "postgres") {
    return (
      <div className="rail-item">
        {icon}
        <span className="rail-name">{resource.name}</span>
        <RailDot state={resource.state} />
      </div>
    );
  }

  const here = resource.name === currentResource;
  const base = `#/projects/${encodeURIComponent(projectName)}/resources/${encodeURIComponent(resource.name)}`;

  return (
    <div className="rail-node">
      <a
        className={`rail-link${here ? " is-trail" : ""}`}
        href={`${base}/tables`}
      >
        {icon}
        <span className="rail-name">{resource.name}</span>
        <RailDot state={resource.state} />
      </a>
      {/* The three views appear under the database you are actually in.
          Hanging them off every database at once would triple the rail for a
          project with four of them, to show links you are not going to use
          from here. */}
      {here && (
        <div className="rail-sub">
          {DB_VIEWS.map((view) => (
            <a
              key={view.id}
              className="rail-link rail-link-sub"
              href={`${base}/${view.id}`}
              aria-current={currentView === view.id ? "page" : undefined}
            >
              {view.label}
            </a>
          ))}
        </div>
      )}
    </div>
  );
}

function ProjectItem({
  item,
  projectName,
  resources,
  currentSection,
  currentResource,
  currentView,
  open,
  onToggle,
}: {
  item: NavItem;
  projectName: string;
  resources: Resource[];
  currentSection?: string;
  currentResource?: string;
  currentView?: RailSection;
  open: boolean;
  onToggle: () => void;
}) {
  const here = currentSection === item.id;
  const count = countFor(item, resources);
  const rows =
    item.kind === undefined
      ? []
      : resources.filter((r) => r.kind === item.kind);

  const link = (
    <a
      className={`rail-link${here && currentResource !== undefined ? " is-trail" : ""}`}
      href={`#/projects/${encodeURIComponent(projectName)}/${item.id}`}
      aria-current={here && currentResource === undefined ? "page" : undefined}
    >
      <span className="rail-name">{item.label}</span>
      {/* Only `soon` earns a badge here. A preview page is a working list with
          fewer columns than a managed dashboard would show, and its missing
          half is stated on the page itself; badging it in the rail too would
          put a caveat on a row that does its job. */}
      {item.status === "soon" ? (
        <Badge tone="soon" className="ml-auto">
          Soon
        </Badge>
      ) : count !== null && count > 0 ? (
        <span className="count">{count}</span>
      ) : null}
    </a>
  );

  if (rows.length === 0) return link;

  return (
    <div className="rail-node">
      <div className="rail-row">
        {link}
        <Disclosure open={open} onToggle={onToggle} label={item.label} />
      </div>
      {open && (
        <div className="rail-sub">
          {rows.map((row) => (
            <ResourceRow
              key={row.id}
              resource={row}
              projectName={projectName}
              currentResource={currentResource}
              currentView={currentView}
            />
          ))}
        </div>
      )}
    </div>
  );
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
  projects: RailProject[];
  currentProject?: string;
  currentSection?: string;
  currentResource?: string;
  currentView?: RailSection;
  wide?: boolean;
  crumbs: ReactNode;
  onLogout: () => void;
  children: ReactNode;
}) {
  const anyAwake = projects.some((row) =>
    row.resources.some((r) => r.state === "running"),
  );
  const active = projects.find((row) => row.project.name === currentProject);
  const resources = active?.resources ?? [];

  // Each node remembers whether it was folded, falling back to a default the
  // route decides: the section you are inside starts open, the rest start
  // closed. Storing the override rather than seeding state from the route
  // matters, because the route changes on every click and would otherwise keep
  // reopening a group you deliberately folded.
  const [folds, setFolds] = useState<Record<string, boolean>>({});
  const isOpen = (key: string, fallback: boolean): boolean => folds[key] ?? fallback; // prettier-ignore
  const toggle = (key: string, fallback: boolean) => () => setFolds((prev) => ({ ...prev, [key]: !(prev[key] ?? fallback) })); // prettier-ignore

  return (
    <div className="shell">
      <nav className="rail" aria-label="main">
        <a className="rail-brand" href="#/">
          <span
            className={`rail-mark${anyAwake ? " is-awake" : ""}`}
            aria-hidden="true"
          >
            <i />
          </span>
          Hobbyist
        </a>

        <ProjectSwitcher projects={projects} current={currentProject} />

        {currentProject === undefined ? (
          // Account scope. Shorter than the project map because almost
          // everything Hobbyist does is scoped to a project: there is one
          // owner and one box, so there is no organisation layer to fill.
          ACCOUNT_NAV.map((group) => (
            <div className="rail-group" key={group.id}>
              <div className="rail-label">{group.label}</div>
              {group.items.map((item) => (
                <a
                  key={item.id}
                  className="rail-link"
                  href={item.id === "" ? "#/" : `#/${item.id}`}
                  aria-current={
                    (currentSection ?? "") === item.id ? "page" : undefined
                  }
                >
                  <GridIcon />
                  <span className="rail-name">{item.label}</span>
                  {item.status === "soon" ? (
                    <Badge tone="soon" className="ml-auto">
                      Soon
                    </Badge>
                  ) : item.id === "" ? (
                    <span className="count">{projects.length}</span>
                  ) : null}
                </a>
              ))}
            </div>
          ))
        ) : (
          <>
            <div className="rail-group">
              <div className="rail-label">Project</div>
              <a
                className="rail-link"
                href={`#/projects/${encodeURIComponent(currentProject)}`}
                aria-current={
                  currentSection === undefined && currentResource === undefined
                    ? "page"
                    : undefined
                }
              >
                <GridIcon />
                Overview
              </a>
            </div>

            {/* The whole map, not the finished half. Every destination
                Hobbyist intends to have is listed, and the ones that are not
                built say so on the row and again on the page they open. A
                rail that hides them describes this Studio; a rail that shows
                them describes the project, which is the thing a reader is
                actually deciding about. */}
            {PROJECT_NAV.map((group) => (
              <div className="rail-group" key={group.id}>
                <div className="rail-label">{group.label}</div>
                {group.items.map((item) => (
                  <ProjectItem
                    key={item.id}
                    item={item}
                    projectName={currentProject}
                    resources={resources}
                    currentSection={currentSection}
                    currentResource={currentResource}
                    currentView={currentView}
                    open={isOpen(`nav:${item.id}`, currentSection === item.id)}
                    onToggle={toggle(
                      `nav:${item.id}`,
                      currentSection === item.id,
                    )}
                  />
                ))}
              </div>
            ))}
          </>
        )}

        <div className="rail-foot">
          <Button
            type="button"
            className="rail-link"
            onClick={onLogout}
            style={{
              width: "100%",
              cursor: "pointer",
              background: "none",
              font: "inherit",
              textAlign: "left",
            }}
          >
            Sign out
          </Button>
        </div>
      </nav>

      <div className="main">
        <header className="topbar">
          {/* The bar has to agree with the page beneath it. A full bleed
              workbench under a breadcrumb centred in the reading measure
              leaves the crumb floating over nothing. */}
          <Wrapper wide={wide}>
            <nav className="crumbs" aria-label="breadcrumb">
              {crumbs}
            </nav>
          </Wrapper>
        </header>
        {children}
      </div>
    </div>
  );
}

export function Crumb({
  href,
  children,
  here,
}: {
  href?: string;
  children: ReactNode;
  here?: boolean;
}) {
  if (here === true || href === undefined)
    return <span className="here">{children}</span>;
  return (
    <>
      <a href={href}>{children}</a>
      <Chevron />
    </>
  );
}
