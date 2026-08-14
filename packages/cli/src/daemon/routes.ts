// The exact route list from the task brief, dispatched by hand rather than
// through a framework (the global constraint is plain node:http, no web
// framework). Fixed, small and enumerable, a manual match is more legible
// here than a regex router would be, and it is the only place in the
// package that needs to know the URL shape at all.
//
// Every handler either returns a { status, body } pair or throws. dispatch
// never catches: handleRequest is the single place that turns a throw into
// a wire-shaped error response, so every route gets identical error
// handling for free and none of them can accidentally diverge from it.

import type { IncomingMessage, ServerResponse } from 'node:http'
import { existsSync } from 'node:fs'
import {
  DEFAULT_PORT_BIND,
  HobbyError,
  openDatabaseReadOnly,
  validateName,
  type AppResource,
  type PostgresResource,
  type QueueConfig,
  type QueueResource,
  type SqliteDatabase,
  type WorkerResource,
  type Project,
  type Resource,
} from '@hobby.sh/core'
import { createAppResource, deployApp, type AppSource } from '@hobby.sh/app'
import { connectionString, createPostgres, runQuery } from '@hobby.sh/pg'
import {
  DEFAULT_RETENTION_SECONDS,
  MAX_RETENTION_SECONDS,
  MIN_RETENTION_SECONDS,
  decodeBody,
  depth as queueDepth,
  encodeBody,
  enqueue,
  openQueueDb,
  peek,
  purge,
  queueDbPath,
  type ContentType,
  type LeasedMessage,
} from '@hobby.sh/queue'
import { buildRunnerManifest, createWorkerResource, deployWorker, describeIgnored } from '@hobby.sh/worker'
import { getOrCreateWake, type DaemonContext } from './context.js'
import { runPreflight } from './preflight.js'
import { toWireResource, toWireResources, type WireResource } from './wire.js'

interface RouteResult {
  status: number
  body: unknown
}

const MAX_BODY_BYTES = 64 * 1024
const DEFAULT_LOG_TAIL = 200

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    let settled = false

    const fail = (err: Error): void => {
      if (settled) return
      settled = true
      reject(err)
    }

    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        fail(new HobbyError('usage', 'request body too large', `limit is ${MAX_BODY_BYTES} bytes`))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })

    req.on('end', () => {
      if (settled) return
      if (chunks.length === 0) {
        settled = true
        resolve({})
        return
      }
      try {
        const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        settled = true
        resolve(parsed)
      } catch {
        fail(new HobbyError('usage', 'invalid JSON body', 'the request body must be valid JSON'))
      }
    })

    req.on('error', fail)
  })
}

function getProjectByNameOrThrow(ctx: DaemonContext, name: string): Project {
  const project = ctx.store.getProjectByName(name)
  if (project === null) {
    throw new HobbyError('project_not_found', `no project named ${name}`)
  }
  return project
}

function getResourceOrThrow(ctx: DaemonContext, id: string): Resource {
  const resource = ctx.store.getResource(id)
  if (resource === null) {
    throw new HobbyError('resource_not_found', `no resource with id ${id}`)
  }
  return resource
}

// The narrowing gate for the handful of routes that are genuinely
// Postgres-only: a connection string and an ad-hoc SQL query mean nothing
// for an app or a worker. Everything else in this file dispatches through
// the kind registry instead and never needs to know.
//
// `usage`, not `internal`: asking Studio for a connection string against an
// app is a reasonable mistake for a caller to make, and the message names
// the actual kind so the caller can see why.
function expectPostgres(resource: Resource, what: string): PostgresResource {
  if (resource.kind !== 'postgres') {
    throw new HobbyError(
      'usage',
      `resource ${resource.name} is a ${resource.kind}, and ${what} is only meaningful for a postgres resource`
    )
  }
  return resource
}

// The same narrowing gate as expectPostgres, for the handful of routes below
// that are genuinely queue-only: peeking, sending and purging messages, and
// setting retention, mean nothing for a postgres, app or worker resource.
function expectQueue(resource: Resource, what: string): QueueResource {
  if (resource.kind !== 'queue') {
    throw new HobbyError(
      'usage',
      `resource ${resource.name} is a ${resource.kind}, and ${what} is only meaningful for a queue`
    )
  }
  return resource
}

function getOwningProjectOrThrow(ctx: DaemonContext, resource: Resource): Project {
  const project = ctx.store.getProject(resource.projectId)
  if (project === null) {
    throw new HobbyError(
      'internal',
      `resource ${resource.id} has no owning project (project ${resource.projectId} is gone)`
    )
  }
  return project
}

async function createProjectRoute(ctx: DaemonContext, req: IncomingMessage): Promise<Project> {
  const body = await readJsonBody(req)
  const name = isRecord(body) ? body['name'] : undefined
  if (typeof name !== 'string' || name.length === 0) {
    throw new HobbyError('usage', 'name is required', 'POST /v1/projects expects { "name": string }')
  }
  validateName(name)
  return ctx.store.createProject({ name, sleepAfterSeconds: ctx.config.sleepAfterSeconds })
}

async function getProjectRoute(ctx: DaemonContext, name: string): Promise<RouteResult> {
  const project = getProjectByNameOrThrow(ctx, name)
  const resources = ctx.store.listResources(project.id)
  return { status: 200, body: { project, resources: await toWireResources(ctx, resources) } }
}

// Best-effort teardown, same shape as destroyPostgres's own contract: every
// resource is deleted from the store regardless of whether its container or
// data directory actually came down cleanly (destroyPostgres guarantees
// that on its own), failures are collected rather than swallowed, and a
// single error naming all of them is thrown only after the project row
// itself is gone. Marking each resource `destroying` before tearing it down
// is what lets reconcile resume this exact operation if the daemon dies
// partway through it, see reconcile.ts.
async function deleteProjectRoute(ctx: DaemonContext, name: string): Promise<RouteResult> {
  const project = getProjectByNameOrThrow(ctx, name)
  const resources = ctx.store.listResources(project.id)
  const failures: string[] = []

  for (const resource of resources) {
    ctx.store.setResourceState(resource.id, 'destroying')
    try {
      await ctx.kinds.get(resource.kind).destroy(ctx, resource)
    } catch (err) {
      failures.push(`${resource.name}: ${errorMessage(err)}`)
    }
  }

  // The project's network goes with it. Nothing else ever removed one, so
  // every project ever created left a network behind on the box: harmless
  // individually, and a growing list in `docker network ls` that the user
  // cannot attribute to anything still running. Attempted after the
  // containers, because a network with an attached container cannot be
  // removed, and collected rather than thrown for the same reason as the
  // resource failures above.
  try {
    await ctx.runtime.removeNetwork(project.networkName)
  } catch (err) {
    failures.push(`remove network ${project.networkName}: ${errorMessage(err)}`)
  }

  ctx.store.deleteProject(project.id)

  if (failures.length > 0) {
    throw new HobbyError(
      'internal',
      `project ${name} was deleted, but ${failures.length} teardown step(s) did not complete cleanly: ${failures.join('; ')}`,
      'a container, network or data directory may still remain and may need manual cleanup'
    )
  }

  return { status: 200, body: { deleted: true } }
}

// The default port an app's process is asked to listen on. Handed to the
// container as $PORT, so an image that reads it needs no configuration at
// all, and an image that hardcodes something else declares it here.
const DEFAULT_APP_PORT = 3000

function readAppSource(body: Record<string, unknown>): AppSource | null {
  const source = body['source']
  if (!isRecord(source)) {
    return null
  }
  const path = source['path']
  if (typeof path !== 'string' || path.length === 0) {
    return null
  }
  const dockerfile = source['dockerfile']
  return { path, dockerfile: typeof dockerfile === 'string' && dockerfile.length > 0 ? dockerfile : 'Dockerfile' }
}

function readStringMap(value: unknown): Record<string, string> {
  if (!isRecord(value)) {
    return {}
  }
  const out: Record<string, string> = {}
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === 'string') {
      out[key] = entry
    }
  }
  return out
}

// The one place a queue resource is built: from `hobby queue create` /
// POST /v1/projects/:name/resources with kind 'queue' (createResourceRoute
// below), and from syncWorkerQueueBindings (further down) auto-creating one
// a deployed worker's manifest names but that does not exist yet, matching
// the spec's own promise that a queue named in a binding is created if
// missing, the same way Cloudflare itself behaves.
//
// No dedicated createQueueResource function exists in @hobby.sh/queue
// (unlike createPostgres/createAppResource/createWorkerResource): a queue's
// row is just its defaults, so validateName plus store.createResource is
// the whole of it.
//
// The four tuning fields are seeded null, not DEFAULT_CONSUMER_OPTIONS's
// concrete numbers: see QueueConfig's own comment (packages/core/src/types.ts)
// for why a stamped default is a second source of truth that drifts. A
// producer-only queue, or one auto-created for a not-yet-deployed consumer,
// genuinely has no tuning configured yet, and null says so honestly.
//
// Exported, alongside syncWorkerQueueBindings below, so routes.test.ts can
// exercise the manifest-to-store wiring directly against a DaemonContext
// without also having to drive a full worker deploy (a real build and a
// real readiness probe, which this daemon's test harness has no seam to
// fake for a worker the way postgres's probeFactory lets it fake postgres).
// Nothing in production calls either of these except the two routes below.
export async function createQueueResource(ctx: DaemonContext, project: Project, name: string): Promise<QueueResource> {
  validateName(name)
  const config: QueueConfig = {
    // image, containerName and hostPort are unused for this kind (see
    // QueueConfig's own comment on ResourceConfigBase): every field here
    // matches the shape kind-dispatch and queue-kind tests already fix as
    // this kind's zero value, so a resource built by this route and one
    // built by a test fixture are never distinguishable later.
    image: '',
    containerName: '',
    hostPort: 0,
    retentionSeconds: DEFAULT_RETENTION_SECONDS,
    consumerResourceId: null,
    maxBatchSize: null,
    maxBatchTimeoutSeconds: null,
    maxRetries: null,
    retryDelaySeconds: null,
    deadLetterQueue: null,
  }
  const resource = ctx.store.createResource({ projectId: project.id, kind: 'queue', name, config })
  // start() only creates the sqlite file (queueKindHandler.start,
  // packages/queue/src/kind.ts): synchronous, cheap, and nothing to poll
  // for readiness the way a container has. A queue is `running` from the
  // moment it exists and never anything else (queue-kind.test.ts's own
  // header comment), which is what lets the hibernator and reconcile both
  // treat every queue row identically forever.
  await ctx.kinds.get('queue').start(ctx, resource)
  ctx.store.setResourceState(resource.id, 'running')
  const created = getResourceOrThrow(ctx, resource.id)
  if (created.kind !== 'queue') {
    throw new HobbyError('internal', `queue ${name} was created but reads back as a ${created.kind}`)
  }
  return created
}

async function createResourceRoute(ctx: DaemonContext, req: IncomingMessage, projectName: string): Promise<Resource> {
  const project = getProjectByNameOrThrow(ctx, projectName)
  const body = await readJsonBody(req)
  const fields = isRecord(body) ? body : {}
  const kind = fields['kind']
  const name = fields['name']

  if (typeof name !== 'string' || name.length === 0) {
    throw new HobbyError(
      'usage',
      'name is required',
      'POST /v1/projects/:name/resources expects { "kind": "postgres" | "app" | "worker", "name": string }'
    )
  }

  if (kind === 'postgres') {
    return createPostgres(ctx, { project, name })
  }

  if (kind === 'app') {
    const source = readAppSource(fields)
    const image = typeof fields['image'] === 'string' && fields['image'].length > 0 ? fields['image'] : null
    const rawPort = fields['port']
    const containerPort = typeof rawPort === 'number' && Number.isInteger(rawPort) ? rawPort : DEFAULT_APP_PORT
    const databaseResourceId =
      typeof fields['databaseResourceId'] === 'string' ? fields['databaseResourceId'] : null

    return createAppResource(ctx, {
      project,
      name,
      source,
      image,
      containerPort,
      env: readStringMap(fields['env']),
      databaseResourceId,
    })
  }

  if (kind === 'worker') {
    // Sourceless is legal now: the row, its id and its hostname are
    // allocated first, and code arrives later through deploy (see
    // createWorkerResource, packages/worker/src/worker.ts). readAppSource
    // already returns null when no source was given, so there is nothing
    // left to reject here.
    const source = readAppSource(fields)
    const databaseResourceId =
      typeof fields['databaseResourceId'] === 'string' ? fields['databaseResourceId'] : null

    const result = await createWorkerResource(ctx, {
      project,
      name,
      sourcePath: source === null ? null : source.path,
      databaseResourceId,
    })
    // Every wrangler key we read and did not act on, reported at the moment
    // the user is watching. Silence here is how a platform earns a
    // reputation for lying about a config file the user believes is
    // authoritative.
    for (const line of describeIgnored(result.ignored)) {
      console.error(`worker ${name}: ignoring ${line}`)
    }
    return result.resource
  }

  if (kind === 'queue') {
    return createQueueResource(ctx, project, name)
  }

  throw new HobbyError(
    'usage',
    `unsupported resource kind: ${String(kind)}`,
    `registered kinds: ${ctx.kinds.kinds().join(', ')}`
  )
}

// The spec's own promise: a queue named in a deployed manifest's producers,
// consumers, or a consumer's dead letter queue is created if it does not
// exist yet, the same way Cloudflare itself auto-creates a missing one.
// Runs on every worker deploy that produces a non-null manifest, which is
// what lets a queue binding written into wrangler.toml be usable the moment
// the deploy that declares it succeeds, with no separate `hobby queue
// create` step required first.
//
// Three things happen here, in order:
//   1. every named queue exists, created via createQueueResource above (the
//      same defaults `hobby queue create` uses) if it did not already.
//   2. every consumer entry claims its queue: consumerResourceId is set to
//      this worker, and its non-null tuning keys are copied onto the row
//      (QueueConfig's own comment explains why only non-null ones). A queue
//      already consumed by a DIFFERENT worker refuses the whole call rather
//      than silently moving the binding: Cloudflare allows exactly one
//      consumer per queue, and the deploy trying to add a second one is the
//      one that is wrong. This was an open question the spec never
//      resolved; refusing loudly is the safer default; see the task report.
//   3. any queue this worker used to consume that its current manifest no
//      longer names is released back to consumerResourceId: null. A stale
//      pointer would leave the tick delivering to a worker with no handler
//      for it, which is worse than delivering to nobody.
//
// Lives beside deployResourceRoute rather than inside deployWorker
// (packages/worker/src/worker.ts) because this is a join between a
// manifest and OTHER resources in the same project, and WorkerDeps
// deliberately carries no KindRegistry: nothing else in that package ever
// creates a sibling resource, and giving it one only for this would widen a
// dependency the rest of that package does not need. By the time this
// function runs, deployWorker has already parsed and persisted the
// manifest and started and stopped the container to prove it serves; only
// the HTTP response, which is what "reported deployed" means to a caller,
// is still pending.
export async function syncWorkerQueueBindings(ctx: DaemonContext, project: Project, worker: WorkerResource): Promise<void> {
  const manifest = worker.config.manifest
  if (manifest === null) {
    return
  }

  // Every name this manifest references at all, producer or consumer or
  // dead letter target, deduplicated: a name in more than one role is only
  // ever created once.
  const names = new Set<string>()
  for (const producer of manifest.queues.producers) {
    names.add(producer.queue)
  }
  for (const consumer of manifest.queues.consumers) {
    names.add(consumer.queue)
    if (consumer.deadLetterQueue !== null) {
      names.add(consumer.deadLetterQueue)
    }
  }

  const byName = new Map<string, QueueResource>()
  for (const name of names) {
    const existing = ctx.store.getResourceByName(project.id, name)
    if (existing === null) {
      byName.set(name, await createQueueResource(ctx, project, name))
      continue
    }
    if (existing.kind !== 'queue') {
      throw new HobbyError(
        'usage',
        `${worker.name}'s wrangler config names a queue "${name}", but ${project.name}/${name} is already a ${existing.kind}`,
        `rename the queue in ${worker.name}'s wrangler config, or rename the existing ${existing.kind}`
      )
    }
    byName.set(name, existing)
  }

  // Consumer bindings, claimed one at a time. Checked before anything is
  // written for THIS consumer entry, so a conflict discovered on the second
  // of two consumer entries in one manifest cannot leave the first one's
  // claim written while the call as a whole still throws.
  for (const consumerEntry of manifest.queues.consumers) {
    const queue = byName.get(consumerEntry.queue)
    if (queue === undefined) {
      // Created (or refused) in the loop above; only reachable here if that
      // loop already threw, which propagated out of this function first.
      continue
    }
    if (queue.config.consumerResourceId !== null && queue.config.consumerResourceId !== worker.id) {
      const other = ctx.store.getResource(queue.config.consumerResourceId)
      const otherName = other === null ? queue.config.consumerResourceId : other.name
      throw new HobbyError(
        'usage',
        `queue ${queue.name} already has worker ${otherName} as its consumer, and worker ${worker.name} also declares itself one`,
        `a queue can have exactly one consumer; remove the [[queues.consumers]] block naming ${queue.name} from ${worker.name} or from ${otherName}`
      )
    }

    const config: QueueConfig = { ...queue.config, consumerResourceId: worker.id }
    if (consumerEntry.maxBatchSize !== null) {
      config.maxBatchSize = consumerEntry.maxBatchSize
    }
    if (consumerEntry.maxBatchTimeoutSeconds !== null) {
      config.maxBatchTimeoutSeconds = consumerEntry.maxBatchTimeoutSeconds
    }
    if (consumerEntry.maxRetries !== null) {
      config.maxRetries = consumerEntry.maxRetries
    }
    if (consumerEntry.retryDelaySeconds !== null) {
      config.retryDelaySeconds = consumerEntry.retryDelaySeconds
    }
    if (consumerEntry.deadLetterQueue !== null) {
      config.deadLetterQueue = consumerEntry.deadLetterQueue
    }
    ctx.store.updateResourceConfig(queue.id, config)
    byName.set(queue.name, { ...queue, config })
  }

  // Release a stale claim: this worker consumed a queue before and its
  // current manifest no longer names it. Scoped to consumerResourceId ===
  // worker.id specifically, never to a queue this worker merely produces to
  // or does not mention at all, so an unrelated queue's binding is never
  // touched by someone else's deploy.
  const stillConsumed = new Set(manifest.queues.consumers.map((c) => c.queue))
  for (const candidate of ctx.store.listResources(project.id)) {
    if (candidate.kind !== 'queue') {
      continue
    }
    if (candidate.config.consumerResourceId !== worker.id) {
      continue
    }
    if (stillConsumed.has(candidate.name)) {
      continue
    }
    ctx.store.updateResourceConfig(candidate.id, { ...candidate.config, consumerResourceId: null })
  }
}

// Rebuild an app from its source and prove the result serves before calling
// it deployed. Postgres has no equivalent and answers `usage` rather than
// pretending: there is nothing to build.
async function deployResourceRoute(ctx: DaemonContext, req: IncomingMessage, id: string): Promise<RouteResult> {
  const resource = getResourceOrThrow(ctx, id)
  const body = await readJsonBody(req)
  const source = isRecord(body) ? readAppSource(body) : null

  if (resource.kind === 'app') {
    const result = await deployApp(ctx, resource, source === null ? {} : { source })
    return {
      status: 200,
      body: {
        resource: await toWireResource(ctx, result.resource),
        image: result.image,
        logs: result.logs,
      },
    }
  }

  if (resource.kind === 'worker') {
    const result = await deployWorker(ctx, resource, source === null ? {} : { sourcePath: source.path })
    for (const line of describeIgnored(result.ignored)) {
      console.error(`worker ${resource.name}: ignoring ${line}`)
    }
    // After the manifest is parsed and persisted and the container has
    // proven it serves (both already true by the time deployWorker
    // returns), before the caller is ever told this deploy succeeded. A
    // conflict here (syncWorkerQueueBindings's two-consumers refusal) throws
    // and this route's response is an error, even though the worker's
    // image, manifest and container are already committed: there is no
    // second transaction spanning both, the same way an app or worker whose
    // build succeeds but whose readiness probe times out still keeps its
    // built image. The fix is editing the manifest and deploying again, not
    // retrying blindly.
    const project = getOwningProjectOrThrow(ctx, result.resource)
    await syncWorkerQueueBindings(ctx, project, result.resource)
    return {
      status: 200,
      body: {
        resource: await toWireResource(ctx, result.resource),
        image: result.image,
        ignored: result.ignored,
        logs: result.logs,
      },
    }
  }

  throw new HobbyError(
    'usage',
    `resource ${resource.name} is a ${resource.kind}, and only an app or a worker can be deployed`
  )
}

// The three lifecycle routes are kind-agnostic and were the last places in
// the daemon that named Postgres. `hobby rm`, `hobby sleep` and `hobby wake`
// now mean the same thing for a database, an app and a worker, which is what
// makes the wedge ("everything sleeps, everything wakes on demand") one
// mechanism rather than three.
// Every worker in the queue's own project whose DEPLOYED manifest names this
// queue, either as a consumer or as a producer, plus the stored consumer
// relationship itself. Two sources rather than one: consumerResourceId is
// the join drainableQueues (daemon/queues.ts) already trusts for delivery,
// but nothing before this route has ever required it to be set, so a worker
// whose manifest declares a binding is checked too, independently, so a
// producer that would start throwing `env.X.send()` errors the moment this
// queue vanished is caught even when consumerResourceId was never wired up.
// Returns the first binder found; there is exactly one refusal message to
// write regardless of how many exist.
function findBindingWorker(ctx: DaemonContext, queue: QueueResource): WorkerResource | null {
  if (queue.config.consumerResourceId !== null) {
    const consumer = ctx.store.getResource(queue.config.consumerResourceId)
    if (consumer !== null && consumer.kind === 'worker') {
      return consumer
    }
  }
  for (const candidate of ctx.store.listResources(queue.projectId)) {
    if (candidate.kind !== 'worker' || candidate.config.manifest === null) {
      continue
    }
    const { producers, consumers } = candidate.config.manifest.queues
    if (producers.some((p) => p.queue === queue.name) || consumers.some((c) => c.queue === queue.name)) {
      return candidate
    }
  }
  return null
}

async function destroyResourceRoute(ctx: DaemonContext, id: string): Promise<RouteResult> {
  const resource = getResourceOrThrow(ctx, id)
  // Refused before anything is torn down, and before state ever moves to
  // `destroying`: deleting a queue out from under a worker that still binds
  // it turns a working `env.X.send()`/`queue()` handler into a silent
  // failure the moment the container is next deployed or restarted, with
  // nothing in the worker's own logs pointing back at a queue that used to
  // exist. `hobby rm` and `hobby queue rm` both go through this one route
  // (root CLAUDE.md: the daemon API is the only control surface), so neither
  // can diverge from the other on this.
  if (resource.kind === 'queue') {
    const binder = findBindingWorker(ctx, resource)
    if (binder !== null) {
      throw new HobbyError(
        'usage',
        `queue ${resource.name} is still bound to worker ${binder.name}, refusing to delete it`,
        `remove the queue binding from ${binder.name}'s wrangler config and redeploy, or delete ${binder.name} first`
      )
    }
  }
  ctx.store.setResourceState(resource.id, 'destroying')
  await ctx.kinds.get(resource.kind).destroy(ctx, resource)
  return { status: 200, body: { deleted: true } }
}

// Shared refusal for the two lifecycle routes below, checked before either
// dispatches to the kind registry. An `undeployed` resource has never had a
// container (that is the whole point of the state, see ADR 0014's
// "`undeployed` is a state, not a derived condition"), so letting either verb
// through corrupts it: `stop` (runtime.stop on a container that never
// existed is a documented no-op) completed and wrote `sleeping` with `image`
// still null, which is verbatim the failure the state exists to prevent,
// `hobby ls` claiming a resource can wake when it never can. `start` fell
// through to containerSpec's internal assertion (packages/app/src/app.ts:98-104,
// packages/worker/src/worker.ts:183-189) and wrote `failed`, an irreversible
// state change for what is actually the user's own mistake.
//
// `usage`, not `internal`: asking to sleep or wake a resource you just
// created is a reasonable mistake, not a daemon bug. The message matches the
// identical refusal in resolve (packages/cli/src/daemon/context.ts:322-329),
// so the proxy and the CLI say the same thing about how to fix this.
function refuseUndeployed(ctx: DaemonContext, resource: Resource): void {
  if (resource.state !== 'undeployed') {
    return
  }
  const project = ctx.store.getProject(resource.projectId)
  if (project === null) {
    throw new HobbyError(
      'internal',
      `resource ${resource.id} has no owning project (project ${resource.projectId} is gone)`
    )
  }
  const command = `hobby deploy <path> --project ${project.name} --name ${resource.name}`
  throw new HobbyError(
    'usage',
    `${resource.name} has no code deployed yet, run \`${command}\` from the directory holding its code`,
    `run \`${command}\` from the directory holding its code`
  )
}

async function startResourceRoute(ctx: DaemonContext, id: string): Promise<RouteResult> {
  const resource = getResourceOrThrow(ctx, id)
  refuseUndeployed(ctx, resource)
  await ctx.kinds.get(resource.kind).start(ctx, resource)
  return { status: 200, body: { resource: await toWireResource(ctx, getResourceOrThrow(ctx, id)) } }
}

async function stopResourceRoute(ctx: DaemonContext, id: string): Promise<RouteResult> {
  const resource = getResourceOrThrow(ctx, id)
  refuseUndeployed(ctx, resource)
  await ctx.kinds.get(resource.kind).stop(ctx, resource)
  return { status: 200, body: { resource: await toWireResource(ctx, getResourceOrThrow(ctx, id)) } }
}

// Always rendered as though the client will reach it through the proxy
// (viaProxy: true), even though nothing in this task starts that proxy: the
// proxy's port is the one users are meant to keep using, wired or not, see
// packages/proxy/src/proxy.ts's ProxyDeps.database contract. Host is
// 127.0.0.1 because M1 only runs on one box the caller is already on;
// HobbyConfig has no field yet for an externally reachable host, and adding
// one is out of scope here.
async function connectionRoute(ctx: DaemonContext, id: string): Promise<RouteResult> {
  // Genuinely postgres-only, unlike the lifecycle routes above: there is no
  // such thing as a connection string for an app or a worker, and an app's
  // reachable address is its hostname, served over HTTP. Answered with
  // `usage` rather than `internal` because asking for one is a reasonable
  // mistake for a caller to make, not a bug in the daemon.
  const resource = expectPostgres(getResourceOrThrow(ctx, id), 'a connection string')
  const project = ctx.store.getProject(resource.projectId)
  if (project === null) {
    throw new HobbyError('internal', `resource ${id} has no owning project (project ${resource.projectId} is gone)`)
  }
  const value = connectionString(project, resource, {
    host: '127.0.0.1',
    proxyPort: ctx.config.proxyPort,
    viaProxy: true,
  })
  // The tailnet variant is the same proxy on the same port, reached over
  // the box's MagicDNS name: the 0.0.0.0 bind already answers there, this
  // route only reports the address (docs/proxy/research/
  // 2026-08-13-postgres-over-tailnet.md). Null when no detector is wired
  // (tests, and any future caller of createApp that opts out) or when the
  // box has no running tailscaled.
  const tailnetHost = ctx.detectTailnet === undefined ? null : await ctx.detectTailnet()
  const tailnetValue =
    tailnetHost === null
      ? null
      : connectionString(project, resource, {
          host: tailnetHost,
          proxyPort: ctx.config.proxyPort,
          viaProxy: true,
        })
  return { status: 200, body: { connectionString: value, tailnetConnectionString: tailnetValue } }
}

async function logsRoute(ctx: DaemonContext, id: string, url: URL): Promise<RouteResult> {
  const resource = getResourceOrThrow(ctx, id)
  // Same refusal as the lifecycle routes: an undeployed resource has no
  // container, so runtime.logs would otherwise surface a raw runtime error
  // ("no such container") instead of telling the caller what to actually do.
  refuseUndeployed(ctx, resource)
  const tailParam = url.searchParams.get('tail')
  const parsedTail = tailParam === null ? Number.NaN : Number(tailParam)
  const tail = Number.isFinite(parsedTail) && parsedTail > 0 ? Math.floor(parsedTail) : DEFAULT_LOG_TAIL
  const logs = await ctx.runtime.logs(resource.config.containerName, { tail })
  return { status: 200, body: { logs } }
}

// True once a first deploy has produced an image (ResourceConfigBase.image's
// comment, packages/core/src/types.ts:63: "null until a first deploy has
// produced one"). Keyed on the config field a deploy actually writes, not on
// `state`, deliberately: `undeployed` means no code has ever landed here,
// `failed` means code landed and a later deploy broke it, and a `failed`
// resource still carries whatever image last worked (deployApp's own
// wasUndeployed guard, packages/app/src/app.ts:453, only resets state back to
// `undeployed` when there was never an image to roll back to). Checking
// `state` here instead would also mis-skip one real edge case: a first
// deploy that builds an image and then fails before it proves it listens
// rolls `state` back to `undeployed` (packages/app/src/app.ts:508) while
// `config.image` is already the freshly built tag. Matches the guard
// deployApp and deployWorker already use for the identical question
// (packages/app/src/app.ts:433, packages/worker/src/worker.ts:555).
function isDeployed(resource: AppResource | WorkerResource): boolean {
  return resource.config.image !== null
}

// A plain, literal rendering of what containerSpec (packages/pg/src/postgres.ts)
// actually asked Docker to create, not an aspiration: image, container name,
// the real generated credentials, the real host port and the real data
// directory. This is deliberately the whole implementation for this task:
// no side effects, nothing stopped, nothing deleted, no files written to
// disk. Real `hobby eject` (moving the daemon out of the way entirely) is
// portability/'s job and is not built here, see the task report.
//
// An app or worker with no image is skipped rather than rendered, and named
// in the returned `skipped` list: a compose service with no image cannot
// start, and `image: ${cfg.image}` below is a template literal, which
// stringifies `null` with no compile error, which is why nothing caught it
// before. Postgres needs no such guard: PostgresConfig.image is narrowed to
// `string` (packages/core/src/types.ts:80), and comparing a non-nullable
// string to `null` does not compile (TS2367), so the type system itself
// proves the postgres loop below can never emit `image: null`.
function renderCompose(
  ctx: DaemonContext,
  projectName: string,
  resources: PostgresResource[],
  apps: AppResource[] = [],
  workers: WorkerResource[] = []
): { compose: string; skipped: string[] } {
  // Every postgres resource in this project, by id, so an app's
  // databaseResourceId can be rewritten to the compose service name below.
  const byId = new Map(resources.map((resource) => [resource.id, resource]))
  const lines: string[] = ['services:']
  const skipped: string[] = []
  for (const resource of resources) {
    const cfg = resource.config
    lines.push(`  ${resource.name}:`)
    lines.push(`    image: ${cfg.image}`)
    // Deliberately no container_name. Pinning it to the name Hobbyist uses
    // means the emitted file cannot start while Hobbyist still manages this
    // project, which is exactly the state eject leaves you in today. Verified
    // against real Docker: compose refuses with a name conflict, and the whole
    // point of eject is that the result stands on its own. Letting compose
    // derive the name costs nothing and makes the file genuinely independent.
    lines.push('    restart: unless-stopped')
    lines.push('    environment:')
    lines.push(`      POSTGRES_USER: ${cfg.superuser}`)
    // The second, deliberate place the real password crosses the wire (see
    // wire.ts's own file comment): a docker-compose.yml with no working
    // password in it cannot start Postgres, which would make `hobby eject`
    // (CLAUDE.md's "you can always leave" promise, priority one of three)
    // hand back a file that lies about being able to stand alone. This is
    // not the resource-payload leak Item 1 closes, it is eject's entire
    // reason to exist.
    lines.push(`      POSTGRES_PASSWORD: ${cfg.password}`)
    lines.push(`      POSTGRES_DB: ${cfg.database}`)
    lines.push('    ports:')
    // With the same explicit loopback bind the daemon itself publishes this
    // container with (packages/core/src/docker.ts's buildCreateArgs, and
    // DEFAULT_PORT_BIND for why). This function's whole contract is that it
    // is a literal rendering of what Hobbyist actually asked Docker to
    // create, so a bare "25555:5432" here would hand the departing user a
    // compose file that publishes their database on every interface when
    // Hobbyist never did, at exactly the moment they stop having Hobbyist
    // to notice it for them.
    lines.push(`      - "${DEFAULT_PORT_BIND}:${cfg.hostPort}:5432"`)
    lines.push('    volumes:')
    // The postgres home directory, not PGDATA itself: postgres 18's image
    // refuses to start when the bind mount lands directly at
    // /var/lib/postgresql/data (see docs/decisions/0003's 2026-08-07
    // amendment). A compose file mounted at the old path would hand a
    // departing user a stack that exits 1 on `docker compose up`, which
    // would break eject's whole reason to exist.
    lines.push(`      - "${cfg.dataDir}:/var/lib/postgresql"`)
  }

  for (const app of apps) {
    const cfg = app.config
    // No image, no service: see isDeployed's comment above for why this
    // checks `config.image` rather than `state`. Reported rather than
    // dropped, reusing the skip-reporting mechanism abe7582 added for a kind
    // that cannot be ejected at all: silence here would read as "hobby
    // exported everything" at exactly the moment the user has stopped being
    // able to ask.
    if (!isDeployed(app)) {
      skipped.push(`${app.name}: never deployed, so there is no image to run`)
      continue
    }
    lines.push(`  ${app.name}:`)
    lines.push(`    image: ${cfg.image}`)
    // Emitted alongside `image:` rather than instead of it when we built it
    // from source. compose accepts both and treats the image as the tag for
    // what it builds, so the file starts immediately from the image already
    // on disk AND can be rebuilt from the same Dockerfile later. An ejected
    // stack that can only ever run one frozen image is not the "you can
    // always leave" promise, it is a snapshot.
    if (cfg.source !== null) {
      lines.push('    build:')
      lines.push(`      context: ${cfg.source.path}`)
      lines.push(`      dockerfile: ${cfg.source.dockerfile}`)
    }
    lines.push('    restart: unless-stopped')
    lines.push('    environment:')
    lines.push(`      PORT: "${cfg.containerPort}"`)
    const database = cfg.databaseResourceId === null ? undefined : byId.get(cfg.databaseResourceId)
    if (database !== undefined) {
      // Rewritten to the COMPOSE service name, not the hobby container name.
      // Inside the emitted stack the database answers to `primary`, not to
      // `hobby-blog-primary`, so carrying the hobby name through would hand
      // the user an app that starts and then cannot reach its database, which
      // is a worse failure than not emitting it at all because it looks like
      // it worked.
      const db = database.config
      const user = encodeURIComponent(db.superuser)
      const password = encodeURIComponent(db.password)
      lines.push(`      DATABASE_URL: postgres://${user}:${password}@${database.name}:5432/${db.database}`)
    }
    for (const [key, value] of Object.entries(cfg.env)) {
      lines.push(`      ${key}: ${JSON.stringify(value)}`)
    }
    lines.push('    ports:')
    lines.push(`      - "${DEFAULT_PORT_BIND}:${cfg.hostPort}:${cfg.containerPort}"`)
  }

  for (const worker of workers) {
    const cfg = worker.config
    // Same guard as the app loop above, and load-bearing here in a second,
    // sharper way: buildRunnerManifest (packages/worker/src/worker.ts:135)
    // THROWS when config.manifest is null, and deployWorker always writes
    // image and manifest together in the same updateResourceConfig call,
    // never one without the other (packages/worker/src/worker.ts:590-610;
    // createWorkerResource's no-source path sets both null together too,
    // packages/worker/src/worker.ts:322-334), so `!isDeployed(worker)` here
    // guarantees `cfg.manifest !== null` at the call below. Without this
    // guard, one undeployed worker throws out of renderCompose entirely,
    // aborting eject for every healthy postgres in the same project, which
    // is exactly the failure eject exists to prevent.
    if (!isDeployed(worker)) {
      skipped.push(`${worker.name}: never deployed, so there is no image to run`)
      continue
    }
    lines.push(`  ${worker.name}:`)
    lines.push(`    image: ${cfg.image}`)
    // No `build:` counterpart to the app kind's, deliberately. A worker's
    // Dockerfile is generated by hobby and lives under hobby's own home
    // directory, so pointing an ejected stack at it would make the file
    // depend on hobby still being installed, which is the opposite of what
    // ejecting means. The image is self-contained; rebuilding it is
    // `wrangler`'s job once you have left.
    lines.push('    restart: unless-stopped')
    lines.push('    environment:')
    const manifest = buildRunnerManifest(ctx, worker)
    const database = cfg.databaseResourceId === null ? undefined : byId.get(cfg.databaseResourceId)
    if (database !== undefined && manifest.hyperdrives !== undefined) {
      // Same rewrite as the app kind's DATABASE_URL, for the same reason:
      // inside the emitted stack the database answers to its compose service
      // name, not to `hobby-blog-primary`.
      const db = database.config
      const user = encodeURIComponent(db.superuser)
      const password = encodeURIComponent(db.password)
      manifest.hyperdrives = {
        ...manifest.hyperdrives,
        DB: `postgres://${user}:${password}@${database.name}:5432/${db.database}`,
      }
    }
    lines.push(`      HOBBY_WORKER_MANIFEST: ${JSON.stringify(JSON.stringify(manifest))}`)
    lines.push('    ports:')
    lines.push(`      - "${DEFAULT_PORT_BIND}:${cfg.hostPort}:${cfg.containerPort}"`)
    lines.push('    volumes:')
    // Both mounts, because a worker that comes up with an empty durable
    // object directory has lost its data as surely as a postgres pointed at
    // an empty PGDATA.
    lines.push(`      - "${ctx.paths.resourcePath(projectName, worker.name, 'state')}:/hobby/state"`)
    lines.push(`      - "${ctx.paths.resourcePath(projectName, worker.name, 'do')}:/hobby/do"`)
  }

  return { compose: `${lines.join('\n')}\n`, skipped }
}

// The Caddy half of eject. ADR 0009 is explicit that emitting the compose
// file alone leaks the promise: "an ejected app that no longer serves is not
// an ejected app." A Caddyfile is emitted rather than the JSON we push to the
// admin API, because the departing user is going to hand-edit this, and
// nobody hand-edits Caddy JSON.
//
// Deliberately points at the published host ports rather than at container
// names: this Caddy is not necessarily inside the compose network, and the
// ports are published on loopback either way.
function renderCaddyfile(routed: Array<{ hostname: string; hostPort: number }>): string {
  if (routed.length === 0) {
    return ''
  }
  const lines: string[] = []
  for (const entry of routed) {
    lines.push(`${entry.hostname} {`)
    lines.push(`\treverse_proxy ${DEFAULT_PORT_BIND}:${entry.hostPort}`)
    lines.push('}')
    lines.push('')
  }
  return lines.join('\n')
}

function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value)
}

// Studio's Tables, Sql and Schema views (packages/studio/src/api.ts's
// runQuery) all rest on this one route. Waking happens through
// getOrCreateWake(ctx), the exact same idempotent, single-flight function
// the wake-on-connect proxy itself uses (see context.ts's own comment):
// a sleeping resource is woken and this call waits for real readiness
// (startPostgres never resolves early, see packages/pg/src/postgres.ts)
// before the query is ever attempted, which is what makes Studio's waking
// banner honest rather than theatrical. A resource already `running` skips
// the wake entirely, the same guard the proxy's own handleStartup uses.
//
// params is always passed straight through to runQuery, which hands it to
// the driver's own parameterized query path; this function never touches
// the SQL string itself.
async function queryRoute(ctx: DaemonContext, req: IncomingMessage, id: string): Promise<RouteResult> {
  const resource = expectPostgres(getResourceOrThrow(ctx, id), 'running SQL')
  const body = await readJsonBody(req)
  const sql = isRecord(body) ? body['sql'] : undefined
  const rawParams = isRecord(body) ? body['params'] : undefined

  if (typeof sql !== 'string' || sql.length === 0) {
    throw new HobbyError(
      'usage',
      'sql is required',
      'POST /v1/resources/:id/query expects { "sql": string, "params"?: unknown[] }'
    )
  }
  if (rawParams !== undefined && !isUnknownArray(rawParams)) {
    throw new HobbyError(
      'usage',
      'params must be an array',
      'POST /v1/resources/:id/query expects { "sql": string, "params"?: unknown[] }'
    )
  }
  const params = rawParams ?? []

  if (resource.state !== 'running') {
    await getOrCreateWake(ctx)(resource.id)
  }

  // The resource may have been replaced or re-configured by the wake above
  // (it was not, in practice, startPostgres never touches config, but
  // re-reading is what the proxy's own handleStartup does after a wake and
  // matching that is cheap insurance against relying on a config snapshot
  // that raced a concurrent change).
  const ready = expectPostgres(getResourceOrThrow(ctx, id), 'running SQL')
  // A query is activity, exactly as much as a proxy connection is, and the
  // hibernator has to hear about it from here because nothing else will:
  // Studio's Tables, Sql and Schema views never open a proxy connection.
  // Marked before the query runs so a hibernator tick that starts while a
  // long query is in flight already sees the resource as active, and again
  // in the finally so the idle threshold is measured from when the query
  // finished rather than from when it started. The finally also covers a
  // failed query: a statement that errored is still someone using this
  // database right now.
  ctx.activity.touch(ready.id)
  try {
    const result = await runQuery(ready.config, sql, params)
    return { status: 200, body: result }
  } finally {
    ctx.activity.touch(ready.id)
  }
}

// Two calls in one route, and what `release` does NOT do is the design.
//
// Without `release` this is a pure read: a compose file rendered from real
// state, nothing written, nothing stopped, the project still managed. That
// stays the default, because the common use is looking at the file.
//
// With `release`, hobby stops acting on the project and keeps every record of
// it. Containers are stopped, the rows stay, the config stays, the credentials
// stay, the data directory is untouched, the network stays. The project is
// marked released and from then on hobby will not wake it, hibernate it, or
// reconcile it, because whatever the user started from that compose file now
// owns the data directory and two Postgres processes on one PGDATA is
// corruption. `hobby adopt` clears the mark and takes it back.
//
// An earlier version deleted the project instead. That was wrong for a reason
// worth writing down: --release is a flag someone types once, out of
// curiosity, on a project they care about, and if their export turns out to be
// botched there was no way back. Handing something over and destroying the
// only record of it are different operations, and only one of them is what
// this verb means. Deleting is what `hobby rm` is for, and it asks first.
//
// The compose file is still rendered before anything else runs, because it is
// rendered from the store rows, credentials included, and it is the artifact
// the whole call exists to produce.
async function ejectRoute(ctx: DaemonContext, name: string, release: boolean): Promise<RouteResult> {
  const project = getProjectByNameOrThrow(ctx, name)
  const resources = ctx.store.listResources(project.id)
  // All three kinds are rendered: the call to renderCompose below, at :778,
  // emits a service for postgres, app and worker alike. ADR 0007 is explicit that a
  // kind which cannot be ejected does not ship, and EJECTABLE just below is
  // what keeps that true. What is filtered is not the kind but whether a
  // compute resource has ever been deployed: an app or worker with no image
  // is skipped and reported rather than rendered, see isDeployed's comment
  // above renderCompose and the skip-reporting note a few lines down.
  const postgresResources = resources.filter((r) => r.kind === 'postgres')
  const appResources = resources.filter((r) => r.kind === 'app')
  const workerResources = resources.filter((r) => r.kind === 'worker')
  // Every kind registered today can be ejected, which is what ADR 0007
  // requires before a kind ships. Kept as a computed list rather than deleted
  // so the next kind cannot quietly ship without one.
  const EJECTABLE: ReadonlySet<string> = new Set(['postgres', 'app', 'worker'])
  const notEjectable = resources
    .filter((r) => !EJECTABLE.has(r.kind))
    .map((r) => `${r.name} (${r.kind})`)
  // renderCompose skips (and reports) any app or worker with no image: an
  // undeployed resource has never produced one, so there is no code to run
  // (isDeployed's comment above renderCompose). Its skip messages join
  // `notEjectable` below rather than a second field, reusing the one
  // skip-reporting mechanism abe7582 added instead of inventing another. When
  // every resource lands in that list, the refusal a few lines down fires
  // instead of returning a `services:` header with nothing under it: see that
  // check for why an empty compose file is not an acceptable 200.
  const rendered = renderCompose(ctx, project.name, postgresResources, appResources, workerResources)
  // The same isDeployed predicate renderCompose used, applied here so Caddy
  // never routes a hostname to a service renderCompose just skipped. ADR 0009
  // is explicit that "an ejected app that no longer serves is not an ejected
  // app," and a compose stack with no service behind a hostname is exactly
  // that, even though `hostname` and `hostPort` are both allocated at
  // creation (createAppResource, packages/app/src/app.ts; createWorkerResource,
  // packages/worker/src/worker.ts) and so are never null themselves, unlike
  // `image`.
  const deployedApps = appResources.filter(isDeployed)
  const deployedWorkers = workerResources.filter(isDeployed)
  const skippedReasons = [...notEjectable, ...rendered.skipped]

  // Nothing renderable: refuse rather than hand back a file that cannot
  // start. `services:` with nothing under it is not valid compose (verified
  // against real docker compose: `docker compose -f <file> config` on a bare
  // `services:` key fails with "services must be a mapping"), so returning
  // 200 here would hand the departing user a file docker cannot even parse,
  // at exactly the moment they are trying to leave, which fails CLAUDE.md's
  // "you can always leave" worse than saying plainly there is nothing here
  // yet. Two distinct shapes land here now that a project is not guaranteed
  // a postgres the instant it exists: every resource present was skipped
  // (Task 4 let a project hold only undeployed compute, and a later task
  // adds `hobby new --empty`), or the project holds no resources at all. The
  // message distinguishes the two, reusing skippedReasons so it never says
  // less than what renderCompose already knows: this is either "come back
  // once something has deployed" or "there is genuinely nothing here yet,"
  // never "hobby lost your data."
  if (postgresResources.length + deployedApps.length + deployedWorkers.length === 0) {
    throw new HobbyError(
      'usage',
      skippedReasons.length > 0
        ? `${name} has nothing to eject yet: ${skippedReasons.join('; ')}`
        : `${name} has no resources yet, so there is nothing to eject`,
      skippedReasons.length > 0
        ? 'deploy at least one app or worker, or wait for a resource to finish creating, then eject again'
        : 'create a resource first (hobby pg create, or deploy an app or worker), then eject again'
    )
  }

  const body = {
    compose: rendered.compose,
    // ADR 0009: without this, an ejected app comes up on a loopback port with
    // nothing routing a hostname to it, which is a running container rather
    // than a working site.
    caddyfile: renderCaddyfile([
      ...deployedApps.map((r) => ({ hostname: r.config.hostname, hostPort: r.config.hostPort })),
      ...deployedWorkers.map((r) => ({ hostname: r.config.hostname, hostPort: r.config.hostPort })),
    ]),
    dataDirs: postgresResources.map((resource) => resource.config.dataDir),
    released: release,
    notEjectable: skippedReasons,
  }

  if (!release) {
    return { status: 200, body }
  }

  // Stopped, not removed. A stopped container holds no port and no data
  // directory, so the compose file can start cleanly beside it, and leaving it
  // in place is what makes `hobby adopt` a state change rather than a rebuild.
  const failures: string[] = []
  for (const resource of resources) {
    if (resource.state !== 'running') continue
    try {
      await ctx.kinds.get(resource.kind).stop(ctx, resource)
    } catch (err) {
      failures.push(`${resource.name}: ${errorMessage(err)}`)
    }
  }

  ctx.store.setProjectReleased(project.id, new Date())

  if (failures.length > 0) {
    throw new HobbyError(
      'internal',
      `project ${name} is released, but ${failures.length} of its databases did not stop cleanly: ${failures.join('; ')}`,
      'nothing was deleted. Stop the container by hand before starting the compose file, so two postgres processes cannot open the same data directory'
    )
  }

  return { status: 200, body }
}

// The other direction. Nothing to rebuild and nothing to restore: the rows
// never went anywhere, so taking a project back is one column changing.
function adoptRoute(ctx: DaemonContext, name: string): RouteResult {
  const project = getProjectByNameOrThrow(ctx, name)
  if (project.releasedAt == null) {
    throw new HobbyError(
      'conflict',
      `project ${name} was not released`,
      'hobby is already managing it'
    )
  }
  ctx.store.setProjectReleased(project.id, null)
  return { status: 200, body: { project: ctx.store.getProject(project.id) } }
}

// ---------------------------------------------------------------------------
// Queue routes. This file is the only one that ever opens a queue's sqlite
// database (root CLAUDE.md: the daemon API is the only control surface, and
// keeping every open() call in one file is what stops the CLI and MCP from
// ever diverging on what a queue looks like). Every handler below reads or
// writes through @hobby.sh/queue's broker functions and nothing else.
// ---------------------------------------------------------------------------

const DEFAULT_PEEK_LIMIT = 10

// A queue whose sqlite file does not exist yet reads as empty rather than
// throwing. In normal operation createResourceRoute's queue branch above
// always creates the file at row-creation time, so this only matters for a
// row that reached the store some other way (a test fixture, or a future
// path that skips that step); a listing or a peek must never 500 because one
// queue's file is not there.
function withQueueDbReadOnly<T>(path: string, fallback: T, fn: (db: SqliteDatabase) => T): T {
  if (!existsSync(path)) {
    return fallback
  }
  const db = openDatabaseReadOnly(path)
  try {
    return fn(db)
  } finally {
    db.close()
  }
}

interface QueueStats {
  depth: number
  oldestTimestampMs: number | null
}

function readQueueStats(path: string): QueueStats {
  return withQueueDbReadOnly<QueueStats>(path, { depth: 0, oldestTimestampMs: null }, (db) => {
    const n = queueDepth(db)
    if (n === 0) {
      return { depth: 0, oldestTimestampMs: null }
    }
    // peek() orders by id, which sorts by creation (packages/queue/src/ids.ts),
    // so the first row of an unfiltered peek(db, 1) is the oldest message
    // this queue currently holds, delayed or leased ones included. That is
    // deliberately a different question from "the oldest ready message":
    // this is a listing, not a delivery decision.
    const [oldest] = peek(db, 1)
    return { depth: n, oldestTimestampMs: oldest === undefined ? null : oldest.timestampMs }
  })
}

interface QueueListEntry {
  resource: WireResource
  depth: number
  oldestMessageAgeSeconds: number | null
  consumer: WireResource | null
}

// GET /v1/projects/:name/queues. Every queue in the project, each enriched
// with what its own sqlite file and its consumer resource know: depth and
// oldest-message age come from the queue's own database, `consumer` is the
// full WireResource of whatever resource.config.consumerResourceId points
// at (or null), so the caller can read its state and, for a worker, its
// manifest, exactly the same way `hobby ls` already does for any other
// resource. That is what lets an undeployed consumer be rendered
// consistently: this route does not decide the wording, it hands back the
// fact (`config.manifest === null`) and lets the CLI's existing "(no code
// yet)" phrasing (packages/cli/src/cli/output.ts) speak for both places at
// once.
async function listQueuesRoute(ctx: DaemonContext, projectName: string): Promise<RouteResult> {
  const project = getProjectByNameOrThrow(ctx, projectName)
  const resources = ctx.store.listResources(project.id).filter((r): r is QueueResource => r.kind === 'queue')
  const nowMs = Date.now()

  const entries: QueueListEntry[] = []
  for (const resource of resources) {
    const stats = readQueueStats(queueDbPath(ctx.paths, project.name, resource.name))
    const consumerResource =
      resource.config.consumerResourceId === null ? null : ctx.store.getResource(resource.config.consumerResourceId)
    entries.push({
      resource: await toWireResource(ctx, resource),
      depth: stats.depth,
      oldestMessageAgeSeconds:
        stats.oldestTimestampMs === null ? null : Math.max(0, Math.round((nowMs - stats.oldestTimestampMs) / 1000)),
      consumer: consumerResource === null ? null : await toWireResource(ctx, consumerResource),
    })
  }

  return { status: 200, body: { queues: entries } }
}

interface QueueMessageWire {
  id: string
  timestampMs: number
  attempts: number
  contentType: ContentType
  body: unknown
}

// Decodes a codec-encoded body back into the value the sender actually gave
// (every real sender, the runner shim in packages/worker/src/runtime-image.ts
// and this file's own enqueueRoute below, always writes contentType 'json'
// through encodeBody). Wrapped rather than left to throw: a body written by
// something else, or corrupted on disk, must not turn an otherwise-successful
// peek into a 500, it should just show up as the raw stored text.
function decodeMessageBody(message: LeasedMessage): unknown {
  if (message.contentType !== 'json') {
    return message.body
  }
  try {
    return decodeBody(message.body)
  } catch {
    return message.body
  }
}

function toWireMessage(message: LeasedMessage): QueueMessageWire {
  return {
    id: message.id,
    timestampMs: message.timestampMs,
    attempts: message.attempts,
    contentType: message.contentType,
    body: decodeMessageBody(message),
  }
}

// GET /v1/resources/:id/queue/messages?limit=. Non-destructive: peek() never
// touches lease_id, so a message read here is still exactly as deliverable
// afterward as it was before, unlike leaseBatch which is a real claim.
async function peekQueueRoute(ctx: DaemonContext, id: string, url: URL): Promise<RouteResult> {
  const resource = expectQueue(getResourceOrThrow(ctx, id), 'peeking messages')
  const project = getOwningProjectOrThrow(ctx, resource)

  const limitParam = url.searchParams.get('limit')
  const parsedLimit = limitParam === null ? Number.NaN : Number(limitParam)
  const limit = Number.isFinite(parsedLimit) && parsedLimit > 0 ? Math.floor(parsedLimit) : DEFAULT_PEEK_LIMIT

  const path = queueDbPath(ctx.paths, project.name, resource.name)
  const messages = withQueueDbReadOnly<LeasedMessage[]>(path, [], (db) => peek(db, limit))
  return { status: 200, body: { messages: messages.map(toWireMessage) } }
}

// POST /v1/resources/:id/queue/messages. Body: { "body": <any JSON value>,
// "delaySeconds"?: number }. `body` is the value itself, not a pre-encoded
// string: encodeBody runs here, once, so neither the CLI nor MCP ever needs
// to know this queue's wire format, the same reason peek's response above is
// already decoded rather than handing back an opaque codec string.
async function enqueueRoute(ctx: DaemonContext, req: IncomingMessage, id: string): Promise<RouteResult> {
  const resource = expectQueue(getResourceOrThrow(ctx, id), 'sending a message')
  const project = getOwningProjectOrThrow(ctx, resource)

  const parsed = await readJsonBody(req)
  const fields = isRecord(parsed) ? parsed : {}
  if (!('body' in fields)) {
    throw new HobbyError(
      'usage',
      'body is required',
      'POST /v1/resources/:id/queue/messages expects { "body": <json value>, "delaySeconds"?: number }'
    )
  }
  const rawDelay = fields['delaySeconds']
  const delaySeconds = typeof rawDelay === 'number' ? rawDelay : undefined

  const path = queueDbPath(ctx.paths, project.name, resource.name)
  const db = openQueueDb(path)
  try {
    // enqueue() itself throws HobbyError('usage', ...) for every one of
    // Cloudflare's own limits (message size, batch size, delaySeconds
    // range), which propagates straight through dispatch's catch: this
    // route adds no second copy of those checks.
    const ids = enqueue(db, [{ body: encodeBody(fields['body']), contentType: 'json', delaySeconds }], Date.now())
    return { status: 201, body: { id: ids[0] } }
  } finally {
    db.close()
  }
}

// DELETE /v1/resources/:id/queue/messages. Returns the count purged so the
// caller can report what was actually lost, per broker.ts's own purge()
// comment: a queue that cannot say how much it dropped is a queue that
// silently lied about it.
async function purgeQueueRoute(ctx: DaemonContext, id: string): Promise<RouteResult> {
  const resource = expectQueue(getResourceOrThrow(ctx, id), 'purging messages')
  const project = getOwningProjectOrThrow(ctx, resource)

  const path = queueDbPath(ctx.paths, project.name, resource.name)
  if (!existsSync(path)) {
    return { status: 200, body: { purged: 0 } }
  }
  const db = openQueueDb(path)
  try {
    const count = purge(db)
    return { status: 200, body: { purged: count } }
  } finally {
    db.close()
  }
}

// POST /v1/resources/:id/queue/retention. Body: { "retentionSeconds": number }.
// Validated against Cloudflare's own bounds (MIN/MAX_RETENTION_SECONDS,
// packages/queue/src/broker.ts) and rejected outright outside them, never
// clamped: a silently clamped value is a value the caller thinks they set
// and did not, which is worse than an error naming the real bounds.
async function setRetentionRoute(ctx: DaemonContext, req: IncomingMessage, id: string): Promise<RouteResult> {
  const resource = expectQueue(getResourceOrThrow(ctx, id), 'setting retention')

  const body = await readJsonBody(req)
  const fields = isRecord(body) ? body : {}
  const raw = fields['retentionSeconds']
  if (typeof raw !== 'number' || !Number.isInteger(raw)) {
    throw new HobbyError(
      'usage',
      'retentionSeconds is required and must be a whole number of seconds',
      'POST /v1/resources/:id/queue/retention expects { "retentionSeconds": number }'
    )
  }
  if (raw < MIN_RETENTION_SECONDS || raw > MAX_RETENTION_SECONDS) {
    throw new HobbyError(
      'usage',
      `retentionSeconds must be between ${MIN_RETENTION_SECONDS} and ${MAX_RETENTION_SECONDS} (Cloudflare's own bounds: 60 seconds to 14 days), got ${raw}`,
      `pick a value from ${MIN_RETENTION_SECONDS} to ${MAX_RETENTION_SECONDS}`
    )
  }

  const config: QueueConfig = { ...resource.config, retentionSeconds: raw }
  ctx.store.updateResourceConfig(resource.id, config)
  return { status: 200, body: { resource: await toWireResource(ctx, getResourceOrThrow(ctx, id)) } }
}

async function dispatch(ctx: DaemonContext, req: IncomingMessage): Promise<RouteResult> {
  const method = req.method ?? 'GET'
  const url = new URL(req.url ?? '/', 'http://localhost')
  const segments = url.pathname.split('/').filter((segment) => segment.length > 0)

  if (segments[0] !== 'v1') {
    throw new HobbyError('usage', `unknown route: ${method} ${url.pathname}`)
  }

  if (method === 'GET' && segments.length === 2 && segments[1] === 'health') {
    return { status: 200, body: { status: 'ok' } }
  }

  if (method === 'GET' && segments.length === 2 && segments[1] === 'preflight') {
    return { status: 200, body: await runPreflight(ctx) }
  }

  if (segments[1] === 'projects') {
    if (segments.length === 2) {
      if (method === 'GET') return { status: 200, body: { projects: ctx.store.listProjects() } }
      if (method === 'POST') return { status: 201, body: { project: await createProjectRoute(ctx, req) } }
    }

    if (segments.length === 3) {
      const name = decodeURIComponent(segments[2] as string)
      if (method === 'GET') return await getProjectRoute(ctx, name)
      if (method === 'DELETE') return deleteProjectRoute(ctx, name)
    }

    if (segments.length === 4 && method === 'POST' && segments[3] === 'resources') {
      const name = decodeURIComponent(segments[2] as string)
      const resource = await createResourceRoute(ctx, req, name)
      return { status: 201, body: { resource: await toWireResource(ctx, resource) } }
    }

    if (segments.length === 4 && method === 'POST' && segments[3] === 'eject') {
      const name = decodeURIComponent(segments[2] as string)
      // Opt-in by an explicit query parameter: the destructive reading of a
      // verb is never the one a bare request gets.
      return await ejectRoute(ctx, name, url.searchParams.get('release') === 'true')
    }

    if (segments.length === 4 && method === 'POST' && segments[3] === 'adopt') {
      const name = decodeURIComponent(segments[2] as string)
      return adoptRoute(ctx, name)
    }

    if (segments.length === 4 && method === 'GET' && segments[3] === 'queues') {
      const name = decodeURIComponent(segments[2] as string)
      return await listQueuesRoute(ctx, name)
    }
  }

  if (segments[1] === 'resources') {
    if (segments.length === 3) {
      const id = decodeURIComponent(segments[2] as string)
      if (method === 'GET') {
        return { status: 200, body: { resource: await toWireResource(ctx, getResourceOrThrow(ctx, id)) } }
      }
      if (method === 'DELETE') return destroyResourceRoute(ctx, id)
    }

    if (segments.length === 4) {
      const id = decodeURIComponent(segments[2] as string)
      const action = segments[3]
      if (method === 'POST' && action === 'start') return startResourceRoute(ctx, id)
      if (method === 'POST' && action === 'stop') return stopResourceRoute(ctx, id)
      if (method === 'GET' && action === 'connection') return connectionRoute(ctx, id)
      if (method === 'GET' && action === 'logs') return logsRoute(ctx, id, url)
      if (method === 'POST' && action === 'query') return queryRoute(ctx, req, id)
      if (method === 'POST' && action === 'deploy') return deployResourceRoute(ctx, req, id)
    }

    // /v1/resources/:id/queue/messages and /v1/resources/:id/queue/retention.
    // A resource id, not a project+name pair, addresses a queue the same way
    // it already addresses every other resource-scoped route above; the CLI
    // and MCP resolve a `project`/`project/name` target to an id first (see
    // resolveQueueTarget, packages/cli/src/cli/commands.ts), exactly as they
    // already do for sleep/wake/logs.
    if (segments.length === 5 && segments[3] === 'queue') {
      const id = decodeURIComponent(segments[2] as string)
      const action = segments[4]
      if (method === 'GET' && action === 'messages') return peekQueueRoute(ctx, id, url)
      if (method === 'POST' && action === 'messages') return enqueueRoute(ctx, req, id)
      if (method === 'DELETE' && action === 'messages') return purgeQueueRoute(ctx, id)
      if (method === 'POST' && action === 'retention') return setRetentionRoute(ctx, req, id)
    }
  }

  throw new HobbyError('usage', `unknown route: ${method} ${url.pathname}`, 'see docs/cli/specs for the route list')
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(payload)
}

// The single place an unknown throw is turned into `internal` and logged
// with its stack. Every route above either returns a value or throws a
// HobbyError; anything else reaching here is, by definition, a bug, not an
// expected failure the caller can act on, so its detail is logged for
// whoever runs the daemon and never repeated back to the client.
function toHobbyError(err: unknown): HobbyError {
  if (err instanceof HobbyError) {
    return err
  }
  const detail = err instanceof Error ? (err.stack ?? err.message) : String(err)
  console.error(`daemon: unexpected error: ${detail}`)
  return new HobbyError('internal', 'internal error')
}

export async function handleRequest(ctx: DaemonContext, req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const result = await dispatch(ctx, req)
    sendJson(res, result.status, result.body)
  } catch (err) {
    const hobbyErr = toHobbyError(err)
    sendJson(res, hobbyErr.httpStatus, hobbyErr.toWire())
  }
}
