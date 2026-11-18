// What a routing key means: the half of ProxyDeps that only reads the store.
//
// Shared by the two places a proxy runs. In the daemon, createProxyDeps
// (context.ts) calls it against the daemon's own Store. In the separate proxy
// process (packages/cli/src/proxyd/host.ts) it runs against state.db opened
// read-only, which is what lets a connection to a running database be routed
// while the daemon is down (docs/proxy/specs/2026-11-18-proxy-outlives-the-daemon.md).
// One implementation, so the two can never disagree about a routing key.
//
// Synchronous: both stores are synchronous sqlite, and ProxyDeps.resolve wraps
// the answer in a promise.

import { DEFAULT_POSTGRES_NAME, HobbyError, type PostgresResource, type Store } from '@hobby.sh/core'
import type { ProxyTarget } from '@hobby.sh/proxy'

export type RoutingReader = Pick<Store, 'getProject' | 'getProjectByName' | 'listResources'>

// The project's IP allowlist, read per connection (access.ts in @hobby.sh/proxy).
export function allowlistOf(store: RoutingReader, projectName: string): string[] | null {
  return store.getProjectByName(projectName)?.allowlist ?? null
}

export function resolveProxyTarget(store: RoutingReader, projectName: string, databaseSegment: string | null = null): ProxyTarget | null {
  const project = store.getProjectByName(projectName)
  if (project === null) {
    return null
  }

  // A released project is one hobby handed over: its data directory now
  // belongs to whatever the user started from the emitted compose file.
  // Waking it here would open a second postgres on that same PGDATA, which
  // is not a conflict the user gets an error about, it is corruption. The
  // rows are all still here, which is why this is a refusal with a reason
  // rather than a "no such project".
  if (project.releasedAt != null) {
    throw new HobbyError(
      'conflict',
      `project ${projectName} was released and is no longer managed by hobby`,
      'it is running from the compose file hobby eject --release gave you. Run `hobby adopt ' +
        projectName +
        '` to take it back, after stopping that stack.'
    )
  }

  // Only postgres resources are candidates. Port 5432 speaks one protocol
  // and a startup packet cannot name an app or a worker, so a project
  // holding a database and two apps must still route cleanly to the
  // database rather than reading as ambiguous. Filtering by kind here,
  // before the count checks below, is what keeps that true: without it,
  // deploying an app to a project would have broken psql against its
  // database, which is exactly the kind of cross-phase breakage ADR 0007
  // guard 1 exists to prevent.
  const resources = store.listResources(project.id).filter((r) => r.kind === 'postgres') as PostgresResource[]
  if (resources.length === 0) {
    return null
  }

  // The routing key's dotted segment names a RESOURCE first (issue #66):
  // `blog.analytics` reaches the postgres called analytics, whatever
  // database it holds inside, and that is the string `hobby connect
  // blog/analytics` prints (core's routingKeyFor, the inverse of this
  // match). Only when no resource has that name does the segment keep its
  // older meaning, a database inside the default resource, substituted on
  // the wire by the proxy. A resource and a database sharing a name is
  // therefore resolved as the resource; name the database through the
  // resource's own direct string if both are wanted.
  const byName = databaseSegment === null ? undefined : resources.find((r) => r.name === databaseSegment)
  if (byName !== undefined) {
    return targetFor(store, byName, true)
  }

  if (resources.length === 1) {
    return targetFor(store, resources[0] as PostgresResource, false)
  }

  // Several, and the key did not name one. The default resource is what a
  // bare project name has always meant, and `hobby new` creates exactly
  // it, so a project that grew a second postgres keeps its first string
  // working, which is what #66 was about: before this, `pg create` cut
  // off the existing database's connection string the moment it ran.
  const primary = resources.find((r) => r.name === DEFAULT_POSTGRES_NAME)
  if (primary !== undefined) {
    return targetFor(store, primary, false)
  }
  // No default to fall back on: the same error identity the CLI's
  // resolveTarget (packages/cli/src/cli/commands.ts) uses for a
  // `project/resource` target it cannot pick, and proxy.ts's try/catch
  // around deps.resolve turns it into a FATAL on the wire.
  throw new HobbyError(
    'ambiguous_target',
    `project ${projectName} has more than one postgres resource and none is named ${DEFAULT_POSTGRES_NAME}: ${resources.map((r) => r.name).join(', ')}`,
    `name one as the database: ${resources.map((r) => `${projectName}.${r.name}`).join(' or ')} (\`hobby connect ${projectName}/<name>\` prints the string)`
  )
}

function targetFor(store: RoutingReader, resource: PostgresResource, databaseSegmentIsResource: boolean): ProxyTarget {
  return {
    resourceId: resource.id,
    label: `${store.getProject(resource.projectId)?.name ?? resource.projectId}/${resource.name}`,
    host: '127.0.0.1',
    port: resource.config.hostPort,
    state: resource.state,
    database: resource.config.database,
    databaseSegmentIsResource,
  }
}
