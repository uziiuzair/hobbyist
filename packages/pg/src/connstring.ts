// Rendering a psql-ready connection string. viaProxy picks which port gets
// rendered: opts.proxyPort when going through the wake-on-connect proxy,
// resource.config.hostPort for a direct connection to the container. The
// caller no longer chooses the port itself, which is what makes viaProxy
// load-bearing rather than a flag the function ignores.
//
// The database segment depends on which way the string goes. Direct to the
// container, it is resource.config.database, the database Postgres itself
// holds. Through the proxy, it is the ROUTING KEY (core's routingKeyFor):
// the project name for the default resource, `project.resource` for any
// other. Before this (issue #66) every resource rendered the project name,
// so a second postgres in a project got a string identical to the first's
// that the proxy could not route, and the first's stopped working too.

import { routingKeyFor, type PostgresResource, type Project } from '@hobby.sh/core'

// Takes a PostgresResource, not a Resource. Since the model was widened for
// Phase 2 (packages/core/src/types.ts), `Resource` is a union and an app or
// a worker has no superuser, no password and no database to render. The
// narrower parameter is what makes every caller prove it has a postgres in
// hand before asking for a Postgres connection string.
export function connectionString(
  project: Project,
  resource: PostgresResource,
  opts: { host: string; proxyPort: number; viaProxy: boolean }
): string {
  const user = encodeURIComponent(resource.config.superuser)
  const password = encodeURIComponent(resource.config.password)
  const port = opts.viaProxy ? opts.proxyPort : resource.config.hostPort
  const database = opts.viaProxy ? routingKeyFor(project.name, resource.name) : resource.config.database
  return `postgres://${user}:${password}@${opts.host}:${port}/${database}`
}
