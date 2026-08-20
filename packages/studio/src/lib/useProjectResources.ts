import { useCallback, useEffect, useState } from "react";
import type { Project, Resource } from "@hobby.sh/core";
import * as api from "../api.js";

// Every list page needs the same two facts, the project and what is in it, and
// gets them from the one route that returns both. It is a hook rather than a
// provider because these pages are siblings, never nested: a provider would
// have to be mounted in App around all of them, and App is mid-refactor.
export interface ProjectResources {
  project: Project | null;
  resources: Resource[] | null;
  error: string | null;
  refresh: () => void;
}

export function useProjectResources(projectName: string): ProjectResources {
  const [project, setProject] = useState<Project | null>(null);
  const [resources, setResources] = useState<Resource[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    api
      .getProject(projectName)
      .then((detail) => {
        setProject(detail.project);
        setResources(detail.resources);
        setError(null);
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : String(err));
      });
  }, [projectName]);

  useEffect(() => {
    // Cleared before the fetch, not after it: without this the previous
    // project's rows stay on screen under the new project's title for as long
    // as the request takes, which reads as data belonging to the new one.
    setProject(null);
    setResources(null);
    setError(null);
    refresh();
  }, [projectName, refresh]);

  return {
    project: project,
    resources: resources,
    error: error,
    refresh: refresh,
  };
}
