// The resource model: the shapes every other package builds on. No behavior
// here, only data. Kept dependency-free on purpose, see CLAUDE.md: core must
// never import Docker, Postgres, or HTTP.

export type ProjectId = string
export type ResourceId = string

export type ResourceKind = 'postgres'

export type ResourceState =
  | 'creating'
  | 'running'
  | 'starting'
  | 'sleeping'
  | 'stopping'
  | 'failed'
  | 'destroying'

export interface Project {
  id: ProjectId
  name: string
  networkName: string
  sleepAfterSeconds: number | null
  createdAt: Date
}

export interface Resource {
  id: ResourceId
  projectId: ProjectId
  kind: ResourceKind
  name: string
  state: ResourceState
  config: PostgresConfig
  lastActiveAt: Date | null
  createdAt: Date
}

export interface PostgresConfig {
  image: string
  containerName: string
  dataDir: string
  hostPort: number
  superuser: string
  password: string
  database: string
}

// The write half of the proxy's ActivityTracker
// (packages/proxy/src/activity.ts), named here so packages that must report
// activity without depending on the proxy can take it as a dependency:
// @hobby.sh/pg's startPostgres/stopPostgres are the two places a resource
// becomes usable or stops being usable, whoever asked for it (a proxy
// connection, `hobby wake`, Studio). Before this existed, only the proxy
// ever reported activity, so a resource woken any other way had no idle
// clock and hibernation skipped it forever. Declared in core, with no
// behavior attached, because core is the one package everything already
// depends on and this must never become a dependency edge from pg to proxy.
export interface ActivitySink {
  // "This resource was used just now." Starts (or restarts) its idle clock
  // from this instant.
  touch(resourceId: ResourceId): void
  // "Forget everything about this resource." Called when it stops or is
  // destroyed: a connection count and an idle clock that describe a
  // container which no longer exists are worse than no information at all,
  // because hibernation would act on them.
  reset(resourceId: ResourceId): void
}
