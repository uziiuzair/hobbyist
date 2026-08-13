// The resource model: the shapes every other package builds on. No behavior
// here, only data. Kept dependency-free on purpose, see CLAUDE.md: core must
// never import Docker, Postgres, or HTTP.

export type ProjectId = string
export type ResourceId = string

// Phase 1 registered exactly one kind and typed itself honestly around that
// fact. Phase 2 registers two more (docs/compute/specs/2026-08-10-phase-2-compute-design.md),
// and ADR 0007 guard 1 requires the widening to happen before Phase 2 code
// rather than during it: "if Phase 2 requires changing Phase 1's model, the
// model was wrong and gets fixed before Phase 2 proceeds."
export type ResourceKind = 'postgres' | 'app' | 'worker' | 'queue'

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
  // Set when `hobby eject --release` handed this project over. Hobbyist keeps
  // every row and every byte, and stops acting: it will not wake these
  // resources, hibernate them, or reconcile them, because the data directory
  // now belongs to whatever the user started from the emitted compose file.
  // Two Postgres processes on one PGDATA is the failure this prevents, and it
  // is why handing a project over records a state rather than deleting one.
  // `hobby adopt` clears it and takes the project back.
  releasedAt: Date | null
}

// The fields every kind's config carries, so the many existing call sites
// that only ever touch `config.containerName` or `config.hostPort`
// (packages/pg/src/postgres.ts's stop/destroy, store.ts's allocatePort,
// reconcile.ts) keep working against any resource without narrowing first.
// Anything kind-specific lives on the member interfaces below, where the
// compiler will refuse to read it until the caller has checked `kind`.
export interface ResourceConfigBase {
  image: string
  containerName: string
  // Always on loopback, never 0.0.0.0. See DEFAULT_PORT_BIND in runtime.ts
  // for why the bind address, not a host firewall, is the thing that keeps
  // a resource off the network.
  hostPort: number
}

export interface PostgresConfig extends ResourceConfigBase {
  dataDir: string
  superuser: string
  password: string
  database: string
}

// A container the user brought, either built here from their Dockerfile or
// pulled from a registry. Stateless by ADR 0007: no volume is attached, and
// persistence comes from a sibling postgres resource.
export interface AppConfig extends ResourceConfigBase {
  // Absent for an image-based app, present for a source-based one, and it
  // is what a redeploy rebuilds from.
  source: { path: string; dockerfile: string } | null
  // The port the process inside listens on, handed to it as $PORT and
  // published to hostPort. A process that binds 127.0.0.1 inside its own
  // container is unreachable from the host, which is the single most
  // common way this kind fails, so readiness says exactly that when it
  // times out rather than "not ready".
  containerPort: number
  hostname: string
  env: Record<string, string>
  // A sibling postgres resource, if the user bound one. Stored as an id and
  // expanded to a connection string at start, never stored expanded, so a
  // password rotation cannot leave a stale copy behind.
  databaseResourceId: ResourceId | null
}

// A Cloudflare Worker, running on Cloudflare's own runtime. See ADR 0011:
// this is workerd, driven by the miniflare npm package, in a container we
// build, one process per worker resource.
export interface WorkerConfig extends ResourceConfigBase {
  containerPort: number
  hostname: string
  // The directory holding the user's wrangler manifest and entry script,
  // and the name of the manifest file we actually read from it.
  source: { path: string; manifest: string }
  compatibilityDate: string
  compatibilityFlags: string[]
  vars: Record<string, string>
  kvNamespaces: string[]
  r2Buckets: string[]
  d1Databases: string[]
  queues: { producers: string[]; consumers: string[] }
  durableObjects: Array<{ binding: string; className: string }>
  // workerd derives every Durable Object's storage identity from this. If
  // it ever changes, every object's sqlite file is orphaned and the user
  // silently loses state on a redeploy, which is the sharpest data-loss
  // edge in the whole kind. So it is DERIVED, once, from the resource's own
  // id (the randomUUID the store assigns in createResource, which survives
  // rename, redeploy, daemon restart and eject/adopt), and never
  // regenerated. Never derive it from the project or class name: both are
  // user-facing strings a rename would change.
  durableObjectUniqueKeyModifier: string
  databaseResourceId: ResourceId | null
}

// A queue. The only kind with no container: it is a sqlite file the daemon
// owns, plus the rules for draining it. `image`, `containerName` and
// `hostPort` come from ResourceConfigBase and are unused, because every
// existing call site that reads them expects them to exist on any resource
// (see the comment on ResourceConfigBase).
//
// The consumer is stored as a resource id rather than a name so a worker
// rename cannot orphan a queue, which is the same reasoning
// AppConfig.databaseResourceId records.
export interface QueueConfig extends ResourceConfigBase {
  retentionSeconds: number
  consumerResourceId: ResourceId | null
  maxBatchSize: number
  maxBatchTimeoutSeconds: number
  maxRetries: number
  retryDelaySeconds: number
  // The NAME of another queue in the same project, not an id: it is what the
  // user wrote in wrangler.toml, and Cloudflare creates it if it is missing,
  // so it can legitimately name a queue that does not exist yet.
  deadLetterQueue: string | null
}

export type ResourceConfig = PostgresConfig | AppConfig | WorkerConfig | QueueConfig

interface ResourceBase {
  id: ResourceId
  projectId: ProjectId
  name: string
  state: ResourceState
  lastActiveAt: Date | null
  createdAt: Date
}

// Discriminated on `kind`, which is already its own column in the store's
// schema (see store.ts's CREATE TABLE resources), so widening the model
// needs no row migration: every existing row already carries the tag.
export interface PostgresResource extends ResourceBase {
  kind: 'postgres'
  config: PostgresConfig
}

export interface AppResource extends ResourceBase {
  kind: 'app'
  config: AppConfig
}

export interface WorkerResource extends ResourceBase {
  kind: 'worker'
  config: WorkerConfig
}

export interface QueueResource extends ResourceBase {
  kind: 'queue'
  config: QueueConfig
}

export type Resource = PostgresResource | AppResource | WorkerResource | QueueResource

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
