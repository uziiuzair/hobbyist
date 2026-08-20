/**
 * Worker Provider
 *
 * @author Uzair Hayat <business@uziiuzair.com>
 *
 * Last updated: Aug 16, 2026
 */

import { createContext, useCallback, useContext, useMemo, useState } from "react";
import type { WorkerResource } from "@hobby.sh/core";
import * as api from "../api.js";
import { useProject } from "./project-provider.js";
import { useWorkers } from "./workers-provider.js";

/**
 * One worker, addressed by name the way the URL addresses it.
 *
 * A worker's manifest is null until a first deploy, so `deployed` is a real
 * distinction rather than a loading state: the record exists, the code does
 * not, and the resource sits in `undeployed` rather than asleep. Saying
 * "sleeping" about code that never arrived would be a lie, and there is no
 * wake affordance for it either, since a button that cannot succeed
 * advertises a capability that does not exist.
 */
interface WorkerContextType {
  worker: WorkerResource | null;
  deployed: boolean;
  error: string | null;
  deploying: boolean;
  refresh: () => void;
  deploy: (source?: { path: string }) => Promise<api.DeployResult>;
  wake: () => Promise<void>;
  sleep: () => Promise<void>;
  logs: (tail?: number) => Promise<string>;
}

const NOT_MOUNTED = (): Promise<never> =>
  Promise.reject(new Error("no WorkerProvider"));

const WorkerContext = createContext<WorkerContextType>({
  worker: null,
  deployed: false,
  error: null,
  deploying: false,
  refresh: () => {},
  deploy: NOT_MOUNTED,
  wake: NOT_MOUNTED,
  sleep: NOT_MOUNTED,
  logs: NOT_MOUNTED,
});

export const WorkerProvider = ({
  name,
  children,
}: {
  name: string;
  children?: React.ReactNode;
}) => {
  const { workers, refresh } = useWorkers();
  const { wake: wakeResource, sleep: sleepResource } = useProject();

  const [error, setError] = useState<string | null>(null);
  const [deploying, setDeploying] = useState(false);

  const worker = useMemo(
    () => workers.find((w) => w.name === name) ?? null,
    [workers, name],
  );

  /**
   * Rebuilds the image and restarts the container.
   *
   * `source` is a path on this machine, which is the only kind that exists:
   * the daemon builds from a directory it can read, so there is no upload and
   * nothing crosses a network. Omitted, the daemon reuses the path the last
   * deploy recorded.
   */
  const deploy = useCallback(
    async (source?: { path: string }): Promise<api.DeployResult> => {
      if (worker === null) return NOT_MOUNTED();
      setDeploying(true);
      setError(null);
      try {
        const result = await api.deployResource(worker.id, source);
        refresh();
        return result;
      } catch (err) {
        setError(
          err instanceof api.ApiError ? err.message : "Could not deploy it",
        );
        throw err;
      } finally {
        setDeploying(false);
      }
    },
    [worker, refresh],
  );

  const wake = useCallback(async (): Promise<void> => {
    if (worker === null) return NOT_MOUNTED();
    setError(null);
    try {
      await wakeResource(worker.id);
    } catch (err) {
      setError(err instanceof api.ApiError ? err.message : "Could not wake it");
      throw err;
    }
  }, [worker, wakeResource]);

  const sleep = useCallback(async (): Promise<void> => {
    if (worker === null) return NOT_MOUNTED();
    setError(null);
    try {
      await sleepResource(worker.id);
    } catch (err) {
      setError(
        err instanceof api.ApiError ? err.message : "Could not put it to sleep",
      );
      throw err;
    }
  }, [worker, sleepResource]);

  /**
   * Logs come from the container, so a sleeping worker has none to give.
   *
   * Fetched on demand rather than polled: reading them must never be the
   * thing that keeps a worker awake, since the activity sensor is what
   * hibernation reads.
   */
  const logs = useCallback(
    async (tail?: number): Promise<string> => {
      if (worker === null) return NOT_MOUNTED();
      const result = await api.logs(worker.id, tail);
      return result.logs;
    },
    [worker],
  );

  return (
    <WorkerContext.Provider
      value={{
        worker: worker,
        deployed: worker !== null && worker.config.manifest !== null,
        error: error,
        deploying: deploying,
        refresh: refresh,
        deploy: deploy,
        wake: wake,
        sleep: sleep,
        logs: logs,
      }}
    >
      {children}
    </WorkerContext.Provider>
  );
};

export const useWorker = () => {
  return useContext(WorkerContext);
};
