/**
 * Durable Objects Provider
 *
 * @author Uzair Hayat <business@uziiuzair.com>
 *
 * Last updated: Aug 16, 2026
 */

import { createContext, useContext, useMemo } from "react";
import { useWorker } from "./worker-provider.js";

/**
 * One Durable Object class the current worker declares.
 *
 * Both fields come from the user's own wrangler manifest: `binding` is the
 * name their code reads off `env`, `className` is the exported class it
 * resolves to.
 */
export interface DurableObjectNamespace {
  binding: string;
  className: string;
}

/**
 * The Durable Object classes a worker declares, and nothing beyond that.
 *
 * WHAT THIS CAN ANSWER: which classes this worker's deployed manifest names.
 * That is read straight off the resource the project fetch already returned,
 * so it costs no request and is exactly as fresh as the worker beside it.
 *
 * WHAT IT CANNOT ANSWER, and must not appear to: which object instances
 * exist, how much storage each holds, or when an alarm is due. Those live in
 * per-object SQLite files under the worker's data directory, and the daemon
 * publishes no route over them. `instancesInspectable` is false and stays
 * false until one exists, rather than this provider returning an empty list
 * that reads as "no objects yet" when it means "never asked".
 *
 * One known gap worth surfacing wherever this renders: an alarm cannot fire
 * inside a stopped container, so a worker that sets one misses it while it
 * sleeps.
 */
interface DurableObjectsContextType {
  namespaces: DurableObjectNamespace[];
  declared: boolean;
  instancesInspectable: false;
  unavailableReason: string;
}

const UNAVAILABLE_REASON =
  "The daemon publishes no route over Durable Object storage, so instances, sizes and alarm deadlines cannot be read from here yet.";

const DurableObjectsContext = createContext<DurableObjectsContextType>({
  namespaces: [],
  declared: false,
  instancesInspectable: false,
  unavailableReason: UNAVAILABLE_REASON,
});

export const DurableObjectsProvider = ({
  children,
}: {
  children?: React.ReactNode;
}) => {
  const { worker } = useWorker();

  // Null until a first deploy: a worker with no manifest has declared
  // nothing, which is different from having declared none.
  const namespaces = useMemo(
    () => worker?.config.manifest?.durableObjects ?? [],
    [worker],
  );

  return (
    <DurableObjectsContext.Provider
      value={{
        namespaces: namespaces,
        declared: worker !== null && worker.config.manifest !== null,
        instancesInspectable: false,
        unavailableReason: UNAVAILABLE_REASON,
      }}
    >
      {children}
    </DurableObjectsContext.Provider>
  );
};

export const useDurableObjects = () => {
  return useContext(DurableObjectsContext);
};
