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
  // A RESTING state, unlike every other member above except `running` and
  // `sleeping`. It means the row exists and no code has ever been uploaded
  // into it, which is the normal condition for an `app` or `worker` created
  // from Studio or MCP. Distinct from `creating`, which means a deploy is in
  // flight right now and which reconcile.ts:43 correctly marks `failed` when
  // no container appears. Here, having no container is expected, forever.
  // Unreachable for `postgres`: its image is a registry reference known at
  // creation, so it has nothing to deploy.
  | 'undeployed'

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
  // Null until a first deploy has produced one. A postgres resource always
  // has an image (a registry reference chosen at creation), so in practice
  // this is null only for an `app` or `worker` in state `undeployed`. Every
  // path that starts a container runs from `running` or `sleeping` and must
  // narrow this first: the compiler is the mechanism that finds them, which
  // is the same technique commit abe7582 used to find every place Phase 1
  // assumed postgres.
  image: string | null
  containerName: string
  // Always on loopback, never 0.0.0.0. See DEFAULT_PORT_BIND in runtime.ts
  // for why the bind address, not a host firewall, is the thing that keeps
  // a resource off the network.
  hostPort: number
}

export interface PostgresConfig extends ResourceConfigBase {
  // Narrowed back to non-null: a postgres resource's image is a registry
  // reference chosen at creation (createPostgres, packages/pg/src/postgres.ts),
  // and `postgres` never registers `undeployed` as a reachable state (see
  // ResourceState above), so there is no postgres config to build before an
  // image exists. Declaring that here, rather than null-checking it at every
  // read in packages/pg, is what keeps createDefaultRemoveDataDir and
  // containerSpec (packages/pg/src/postgres.ts) free of a branch that can
  // never actually run.
  image: string
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

// Everything read out of the user's wrangler manifest. Null until a first
// deploy, because none of it can be known before there is a file to read.
// Split out of WorkerConfig rather than left inline so that the boundary
// between "derived at record creation" and "read from the user's code" is
// structural instead of a comment someone has to notice and honour.
export interface WorkerManifest {
  // The directory holding the user's wrangler manifest and entry script,
  // and the name of the manifest file we actually read from it.
  source: { path: string; manifest: string }
  compatibilityDate: string
  compatibilityFlags: string[]
  vars: Record<string, string>
  kvNamespaces: string[]
  r2Buckets: string[]
  d1Databases: string[]
  // A key the user left out of wrangler.toml stays null here, and is never
  // filled in with a default. The broker owns the defaults, in
  // DEFAULT_CONSUMER_OPTIONS (packages/queue/src/broker.ts); a second copy
  // written at deploy time would freeze whatever the value was on that day
  // and drift from the broker's the moment either changed.
  queues: {
    producers: Array<{ queue: string; binding: string }>
    consumers: Array<{
      queue: string
      maxBatchSize: number | null
      maxBatchTimeoutSeconds: number | null
      maxRetries: number | null
      retryDelaySeconds: number | null
      deadLetterQueue: string | null
    }>
  }
  durableObjects: Array<{ binding: string; className: string }>
}

// A Cloudflare Worker, running on Cloudflare's own runtime. See ADR 0011:
// this is workerd, driven by the miniflare npm package, in a container we
// build, one process per worker resource.
export interface WorkerConfig extends ResourceConfigBase {
  // Ours, not the user's: the port we tell Miniflare to listen on. Known at
  // creation, unlike an app's containerPort, which is whatever the user's
  // process happens to bind and is unknowable before there is code.
  containerPort: number
  // The host-side port the runner's control channel is published on,
  // loopback only, same as hostPort. The daemon posts queue batches here;
  // see docs/queues/specs/2026-08-13-queues-design.md, "Delivery over a
  // second port, not a proxy".
  //
  // Above the manifest split, and it has to stay there. The manifest is
  // rebuilt wholesale on every deploy, so a field that lived inside it would
  // be re-derived on each one: a changed controlPort sends queue batches to
  // a port nothing is listening on.
  controlPort: number
  // The bearer token a container's producer shim sends to the daemon's
  // enqueue listener. Generated once with randomUUID() at resource creation
  // and never regenerated: the reasoning is the same as
  // durableObjectUniqueKeyModifier's below, for a different failure mode. A
  // rotated token is fine (every running container gets restarted with the
  // new one); an ACCIDENTALLY regenerated one is not, because it would
  // silently break a producer that is still holding the old value. Must
  // never be handed out over the wire boundary unredacted: see
  // packages/cli/src/daemon/wire.ts's redactConfig.
  //
  // Above the manifest split for the same reason controlPort is: rotating it
  // on every deploy would give already-running containers 401s from the
  // enqueue listener, which reads as a broker outage rather than a token
  // problem.
  queueToken: string
  hostname: string
  databaseResourceId: ResourceId | null

  // workerd derives every Durable Object's storage identity from this. If
  // it ever changes, every object's sqlite file is orphaned and the user
  // silently loses state on a redeploy, which is the sharpest data-loss
  // edge in the whole kind. So it is DERIVED, once, from the resource's own
  // id (the randomUUID the store assigns in createResource, which survives
  // rename, redeploy, daemon restart and eject/adopt), and never
  // regenerated. Never derive it from the project or class name: both are
  // user-facing strings a rename would change.
  //
  // It sits above the manifest split because it exists before any code
  // does. A worker created from Studio has a stable object identity from
  // the moment the row exists, which is strictly better than deriving it in
  // the same breath as a first build.
  durableObjectUniqueKeyModifier: string

  manifest: WorkerManifest | null
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
  // Null until a consumer's deployed manifest actually sets one, and null
  // again whenever that manifest omits the key, mirroring
  // WorkerManifest.queues.consumers's own comment above verbatim: the broker
  // owns the defaults (DEFAULT_CONSUMER_OPTIONS, packages/queue/src/broker.ts),
  // applied where this config is read (packages/cli/src/daemon/queues.ts's
  // drainableQueues), never stamped into the row. Stamping a default in here
  // at creation was the actual defect a fix round found: a queue created
  // before any worker had deployed held concrete numbers nothing had ever
  // configured, indistinguishable from a value a deploy genuinely set.
  maxBatchSize: number | null
  maxBatchTimeoutSeconds: number | null
  maxRetries: number | null
  retryDelaySeconds: number | null
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
