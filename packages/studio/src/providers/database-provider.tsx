/**
 * Database Provider
 *
 * @author Uzair Hayat <business@uziiuzair.com>
 *
 * Last updated: Aug 16, 2026
 */

import { createContext, useCallback, useContext, useState } from "react";
import type { Resource } from "@hobby.sh/core";
import * as api from "../api.js";
import { useResource } from "../lib/useResource.js";
import { useWakeAwareRun, type WakingSnapshot } from "../lib/useWaking.js";
import { useProjects } from "./projects-provider.js";

/**
 * One database, addressed the way the URL addresses it.
 *
 * Every daemon route below the project level takes a resource id, but the
 * router only carries a (project, resource) name pair, so the pair is
 * resolved once here instead of in each of Tables, Sql and Schema.
 */
interface DatabaseContextType {
  resource: Resource | null;
  error: string | null;
  snapshot: WakingSnapshot;
  refresh: () => void;
  /**
   * Runs a task under the waking treatment: if this database was asleep when
   * the task started, the banner says so and a clock runs, rather than a bare
   * spinner sitting over a query that is genuinely waking a container.
   */
  run: <T>(task: () => Promise<T>) => Promise<T>;
  query: (sql: string, params?: unknown[]) => Promise<api.QueryResult>;
  wake: () => Promise<void>;
  sleep: () => Promise<void>;
  connectionString: () => Promise<string>;
  logs: (tail?: number) => Promise<string>;
}

const NOT_MOUNTED = (): Promise<never> =>
  Promise.reject(new Error("no DatabaseProvider"));

const IDLE: WakingSnapshot = {
  phase: "idle",
  elapsedMs: 0,
  resourceState: null,
};

const DatabaseContext = createContext<DatabaseContextType>({
  resource: null,
  error: null,
  snapshot: IDLE,
  refresh: () => {},
  run: NOT_MOUNTED,
  query: NOT_MOUNTED,
  wake: NOT_MOUNTED,
  sleep: NOT_MOUNTED,
  connectionString: NOT_MOUNTED,
  logs: NOT_MOUNTED,
});

export const DatabaseProvider = ({
  projectName,
  resourceName,
  children,
}: {
  projectName: string;
  resourceName: string;
  children?: React.ReactNode;
}) => {
  const { refresh: refreshProjects } = useProjects();
  const {
    resource,
    error,
    refresh: refreshResource,
  } = useResource(projectName, resourceName);

  const [actionError, setActionError] = useState<string | null>(null);

  /**
   * Fires once a run that began against a sleeping database settles.
   *
   * Without it the database is genuinely awake and every state label in the
   * interface still says sleeping until a reload: the query wakes the
   * container, but nothing tells the views or the rail that the world changed
   * underneath them.
   */
  const { snapshot, run: runWithResource } = useWakeAwareRun(() => {
    refreshResource();
    refreshProjects();
  });

  /**
   * Binds the waking treatment to this database.
   *
   * Refuses rather than waiting when the resource has not resolved yet: a
   * task queued against an unknown id would have to guess which database it
   * is waking, and the banner's whole job is naming the one it is.
   */
  const run = useCallback(
    <T,>(task: () => Promise<T>): Promise<T> => {
      if (resource === null) {
        return Promise.reject(
          new api.ApiError(
            "resource_not_found",
            `${resourceName} has not resolved yet`,
            0,
          ),
        );
      }
      return runWithResource(resource.id, resource.state, task);
    },
    [resource, resourceName, runWithResource],
  );

  const query = useCallback(
    (sql: string, params?: unknown[]): Promise<api.QueryResult> => {
      if (resource === null) return NOT_MOUNTED();
      const id = resource.id;
      return run(() => api.runQuery(id, sql, params));
    },
    [resource, run],
  );

  /**
   * Wake and sleep are the explicit verbs, distinct from the implicit wake a
   * query performs. Both refresh the rail as well as this view, because a
   * state dot one panel over is otherwise stale the moment either succeeds.
   */
  const wake = useCallback(async (): Promise<void> => {
    if (resource === null) return NOT_MOUNTED();
    setActionError(null);
    try {
      await api.wakeResource(resource.id);
      refreshResource();
      refreshProjects();
    } catch (err) {
      const message =
        err instanceof api.ApiError ? err.message : "Could not wake it";
      setActionError(message);
      throw err;
    }
  }, [resource, refreshResource, refreshProjects]);

  const sleep = useCallback(async (): Promise<void> => {
    if (resource === null) return NOT_MOUNTED();
    setActionError(null);
    try {
      await api.sleepResource(resource.id);
      refreshResource();
      refreshProjects();
    } catch (err) {
      const message =
        err instanceof api.ApiError ? err.message : "Could not put it to sleep";
      setActionError(message);
      throw err;
    }
  }, [resource, refreshResource, refreshProjects]);

  /**
   * The connection string is fetched on demand and never held in state.
   *
   * It carries the database password. Parking it in a context value would put
   * a live credential in every React devtools inspection of this tree for as
   * long as the page stays open, when the only moment it is needed is the one
   * where it is being shown or copied.
   */
  const connectionString = useCallback(async (): Promise<string> => {
    if (resource === null) return NOT_MOUNTED();
    const result = await api.connectionString(resource.id);
    return result.connectionString;
  }, [resource]);

  const logs = useCallback(
    async (tail?: number): Promise<string> => {
      if (resource === null) return NOT_MOUNTED();
      const result = await api.logs(resource.id, tail);
      return result.logs;
    },
    [resource],
  );

  return (
    <DatabaseContext.Provider
      value={{
        resource: resource,
        // The lookup failure and the last action failure are one line of text
        // in the interface, and the newer one is the one worth reading.
        error: actionError ?? error,
        snapshot: snapshot,
        refresh: refreshResource,
        run: run,
        query: query,
        wake: wake,
        sleep: sleep,
        connectionString: connectionString,
        logs: logs,
      }}
    >
      {children}
    </DatabaseContext.Provider>
  );
};

export const useDatabase = () => {
  return useContext(DatabaseContext);
};
