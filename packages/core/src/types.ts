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
