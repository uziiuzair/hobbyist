/**
 * Projects Provider
 *
 * @author Uzair Hayat <business@uziiuzair.com>
 *
 * Last updated: Aug 16, 2026
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
} from "react";
import type { Project, Resource } from "@hobby.sh/core";
import * as api from "../api.js";
import { useAuth } from "./auth-provider.js";

/**
 * The rail and every page read one copy of the project list, so the switcher
 * can never disagree with the page it is sitting next to. Structurally the
 * same shape as Shell's RailProject, declared here instead of imported from a
 * component: a provider that depends on a component is a dependency pointing
 * the wrong way.
 */
export interface ProjectSummary {
  project: Project;
  resources: Resource[];
}

interface ProjectsContextType {
  projects: ProjectSummary[] | null;
  freeBytes: number | null;
  error: string | null;
  refresh: () => void;
  createProject: (name: string) => Promise<Project>;
  deleteProject: (name: string) => Promise<void>;
}

const ProjectsContext = createContext<ProjectsContextType>({
  projects: null,
  freeBytes: null,
  error: null,
  refresh: () => {},
  createProject: () => Promise.reject(new Error("no ProjectsProvider")),
  deleteProject: () => Promise.reject(new Error("no ProjectsProvider")),
});

export const ProjectsProvider = ({
  children,
}: {
  children?: React.ReactNode;
}) => {
  const { session } = useAuth();

  const [projects, setProjects] = useState<ProjectSummary[] | null>(null);
  const [freeBytes, setFreeBytes] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  /**
   * Loads every project, then its resources.
   *
   * The list route returns projects without their resources, so each one is
   * fetched again for the detail. A project whose detail fetch fails still
   * appears, with no resources, rather than taking the whole list down with
   * it: one broken project must not hide the other nine.
   */
  const refresh = useCallback(() => {
    api
      .listProjects()
      .then(async ({ projects: list }) => {
        const detailed = await Promise.all(
          list.map(async (project): Promise<ProjectSummary> => {
            try {
              const detail = await api.getProject(project.name);
              return { project: detail.project, resources: detail.resources };
            } catch {
              return { project, resources: [] };
            }
          }),
        );
        setProjects(detailed);
        setError(null);
      })
      .catch((err: unknown) => {
        setProjects([]);
        setError(err instanceof api.ApiError ? err.message : String(err));
      });

    // Read only, and the daemon guarantees it mutates nothing. It is the
    // closest thing to a plan quota that is true on a machine you own.
    api
      .preflight()
      .then((report) => setFreeBytes(report.filesystem.freeBytes))
      .catch(() => setFreeBytes(null));
  }, []);

  /**
   * Loads on sign in, and drops everything on sign out.
   *
   * Clearing matters: without it the next sign in renders the previous
   * session's projects for as long as the first fetch takes, which is a real
   * disclosure on a shared browser rather than a cosmetic flash.
   */
  useEffect(() => {
    if (session === "authenticated") {
      refresh();
      return;
    }
    setProjects(null);
    setFreeBytes(null);
    setError(null);
  }, [session, refresh]);

  /**
   * Creates a project and its first Postgres, named `primary`.
   *
   * Both calls, because a project with no database has nothing to connect to,
   * and the daemon has no single route that does the pair.
   */
  const createProject = useCallback(
    async (name: string): Promise<Project> => {
      const { project } = await api.createProject(name);
      await api.createResource(name, "primary");
      refresh();
      return project;
    },
    [refresh],
  );

  /**
   * Deletes a project, its databases, and their data directories on disk.
   *
   * force is set because Studio always asks for typed confirmation first, so
   * the daemon's own second guard would only ever reject a deletion the user
   * has already spelled out by hand.
   */
  const deleteProject = useCallback(
    async (name: string): Promise<void> => {
      await api.deleteProject(name, { force: true });
      refresh();
    },
    [refresh],
  );

  return (
    <ProjectsContext.Provider
      value={{
        projects: projects,
        freeBytes: freeBytes,
        error: error,
        refresh: refresh,
        createProject: createProject,
        deleteProject: deleteProject,
      }}
    >
      {children}
    </ProjectsContext.Provider>
  );
};

export const useProjects = () => {
  return useContext(ProjectsContext);
};
