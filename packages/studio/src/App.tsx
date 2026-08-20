/**
 * App Root
 *
 * @author Uzair Hayat <business@uziiuzair.com>
 *
 * Last updated: Aug 16, 2026
 */

import { useCallback, useEffect, useState } from "react";
import * as api from "./api.js";
import { navigate, useHashRoute } from "./lib/router.js";
import { Shell, Crumb } from "./components/Shell.js";
import type { RailProject } from "./components/Shell.js";
import { Login } from "./views/Login.js";
import { Projects } from "./views/Projects.js";
import { Project } from "./views/Project.js";
import { Tables } from "./views/Tables.js";
import { Sql } from "./views/Sql.js";
import { Schema } from "./views/Schema.js";
import { Databases } from "./views/Databases.js";
import { Workers } from "./views/Workers.js";
import { Apps } from "./views/Apps.js";
import { DurableObjects } from "./views/DurableObjects.js";
import { Queues } from "./views/Queues.js";
import { Soon } from "./views/Soon.js";
import { findAccountItem, findProjectItem } from "./nav.js";
import { useAuth } from "./providers/auth-provider.js";

export function App() {
  const { session, handleLoggedIn, handleLogout } = useAuth();

  const segments = useHashRoute();

  // The rail and every page read one copy of the project list, so the
  // switcher can never disagree with the page it is sitting next to.
  const [rows, setRows] = useState<RailProject[] | null>(null);
  const [freeBytes, setFreeBytes] = useState<number | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(() => {
    api
      .listProjects()
      .then(async ({ projects }) => {
        const detailed = await Promise.all(
          projects.map(async (project): Promise<RailProject> => {
            try {
              const detail = await api.getProject(project.name);
              return { project: detail.project, resources: detail.resources };
            } catch {
              return { project, resources: [] };
            }
          }),
        );
        setRows(detailed);
        setLoadError(null);
      })
      .catch((err: unknown) => {
        setRows([]);
        setLoadError(err instanceof Error ? err.message : String(err));
      });
    api
      .preflight()
      .then((report) => setFreeBytes(report.filesystem.freeBytes))
      .catch(() => setFreeBytes(null));
  }, []);

  useEffect(() => {
    if (session === "authenticated") load();
  }, [session, load]);

  if (session === "checking") {
    return (
      <div className="login-wrap">
        <span className="dim">Loading</span>
      </div>
    );
  }

  if (session === "anonymous") return <Login onLoggedIn={handleLoggedIn} />;

  // #/projects/:name/:section, or #/projects/:name/resources/:resource/:view.
  // "resources" is the one segment in that position that is not a section, so
  // a section can never collide with a resource route by being named after it.
  const projectName = segments[0] === "projects" ? segments[1] : undefined;
  const section = segments[2] === "resources" ? undefined : segments[2];
  const resourceName = segments[2] === "resources" ? segments[3] : undefined;
  const tab = segments[4];

  // At account scope the first segment is the section itself. `undefined`
  // means the projects list, which is why its nav entry carries an empty id.
  const accountSection = segments[0] === "projects" ? undefined : segments[0];
  const sectionItem =
    projectName === undefined
      ? findAccountItem(accountSection ?? "")
      : findProjectItem(section);

  return (
    <Shell
      projects={rows ?? []}
      currentProject={projectName}
      currentSection={projectName === undefined ? accountSection : section}
      currentResource={resourceName}
      currentView={
        tab === "tables" || tab === "sql" || tab === "schema" ? tab : undefined
      }
      wide={resourceName !== undefined}
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
          {resourceName === undefined &&
            sectionItem !== undefined &&
            sectionItem.id !== "" && <Crumb here>{sectionItem.label}</Crumb>}
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
          section={section}
          accountSection={accountSection}
          resourceName={resourceName}
          tab={tab}
        />
      )}
    </Shell>
  );
}

function Route({
  rows,
  freeBytes,
  onChanged,
  projectName,
  section,
  accountSection,
  resourceName,
  tab,
  segments,
}: {
  rows: RailProject[];
  freeBytes: number | null;
  onChanged: () => void;
  projectName?: string;
  section?: string;
  accountSection?: string;
  resourceName?: string;
  tab?: string;
  segments: string[];
}) {
  if (projectName === undefined) {
    const item = findAccountItem(accountSection);
    // The projects list is the account root and carries an empty id, so an
    // account section only ever resolves to a page that is not built yet.
    if (item !== undefined && item.id !== "") return <Soon item={item} />;
    return <Projects rows={rows} freeBytes={freeBytes} onChanged={onChanged} />;
  }

  if (resourceName === undefined) {
    if (section === undefined) {
      return <Project projectName={projectName} onChanged={onChanged} />;
    }

    // The five sections with real data behind them. Everything else in the
    // map resolves to Soon, which is the whole reason the map is a single
    // list: adding a destination to nav.ts gives it an honest page for free,
    // and forgetting to build it cannot produce a blank screen.
    if (section === "databases") return <Databases projectName={projectName} />;
    if (section === "workers") return <Workers projectName={projectName} />;
    if (section === "apps") return <Apps projectName={projectName} />;
    if (section === "durable-objects")
      return <DurableObjects projectName={projectName} />;
    if (section === "queues") return <Queues projectName={projectName} />;

    const item = findProjectItem(section);
    if (item !== undefined) return <Soon item={item} />;

    // An unknown segment is a stale bookmark, not a destination: the overview
    // is where it belongs, and it is the page the project name already means.
    return <Project projectName={projectName} onChanged={onChanged} />;
  }

  if (tab === "tables") {
    return (
      <Tables
        projectName={projectName}
        resourceName={resourceName}
        tableName={segments[5]}
        onChanged={onChanged}
      />
    );
  }
  if (tab === "sql") {
    return (
      <Sql
        projectName={projectName}
        resourceName={resourceName}
        onChanged={onChanged}
      />
    );
  }
  if (tab === "schema") {
    return (
      <Schema
        projectName={projectName}
        resourceName={resourceName}
        onChanged={onChanged}
      />
    );
  }

  return <Project projectName={projectName} onChanged={onChanged} />;
}
