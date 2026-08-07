// Tables, Sql and Schema all address a resource by (project, resource)
// name pair from the URL (see router.ts) but every daemon route below the
// project level takes a resource id. This resolves the pair once via the
// existing GET /v1/projects/:name route and hands back the live Resource,
// which also doubles as the "was it running when we started" signal the
// waking treatment (useWaking.ts) needs.

import { useCallback, useEffect, useState } from 'react'
import type { Resource } from '@hobby.sh/core'
import * as api from '../api.js'

export interface ResourceLookup {
  resource: Resource | null
  error: string | null
  refresh: () => void
}

export function useResource(projectName: string, resourceName: string): ResourceLookup {
  const [resource, setResource] = useState<Resource | null>(null)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(() => {
    api
      .getProject(projectName)
      .then(({ resources }) => {
        const match = resources.find((r) => r.name === resourceName)
        if (match === undefined) {
          setError(`no resource named ${resourceName} in ${projectName}`)
          return
        }
        setResource(match)
        setError(null)
      })
      .catch((err: unknown) => {
        setError(err instanceof api.ApiError ? err.message : 'could not reach the daemon')
      })
  }, [projectName, resourceName])

  useEffect(() => {
    refresh()
  }, [refresh])

  return { resource, error, refresh }
}
