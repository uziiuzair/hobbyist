/**
 * Workers Provider
 *
 * @author Uzair Hayat <business@uziiuzair.com>
 *
 * Last updated: Aug 16, 2026
 */

import { createContext, useContext, useMemo } from "react";
import type { WorkerResource } from "@hobby.sh/core";
import { useProject } from "./project-provider.js";

/**
 * Every worker in the current project.
 *
 * Derived from the project's own resource list rather than fetched again:
 * there is no worker-specific list route, and the project fetch already
 * returns every kind. Reading one copy is also what stops the rail and the
 * page beside it from disagreeing.
 *
 * Mount inside ProjectProvider. Outside it this reads as a project with no
 * workers, which is the honest answer to "which workers are in no project".
 */
interface WorkersContextType {
  workers: WorkerResource[];
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

const WorkersContext = createContext<WorkersContextType>({
  workers: [],
  loading: false,
  error: null,
  refresh: () => {},
});

export const WorkersProvider = ({
  children,
}: {
  children?: React.ReactNode;
}) => {
  const { resources, error, refresh } = useProject();

  const workers = useMemo(
    () =>
      (resources ?? []).filter((r): r is WorkerResource => r.kind === "worker"),
    [resources],
  );

  return (
    <WorkersContext.Provider
      value={{
        workers: workers,
        loading: resources === null,
        error: error,
        refresh: refresh,
      }}
    >
      {children}
    </WorkersContext.Provider>
  );
};

export const useWorkers = () => {
  return useContext(WorkersContext);
};
