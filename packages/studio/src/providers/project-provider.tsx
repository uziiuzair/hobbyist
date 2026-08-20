/**
 * Project Provider
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
  useMemo,
  useState,
} from "react";
import type { Project, Resource } from "@hobby.sh/core";
import * as api from "../api.js";
import { readStats } from "../lib/format.js";
import { useProjects } from "./projects-provider.js";

// The window matches the daemon's own idle threshold, so watching the chart
// this feeds is watching the sleep timer run.
const WINDOW_MS = 300_000;
const POLL_MS = 5000;

/**
 * One point on the activity chart. Structurally the same shape as
 * ActivityChart's Sample, declared here rather than imported for the same
 * reason ProjectSummary is: providers do not depend on components.
 */
export interface ActivitySample {
  at: number;
  connections: number;
  awake: boolean;
}

interface ProjectTotals {
  databases: number;
  awake: number;
  bytes: number;
  connections: number;
}

interface ProjectContextType {
  project: Project | null;
  resources: Resource[] | null;
  totals: ProjectTotals;
  samples: Record<string, ActivitySample[]>;
  freeBytes: number | null;
  reflinkSupported: boolean | null;
  error: string | null;
  windowMs: number;
  pollMs: number;
  refresh: () => void;
  createDatabase: (name: string) => Promise<void>;
  wake: (resourceId: string) => Promise<void>;
  sleep: (resourceId: string) => Promise<void>;
  destroyResource: (resourceId: string) => Promise<void>;
  eject: () => Promise<{ compose: string; dataDirs: string[] }>;
}

const EMPTY_TOTALS: ProjectTotals = {
  databases: 0,
  awake: 0,
  bytes: 0,
  connections: 0,
};

const ProjectContext = createContext<ProjectContextType>({
  project: null,
  resources: null,
  totals: EMPTY_TOTALS,
  samples: {},
  freeBytes: null,
  reflinkSupported: null,
  error: null,
  windowMs: WINDOW_MS,
  pollMs: POLL_MS,
  refresh: () => {},
  createDatabase: () => Promise.reject(new Error("no ProjectProvider")),
  wake: () => Promise.reject(new Error("no ProjectProvider")),
  sleep: () => Promise.reject(new Error("no ProjectProvider")),
  destroyResource: () => Promise.reject(new Error("no ProjectProvider")),
  eject: () => Promise.reject(new Error("no ProjectProvider")),
});

export const ProjectProvider = ({
  name,
  children,
}: {
  name: string;
  children?: React.ReactNode;
}) => {
  // Every mutation here changes a row the project list also renders, so the
  // list is told to reload rather than left showing a state that stopped
  // being true one panel over.
  const { refresh: refreshProjects } = useProjects();

  const [project, setProject] = useState<Project | null>(null);
  const [resources, setResources] = useState<Resource[] | null>(null);
  const [samples, setSamples] = useState<Record<string, ActivitySample[]>>({});
  const [freeBytes, setFreeBytes] = useState<number | null>(null);
  const [reflinkSupported, setReflinkSupported] = useState<boolean | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);

  /**
   * Records one sample per resource, dropping anything past the window.
   *
   * The sampler runs off the same fetch the page renders from, so the chart
   * can never disagree with the table beside it.
   */
  const record = useCallback((rows: Resource[]) => {
    const at = Date.now();
    setSamples((prev) => {
      const next: Record<string, ActivitySample[]> = {};
      for (const row of rows) {
        const stats = readStats(row);
        const kept = (prev[row.id] ?? []).filter((s) => at - s.at <= WINDOW_MS);
        kept.push({
          at: at,
          connections: stats.connectionCount ?? 0,
          awake: row.state === "running",
        });
        next[row.id] = kept;
      }
      return next;
    });
  }, []);

  const refresh = useCallback(() => {
    api
      .getProject(name)
      .then((detail) => {
        setProject(detail.project);
        setResources(detail.resources);
        record(detail.resources);
        setError(null);
      })
      .catch((err: unknown) =>
        setError(
          err instanceof api.ApiError
            ? err.message
            : "Could not reach the daemon",
        ),
      );
  }, [name, record]);

  /**
   * Resets on a project change before fetching.
   *
   * Without the reset, navigating between two projects renders the previous
   * one's name and databases until the new fetch lands, which reads as the
   * wrong project rather than as loading. Samples go too: they are keyed by
   * resource id, and carrying another project's series into this chart would
   * be a graph of something you are not looking at.
   */
  useEffect(() => {
    setProject(null);
    setResources(null);
    setSamples({});
    setError(null);
    refresh();
  }, [name, refresh]);

  useEffect(() => {
    api
      .preflight()
      .then((report) => {
        setFreeBytes(report.filesystem.freeBytes);
        setReflinkSupported(report.filesystem.reflinkSupported);
      })
      .catch(() => {
        setFreeBytes(null);
        setReflinkSupported(null);
      });
  }, []);

  /**
   * Polls for the chart, and stops when the tab is hidden.
   *
   * Each round trip asks a running Postgres for its size, and doing that
   * every five seconds against a database nobody is looking at is work for
   * nothing.
   */
  useEffect(() => {
    const tick = (): void => {
      if (document.visibilityState === "visible") refresh();
    };
    const timer = window.setInterval(tick, POLL_MS);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const reload = useCallback(() => {
    refresh();
    refreshProjects();
  }, [refresh, refreshProjects]);

  const createDatabase = useCallback(
    async (databaseName: string): Promise<void> => {
      await api.createResource(name, databaseName);
      reload();
    },
    [name, reload],
  );

  /**
   * The daemon's mechanical verbs are start and stop; Studio renders them as
   * the wake and sleep language the rest of the product uses, same as the CLI.
   */
  const wake = useCallback(
    async (resourceId: string): Promise<void> => {
      await api.wakeResource(resourceId);
      reload();
    },
    [reload],
  );

  const sleep = useCallback(
    async (resourceId: string): Promise<void> => {
      await api.sleepResource(resourceId);
      reload();
    },
    [reload],
  );

  const destroyResource = useCallback(
    async (resourceId: string): Promise<void> => {
      await api.destroyResource(resourceId);
      reload();
    },
    [reload],
  );

  /**
   * Hands back a docker-compose.yml and the data directories behind it.
   *
   * Non-destructive as called here: the daemon only releases a project from
   * its own management when `release=true` is passed, which api.eject never
   * does. Eject is the promise that makes everything else honest, so reading
   * it must never be the call that also detaches it.
   */
  const eject = useCallback((): Promise<{
    compose: string;
    dataDirs: string[];
  }> => {
    return api.eject(name);
  }, [name]);

  const totals = useMemo((): ProjectTotals => {
    const rows = resources ?? [];
    const stats = rows.map((r) => readStats(r));
    return {
      databases: rows.length,
      awake: rows.filter((r) => r.state === "running").length,
      bytes: stats.reduce((sum, s) => sum + (s.sizeBytes ?? 0), 0),
      connections: stats.reduce((sum, s) => sum + (s.connectionCount ?? 0), 0),
    };
  }, [resources]);

  return (
    <ProjectContext.Provider
      value={{
        project: project,
        resources: resources,
        totals: totals,
        samples: samples,
        freeBytes: freeBytes,
        reflinkSupported: reflinkSupported,
        error: error,
        windowMs: WINDOW_MS,
        pollMs: POLL_MS,
        refresh: reload,
        createDatabase: createDatabase,
        wake: wake,
        sleep: sleep,
        destroyResource: destroyResource,
        eject: eject,
      }}
    >
      {children}
    </ProjectContext.Provider>
  );
};

export const useProject = () => {
  return useContext(ProjectContext);
};
