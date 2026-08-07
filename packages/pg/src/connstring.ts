// Rendering a psql-ready connection string. viaProxy picks which port gets
// rendered: opts.proxyPort when going through the wake-on-connect proxy,
// resource.config.hostPort for a direct connection to the container. The
// caller no longer chooses the port itself, which is what makes viaProxy
// load-bearing rather than a flag the function ignores.
//
// The database segment comes from resource.config.database, not
// project.name. They are equal by construction (createPostgres names the
// in-container database after the project, see postgres.ts), but the
// config is the actual value that governs what the proxy and psql both see,
// and there should be exactly one source of truth for it.

import type { Project, Resource } from '@hobby.sh/core'

export function connectionString(
  project: Project,
  resource: Resource,
  opts: { host: string; proxyPort: number; viaProxy: boolean }
): string {
  // project is accepted for symmetry with the resource-kind functions above
  // it and because callers already have both objects in hand at every call
  // site; the rendered string itself no longer reads project.name (see the
  // file comment on resource.config.database).
  const user = encodeURIComponent(resource.config.superuser)
  const password = encodeURIComponent(resource.config.password)
  const port = opts.viaProxy ? opts.proxyPort : resource.config.hostPort
  return `postgres://${user}:${password}@${opts.host}:${port}/${resource.config.database}`
}
