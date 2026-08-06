// Rendering a psql-ready connection string. The database segment is always
// the project name: the whole point of createPostgres naming the in-container
// database after the project (see postgres.ts) is that the proxy can route on
// it, and a human-facing connection string should show the same name back.

import type { Project, Resource } from '@hobby.sh/core'

export function connectionString(
  project: Project,
  resource: Resource,
  opts: { host: string; port: number; viaProxy: boolean }
): string {
  // viaProxy does not change the shape of the rendered string. The proxy
  // speaks the same wire protocol against the same routing key (the project
  // name), so the entire difference between "postgres://.../<project> via
  // the proxy" and "postgres://.../<project> straight at the container" is
  // which port the caller passes in opts.port: config.proxyPort for
  // viaProxy: true, resource.config.hostPort for viaProxy: false. The flag
  // is kept in the signature (matching the brief and what Task 6's proxy
  // will call this with) as a documented seam for a future divergence
  // between the two forms, e.g. a query parameter that only makes sense for
  // one of them, without needing another signature change.
  const user = encodeURIComponent(resource.config.superuser)
  const password = encodeURIComponent(resource.config.password)
  return `postgres://${user}:${password}@${opts.host}:${opts.port}/${project.name}`
}
