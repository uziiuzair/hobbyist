// The `worker` resource kind: a Cloudflare Worker, on Cloudflare's own
// runtime, on your box. See ADR 0011 for why this is workerd via Miniflare
// rather than a container running node, and for the fallback if the cold
// start turns out unacceptable.
//
// One workerd process per worker resource, which is the author's explicit
// choice over sharing one across a project. The consequence, stated plainly
// rather than buried: a worker's cold start is a CONTAINER start, not an
// isolate start. The sub-5ms isolate figure that makes Workers famous applies
// only once this container is already up.

import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  HobbyError,
  validateName,
  type ActivitySink,
  type ComputeRuntime,
  type ContainerSpec,
  type HobbyConfig,
  type Paths,
  type PostgresConfig,
  type Project,
  type Resource,
  type ResourceId,
  type Store,
  type WorkerConfig,
  type WorkerResource,
} from '@hobby.sh/core'
import { assertWorkerConfig } from './assert-config.js'
import { findWranglerManifest, type WranglerManifest } from './manifest.js'
import {
  buildWorkerImage,
  CONTAINER_CONTROL_PORT,
  CONTAINER_DO,
  CONTAINER_STATE,
  renderWorkerDockerfile,
} from './runtime-image.js'

export interface WorkerDeps {
  store: Store
  runtime: ComputeRuntime
  paths: Paths
  config: HobbyConfig
  activity?: ActivitySink
  // Namespaced for the same reason the app kind's is: one DaemonContext is
  // passed structurally to every kind, so two kinds cannot both claim
  // `probeFactory` for differently typed seams.
  workerProbeFactory?: (config: WorkerConfig) => () => Promise<boolean>
  now?: () => number
}

// Clear of both the postgres range (15432 to 25432) and the app range (25433
// to 35432), so a port tells you which kind owns it.
const PORT_RANGE_FROM = 35433
const PORT_RANGE_TO = 45432

// The port Miniflare listens on inside the container. Fixed rather than
// allocated: nothing else is in this container, and a constant is one fewer
// thing to keep in sync between the manifest and the port mapping.
const CONTAINER_PORT = 8787

const STOP_TIMEOUT_SEC = 10

// Same caps as an app build, and for the same reason. A worker build is
// heavier than most (it installs miniflare, which pulls the workerd binary),
// which makes it more important that it loses to anything else on the box,
// not less.
const BUILD_MEMORY = '2g'
const BUILD_CPU_SHARES = 512

function workerHostname(project: string, resource: string, domain: string): string {
  return `${resource}.${project}.${domain}`.toLowerCase()
}

// The one field workerd derives Durable Object storage identity from.
//
// Derived from the resource id, which is the randomUUID the store assigns at
// createResource and which survives rename, redeploy, daemon restart and
// eject/adopt. Never regenerated, and never derived from the project or class
// name, because both are user-facing strings a rename would change and a
// changed key orphans every object's sqlite file silently.
//
// Verified against a running Miniflare on 2026-08-10: the value becomes the
// storage directory name, `<uniqueKey>/<objectId>.sqlite` beneath the durable
// object persist root.
export function uniqueKeyFor(resourceId: ResourceId, className: string): string {
  return `${resourceId}-${className}`
}

// What the container's runner reads out of one environment variable. Built
// fresh on every container create, so a rotated database password or a new
// binding is picked up rather than frozen into an image.
export interface RunnerManifest {
  port: number
  // The host-side port the daemon posts queue batches to, carried through
  // for logging/observability inside the runner: the container's own control
  // server listens on CONTAINER_CONTROL_PORT, a fixed constant, not on this
  // value, exactly as the main port is fixed and hostPort is a Docker-side
  // remap of it.
  controlPort: number
  compatibilityDate: string
  compatibilityFlags: string[]
  vars: Record<string, string>
  kvNamespaces: string[]
  r2Buckets: string[]
  d1Databases: string[]
  // ALWAYS []. See the comment where these are handed to Miniflare in
  // runtime-image.ts's RUNNER_SOURCE for why: its in-memory queue broker
  // must never be constructed. Kept as fields (rather than deleted) so a
  // caller reading the manifest can see the intent stated rather than
  // inferred from absence.
  queueProducers: string[]
  queueConsumers: string[]
  // Where the container's producer shim posts enqueue requests, and the
  // bearer token it sends. Both null when the worker declares no producer
  // bindings, since there is then nothing for the shim to reach.
  queueEndpoint: string | null
  queueToken: string | null
  // Every producer binding this worker declares, so the runner can give each
  // one its own wrappedBindings entry pointing at the shim worker.
  queueBindings: Array<{ binding: string; queue: string }>
  durableObjects: Record<string, { className: string; useSQLite: true; unsafeUniqueKey: string }>
  hyperdrives?: Record<string, string>
}

function hyperdriveUrl(config: PostgresConfig): string {
  const user = encodeURIComponent(config.superuser)
  const password = encodeURIComponent(config.password)
  // The container name on the project's docker network, not a published
  // loopback port, for the same reason the app kind does it: the worker then
  // does not depend on the database's host port and keeps working if it is
  // reallocated.
  return `postgres://${user}:${password}@${config.containerName}:5432/${config.database}`
}

export function buildRunnerManifest(deps: WorkerDeps, resource: WorkerResource): RunnerManifest {
  // The place both callers that flow through containerSpec (the start path)
  // and routes.ts's renderCompose (the eject path) dereference
  // `config.manifest`. Two other production reads still bypass this guard:
  // packages/cli/src/daemon/wire.ts's redactConfig, which the parallel
  // queue branch is expected to close by replacing it with an explicit
  // four-way branch, and this file's own deployWorker redeploy fallback. A
  // worker row that predates the manifest split parses out of the store
  // with `manifest` absent rather than null (packages/core/src/store.ts:122's
  // unchecked cast), which the explicit null check just below would not
  // catch on its own, since `undefined !== null`, and the failure would
  // instead surface three lines down as an unhelpful TypeError on
  // `config.manifest.durableObjects`.
  const config = assertWorkerConfig(resource.config)
  // Every caller that can reach this function has already gone through a
  // path that requires an image (containerSpec's own null-image check for
  // start, or a stored row for eject's renderCompose), and image and
  // manifest are populated together at first deploy. A null manifest here
  // is therefore a bug, not a resting state, exactly like containerSpec's
  // null-image check just above.
  if (config.manifest === null) {
    throw new HobbyError(
      'internal',
      `resource ${config.containerName} has no manifest, so there is nothing to run`,
      'this is a bug: a resource with no manifest should be in state undeployed and should never reach a start path'
    )
  }

  const durableObjects: RunnerManifest['durableObjects'] = {}
  for (const entry of config.manifest.durableObjects) {
    durableObjects[entry.binding] = {
      className: entry.className,
      // SQLite-backed, which is what makes `_cf_METADATA` (and therefore the
      // alarm deadline a stopped container cannot fire for itself) readable
      // from outside the runtime.
      useSQLite: true,
      unsafeUniqueKey: uniqueKeyFor(resource.id, entry.className),
    }
  }

  // Both null when there is nothing for the producer shim to reach: an empty
  // wrappedBindings target is dead weight, and a minted token nobody can use
  // is one more thing that could leak for no reason. Also gated on a real
  // token being present, not just producers being declared: a resource
  // created before queueToken existed reads back as undefined rather than
  // "", and this is what stops that from becoming the literal string
  // "undefined" wherever the runner concatenates it into a header. In
  // practice startWorker backfills the token before this ever runs, so the
  // gate is a belt-and-suspenders check, not the primary fix.
  const hasProducers =
    config.manifest.queues.producers.length > 0 &&
    typeof config.queueToken === 'string' &&
    config.queueToken.length > 0

  const runnerManifest: RunnerManifest = {
    port: CONTAINER_PORT,
    controlPort: config.controlPort,
    compatibilityDate: config.manifest.compatibilityDate,
    compatibilityFlags: config.manifest.compatibilityFlags,
    vars: config.manifest.vars,
    kvNamespaces: config.manifest.kvNamespaces,
    r2Buckets: config.manifest.r2Buckets,
    d1Databases: config.manifest.d1Databases,
    // ALWAYS []. See RunnerManifest's own comment: Miniflare's queue plugin
    // is never wired up, on purpose (ADR 0013). Never
    // `config.manifest.queues.*`: handing the real lists through here
    // constructs Miniflare's own broker, which then accepts every send and
    // delivers none of them, and no test in this repo would fail, because
    // the loss happens inside a runtime nothing here asserts on.
    queueProducers: [],
    queueConsumers: [],
    // host.docker.internal reaches the host's loopback from inside the
    // container (verified against a running Miniflare on 2026-08-13,
    // docs/queues/research/2026-08-13-wrapped-bindings-spike.md). The
    // daemon's own enqueue listener is a later task; this is the URL a
    // future one binds to. queuePort is optional on HobbyConfig (so existing
    // fixtures elsewhere do not need touching); 7434 matches
    // DEFAULT_CONFIG.queuePort in packages/core/src/config.ts.
    queueEndpoint: hasProducers ? `http://host.docker.internal:${deps.config.queuePort ?? 7434}/enqueue` : null,
    // config.queueToken, never resource.id: the id is returned by every
    // daemon route that lists or reads a resource (WireResource in
    // packages/cli/src/daemon/wire.ts is the whole resource), so using it as
    // a bearer credential would mean the token is published everywhere the
    // id already is, which defeats the scoping ADR 0013 introduced the token
    // for. See the comment on WorkerConfig.queueToken.
    queueToken: hasProducers ? config.queueToken : null,
    queueBindings: config.manifest.queues.producers.map((producer) => ({
      binding: producer.binding,
      queue: producer.queue,
    })),
    durableObjects,
  }

  // The binding that makes this worth doing at all: a Worker reaching the
  // project's own Postgres through the real Hyperdrive binding API, with no
  // connection string in the user's source and no secret in their repository.
  if (config.databaseResourceId !== null) {
    const sibling = deps.store.getResource(config.databaseResourceId)
    if (sibling !== null && sibling.kind === 'postgres') {
      runnerManifest.hyperdrives = { DB: hyperdriveUrl(sibling.config) }
    }
  }

  return runnerManifest
}

function containerSpec(deps: WorkerDeps, resource: WorkerResource, project: Project): ContainerSpec {
  const config = resource.config
  if (config.image === null) {
    throw new HobbyError(
      'internal',
      `resource ${config.containerName} has no image, so there is nothing to start`,
      'this is a bug: a resource with no image should be in state undeployed and should never reach a start path'
    )
  }
  return {
    name: config.containerName,
    image: config.image,
    env: {
      HOBBY_WORKER_MANIFEST: JSON.stringify(buildRunnerManifest(deps, resource)),
    },
    ports: [
      { host: config.hostPort, container: CONTAINER_PORT },
      // The control channel: a second published port, loopback only (bind
      // defaults to DEFAULT_PORT_BIND, same as the port above), so the
      // daemon can deliver queue batches without anything of ours sitting in
      // front of the worker on its own request path.
      { host: config.controlPort, container: CONTAINER_CONTROL_PORT },
    ],
    binds: [
      { host: deps.paths.resourcePath(project.name, resource.name, 'state'), container: CONTAINER_STATE },
      // The directory the daemon's alarm mirror scans read-only to recover
      // pending Durable Object alarms from a stopped container. Nothing else
      // writes here, which is why it is its own mount rather than a
      // subdirectory of `state`.
      { host: deps.paths.resourcePath(project.name, resource.name, 'do'), container: CONTAINER_DO },
    ],
    network: project.networkName,
  }
}

function notListening(config: WorkerConfig, waitedMs: number): HobbyError {
  return new HobbyError(
    'wake_timeout',
    `${config.containerName} did not start serving within ${waitedMs}ms`,
    'the worker failed to boot inside miniflare. `hobby logs` shows what workerd printed; a bad compatibility_date and a missing binding both look like this.'
  )
}

// Sends a real request and requires a real response. A plain TCP connect
// cannot answer this against a published container port: Docker's port proxy
// binds the host port the instant the container is created, so connect()
// succeeds while the process inside is starting, has crashed, or never ran.
// Verified by running it: a worker whose runner exited 1 immediately still
// passed a connect-only probe, was recorded `running`, and then refused every
// request. Same bug reconcile.ts documents for Postgres.
//
// Shared between the main port and the control port rather than written
// twice: both need exactly this, a status line over a real socket, on
// different ports and routes. Duplicated rather than shared with
// @hobby.sh/app deliberately, at the file boundary, for the reason recorded
// where this used to live: a package that exists to hold one twenty line
// function is a module pretending to be a package (root CLAUDE.md).
function httpProbe(port: number, request: { method: string; path: string }): () => Promise<boolean> {
  return async (): Promise<boolean> => {
    const net = await import('node:net')
    return new Promise((resolve) => {
      const socket = new net.Socket()
      let settled = false
      const finish = (value: boolean): void => {
        if (settled) return
        settled = true
        socket.destroy()
        resolve(value)
      }
      socket.setTimeout(500)
      socket.once('connect', () => {
        socket.write(
          `${request.method} ${request.path} HTTP/1.1\r\nHost: hobby.probe\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`
        )
      })
      socket.once('data', (chunk: Buffer) => {
        finish(chunk.subarray(0, 5).toString('latin1') === 'HTTP/')
      })
      socket.once('end', () => finish(false))
      socket.once('close', () => finish(false))
      socket.once('timeout', () => finish(false))
      socket.once('error', () => finish(false))
      socket.connect(port, '127.0.0.1')
    })
  }
}

// Whether this worker has any reason to need the control port at all. A
// producer never receives anything on it: the shim posts straight to the
// daemon's enqueue listener. A consumer needs it for everything, since a
// batch is DELIVERED by a POST to this exact port
// (docs/queues/specs/2026-08-13-queues-design.md, "Delivery over a second
// port, not a proxy"), so this checks both lists, not only producers, and a
// worker with neither is never made to wait on a channel it will never use.
//
// A null manifest (no code deployed yet, ADR 0014) declares nothing, so it
// answers false and the readiness probe stays on the main port alone.
function declaresQueueBindings(config: WorkerConfig): boolean {
  if (config.manifest === null) return false
  return config.manifest.queues.producers.length > 0 || config.manifest.queues.consumers.length > 0
}

// A worker recorded `running` on the main port alone, while its control
// port never came up, is the exact failure this whole capability exists to
// prevent, arriving through the readiness probe instead of the broker: the
// daemon would go on to deliver every batch to a port with nothing behind
// it, and nothing about the worker would look wrong. So when the worker
// declares a queue binding, readiness requires BOTH ports to answer, not
// only the one already covered above.
//
// The control probe POSTs to /queue with an empty body on purpose.
// CONTROL_SOURCE's fetch handler throws on `request.json()` for that, and
// runtime-image.ts's node:http bridge turns any error, thrown or rejected,
// into a real HTTP response rather than a hung socket, so this still proves
// what a probe needs to prove: something on the other end is parsing HTTP.
// The exact status code does not matter, 4xx and 5xx both count.
function defaultProbeFactory(): (config: WorkerConfig) => () => Promise<boolean> {
  return (config: WorkerConfig) => {
    const mainProbe = httpProbe(config.hostPort, { method: 'GET', path: '/' })
    if (!declaresQueueBindings(config)) {
      return mainProbe
    }
    const controlProbe = httpProbe(config.controlPort, { method: 'POST', path: '/queue' })
    return async (): Promise<boolean> => (await mainProbe()) && (await controlProbe())
  }
}

async function waitListening(
  probe: () => Promise<boolean>,
  opts: { pollMs: number; timeoutMs: number }
): Promise<{ ready: boolean; waitedMs: number }> {
  const started = Date.now()
  const deadline = started + opts.timeoutMs
  for (;;) {
    if (await probe()) {
      return { ready: true, waitedMs: Date.now() - started }
    }
    if (Date.now() >= deadline) {
      return { ready: false, waitedMs: Date.now() - started }
    }
    await new Promise((resolve) => setTimeout(resolve, opts.pollMs))
  }
}

export function workerTag(project: string, resource: string, at: number): string {
  return `hobby/${project}-${resource}-worker:${Math.floor(at / 1000)}`
}

// Writes the generated Dockerfile somewhere we own, never into the user's
// source directory. `docker build -f` accepts a Dockerfile outside the build
// context, which is what makes this possible without leaving files behind in
// a directory hobby does not own.
async function writeGeneratedDockerfile(
  deps: WorkerDeps,
  project: string,
  resource: string,
  manifest: WranglerManifest
): Promise<string> {
  const dir = deps.paths.resourcePath(project, resource, 'bundle')
  await mkdir(dir, { recursive: true })
  const path = join(dir, 'Dockerfile')
  await writeFile(path, renderWorkerDockerfile({ main: manifest.main }), 'utf8')
  return path
}

export interface CreateWorkerOptions {
  project: Project
  name: string
  sourcePath: string | null
  databaseResourceId: ResourceId | null
}

export interface CreateWorkerResult {
  resource: WorkerResource
  // Every wrangler key we read and did not act on, so the caller can print
  // them. Silence here is how a platform earns a reputation for lying.
  ignored: string[]
  logs: string
}

export async function createWorkerResource(
  deps: WorkerDeps,
  opts: CreateWorkerOptions
): Promise<CreateWorkerResult> {
  validateName(opts.name)
  const now = deps.now ?? Date.now

  // Same shape as createAppResource's: identity now, code later. Allocated
  // and written before any manifest is read, since there is no manifest yet
  // to read: nothing to build, nothing to clean up, nothing to roll back.
  // The modifier is still written in two steps, because it is derived from
  // the id the store assigns, but there is no build between them any more.
  if (opts.sourcePath === null) {
    const hostPort = deps.store.allocatePort(PORT_RANGE_FROM, PORT_RANGE_TO)
    // Both allocated here rather than at first deploy, which is the whole
    // point of them living above the manifest split (WorkerConfig, core's
    // types.ts): a worker created from Studio has a stable control port and
    // a stable producer token from the moment the row exists, and a redeploy
    // never moves either. Excludes hostPort for the same reason the deployed
    // path below does: the store cannot yet see a port it has not written.
    const controlPort = deps.store.allocatePort(PORT_RANGE_FROM, PORT_RANGE_TO, [hostPort])
    const containerName = `hobby-${opts.project.name}-${opts.name}`
    const config: WorkerConfig = {
      image: null,
      containerName,
      hostPort,
      controlPort,
      queueToken: randomUUID(),
      containerPort: CONTAINER_PORT,
      hostname: workerHostname(opts.project.name, opts.name, deps.config.domain),
      durableObjectUniqueKeyModifier: '',
      databaseResourceId: opts.databaseResourceId,
      manifest: null,
    }
    const created = deps.store.createResource({
      projectId: opts.project.id,
      kind: 'worker',
      name: opts.name,
      config,
    })
    const withKey: WorkerConfig = { ...config, durableObjectUniqueKeyModifier: created.id }
    deps.store.updateResourceConfig(created.id, withKey)
    deps.store.setResourceState(created.id, 'undeployed')
    // Both writes above only touch the store; `created` is the pre-write
    // snapshot createResource handed back (placeholder modifier, state
    // 'creating'), so the row is re-read rather than trusted, the same way
    // the built path below re-reads `final` instead of its own in-memory copy.
    const undeployed = deps.store.getResource(created.id)
    if (undeployed === null || undeployed.kind !== 'worker') {
      throw new HobbyError('internal', `worker ${created.id} vanished immediately after creation`)
    }
    return { resource: undeployed, ignored: [], logs: '' }
  }

  // Read the manifest BEFORE anything else. A missing `main`, an absent
  // compatibility_date or a malformed file should cost nothing: no row, no
  // allocated port, no image, nothing to clean up before retrying.
  const found = findWranglerManifest(opts.sourcePath)
  const manifest = found.manifest

  const hostPort = deps.store.allocatePort(PORT_RANGE_FROM, PORT_RANGE_TO)
  // Excludes hostPort: both come from the store before this resource has a
  // row, so the store cannot yet see hostPort's own answer to skip it.
  const controlPort = deps.store.allocatePort(PORT_RANGE_FROM, PORT_RANGE_TO, [hostPort])
  const containerName = `hobby-${opts.project.name}-${opts.name}`

  const dockerfilePath = await writeGeneratedDockerfile(deps, opts.project.name, opts.name, manifest)
  const tag = workerTag(opts.project.name, opts.name, now())
  const logs = await buildWorkerImage(deps.runtime, {
    contextPath: opts.sourcePath,
    dockerfilePath,
    tag,
    memory: BUILD_MEMORY,
    cpuShares: BUILD_CPU_SHARES,
  })

  const config: WorkerConfig = {
    image: tag,
    containerName,
    hostPort,
    controlPort,
    // Generated once here, unlike durableObjectUniqueKeyModifier below: it
    // does not need the resource's own id (the store has not assigned one
    // yet), so there is no placeholder-then-rewrite step for it to go
    // through.
    queueToken: randomUUID(),
    containerPort: CONTAINER_PORT,
    hostname: workerHostname(opts.project.name, opts.name, deps.config.domain),
    // Placeholder until the row exists: the real value is derived from the
    // resource id, which the store assigns. Rewritten immediately below.
    durableObjectUniqueKeyModifier: '',
    databaseResourceId: opts.databaseResourceId,
    manifest: {
      source: { path: opts.sourcePath, manifest: found.file },
      compatibilityDate: manifest.compatibilityDate,
      compatibilityFlags: manifest.compatibilityFlags,
      vars: manifest.vars,
      kvNamespaces: manifest.kvNamespaces,
      r2Buckets: manifest.r2Buckets,
      d1Databases: manifest.d1Databases,
      queues: manifest.queues,
      durableObjects: manifest.durableObjects,
    },
  }

  const created = deps.store.createResource({
    projectId: opts.project.id,
    kind: 'worker',
    name: opts.name,
    config,
  })
  deps.store.updateResourceConfig(created.id, {
    ...config,
    durableObjectUniqueKeyModifier: created.id,
  })

  const resource = deps.store.getResource(created.id)
  if (resource === null || resource.kind !== 'worker') {
    throw new HobbyError('internal', `worker ${created.id} vanished immediately after creation`)
  }

  try {
    await startWorker(deps, resource)
    // Proven to serve, then straight back to sleep. Same reasoning as the app
    // kind: sleeping is the resting state, and proving it boots while the
    // user is watching turns a silent broken deploy into an error.
    await stopWorker(deps, resource)
  } catch (err) {
    deps.store.setResourceState(resource.id, 'failed')
    throw err
  }

  const final = deps.store.getResource(resource.id)
  if (final === null || final.kind !== 'worker') {
    throw new HobbyError('internal', `worker ${resource.id} vanished immediately after creation`)
  }
  return { resource: final, ignored: manifest.ignored, logs }
}

export async function startWorker(deps: WorkerDeps, resource: WorkerResource): Promise<void> {
  const project = deps.store.getProject(resource.projectId)
  if (project === null) {
    throw new HobbyError('internal', `worker ${resource.id} has no owning project`)
  }

  // A worker created before queueToken existed has none: the stored JSON
  // simply lacks the key, so it reads back as undefined despite the type
  // saying string. Backfilled here, once, rather than left broken until a
  // redeploy: without this, buildRunnerManifest's own guard would treat the
  // worker as having no usable producer at all, silently disabling a
  // binding that used to work. Persisted immediately so this only ever runs
  // once per resource, matching durableObjectUniqueKeyModifier's own
  // never-regenerate reasoning: a producer holding the old value across a
  // wake should not find it rotated out from under it later.
  if (!resource.config.queueToken) {
    deps.store.updateResourceConfig(resource.id, { ...resource.config, queueToken: randomUUID() })
    const backfilled = deps.store.getResource(resource.id)
    if (backfilled === null || backfilled.kind !== 'worker') {
      throw new HobbyError('internal', `worker ${resource.id} vanished while backfilling its queue token`)
    }
    resource = backfilled
  }

  deps.store.setResourceState(resource.id, 'starting')
  try {
    // The persist directories are created by us rather than by Docker,
    // unlike the postgres data directory: nothing inside this container
    // re-owns them (miniflare runs as the image's default user and only ever
    // writes files, never chowns a tree), so there is no uid mismatch to
    // avoid by deferring to Docker.
    await mkdir(deps.paths.resourcePath(project.name, resource.name, 'state'), { recursive: true })
    await mkdir(deps.paths.resourcePath(project.name, resource.name, 'do'), { recursive: true })
    await deps.runtime.ensureNetwork(project.networkName)
    await deps.runtime.ensureCreated(containerSpec(deps, resource, project))
    await deps.runtime.start(resource.config.containerName)
  } catch (err) {
    deps.store.setResourceState(resource.id, 'failed')
    throw err
  }

  const probe = (deps.workerProbeFactory ?? defaultProbeFactory())(resource.config)
  const result = await waitListening(probe, {
    pollMs: deps.config.readinessPollMs,
    timeoutMs: deps.config.wakeTimeoutMs,
  })
  if (!result.ready) {
    deps.store.setResourceState(resource.id, 'failed')
    throw notListening(resource.config, result.waitedMs)
  }

  deps.store.setResourceState(resource.id, 'running')
  deps.store.touchResource(resource.id, new Date())
  deps.activity?.touch(resource.id)
}

export async function stopWorker(deps: WorkerDeps, resource: WorkerResource): Promise<void> {
  deps.store.setResourceState(resource.id, 'stopping')
  try {
    // A clean stop matters more here than for a plain app: the runner's
    // SIGTERM handler calls miniflare's dispose(), which flushes Durable
    // Object storage rather than leaving it to sqlite recovery on the next
    // wake, inside a user's first request.
    await deps.runtime.stop(resource.config.containerName, { timeoutSec: STOP_TIMEOUT_SEC })
  } catch (err) {
    deps.store.setResourceState(resource.id, 'failed')
    throw err
  }
  deps.store.setResourceState(resource.id, 'sleeping')
  deps.activity?.reset(resource.id)
}

export async function destroyWorker(deps: WorkerDeps, resource: WorkerResource): Promise<void> {
  const failures: string[] = []

  try {
    await deps.runtime.stop(resource.config.containerName, { timeoutSec: STOP_TIMEOUT_SEC })
  } catch (err) {
    failures.push(`stop container: ${errorMessage(err)}`)
  }
  try {
    await deps.runtime.remove(resource.config.containerName)
  } catch (err) {
    failures.push(`remove container: ${errorMessage(err)}`)
  }
  // A null image means an undeployed worker never built one in the first
  // place, which is a normal thing to destroy, not a bug: there is simply
  // nothing to remove.
  const image = resource.config.image
  if (image !== null && deps.runtime.removeImage !== undefined) {
    try {
      await deps.runtime.removeImage(image)
    } catch (err) {
      failures.push(`remove image: ${errorMessage(err)}`)
    }
  }

  // The state and Durable Object directories are deliberately LEFT ON DISK.
  // Destroying a worker removes the thing that serves requests; it is not an
  // instruction to delete data, and a Durable Object's sqlite file is user
  // data in exactly the way a postgres data directory is. `hobby rm` already
  // asks before it runs, and the path is printed so it can be removed
  // deliberately.
  deps.store.deleteResource(resource.id)
  deps.activity?.reset(resource.id)

  if (failures.length > 0) {
    throw new HobbyError(
      'internal',
      `worker ${resource.id} is no longer managed, but ${failures.length} teardown step(s) failed: ${failures.join('; ')}`,
      'a container or image may still remain and may need manual cleanup'
    )
  }
}

export async function probeWorker(deps: WorkerDeps, resource: WorkerResource): Promise<boolean> {
  return (deps.workerProbeFactory ?? defaultProbeFactory())(resource.config)()
}

export interface DeployWorkerResult {
  resource: WorkerResource
  image: string
  ignored: string[]
  logs: string
}

export async function deployWorker(
  deps: WorkerDeps,
  resource: WorkerResource,
  opts: { sourcePath?: string } = {}
): Promise<DeployWorkerResult> {
  const project = deps.store.getProject(resource.projectId)
  if (project === null) {
    throw new HobbyError('internal', `worker ${resource.id} has no owning project`)
  }
  // Falls back to the recorded source path on a redeploy. A worker whose
  // manifest is still null has never been deployed, so there is nothing
  // recorded to fall back to and the caller must say where the code is.
  // Names the actual fixing command rather than the wire shape, matching
  // deployApp's identical guard in packages/app/src/app.ts.
  let sourcePath = opts.sourcePath
  if (sourcePath === undefined) {
    if (resource.config.manifest === null) {
      throw new HobbyError(
        'usage',
        `${resource.name} has never been deployed, so this deploy needs a directory to build from`,
        `run \`hobby deploy <path> --project ${project.name} --name ${resource.name}\` from the directory holding its wrangler config`
      )
    }
    sourcePath = resource.config.manifest.source.path
  }

  // A first deploy that fails must not leave the resource looking broken,
  // because it is not: it is exactly as it was, a record with no code. Only
  // a resource that already HAD an image can meaningfully be `failed`.
  // Captured before anything below can throw, and covers every failure in
  // this function uniformly: a bad manifest, a failed build, a container
  // that never starts, or a readiness timeout inside startWorker all mean
  // the same thing for rollback purposes. Same rule as deployApp's,
  // packages/app/src/app.ts.
  const wasUndeployed = resource.state === 'undeployed'

  try {
    const found = findWranglerManifest(sourcePath)
    const manifest = found.manifest
    const now = deps.now ?? Date.now

    const dockerfilePath = await writeGeneratedDockerfile(deps, project.name, resource.name, manifest)
    const tag = workerTag(project.name, resource.name, now())
    const logs = await buildWorkerImage(deps.runtime, {
      contextPath: sourcePath,
      dockerfilePath,
      tag,
      memory: BUILD_MEMORY,
      cpuShares: BUILD_CPU_SHARES,
    })

    const config: WorkerConfig = {
      ...resource.config,
      image: tag,
      // Carried through explicitly rather than by spread alone, so that a
      // future edit to this object cannot silently drop it. It is derived
      // from the resource id and regenerating it here would orphan every
      // Durable Object's storage on every deploy, the sharpest data-loss
      // edge in this kind.
      durableObjectUniqueKeyModifier: resource.config.durableObjectUniqueKeyModifier,
      // Carried through explicitly for the same reason, with two different
      // failure modes. Both live ABOVE the manifest split precisely because
      // this object rebuilds `manifest` wholesale on every deploy: a moved
      // controlPort sends every queue batch to a port nothing is listening
      // on, and a rotated queueToken gives every already-running container
      // 401s from the enqueue listener, which reads as a broker outage
      // rather than as a token that changed underneath it.
      controlPort: resource.config.controlPort,
      queueToken: resource.config.queueToken,
      manifest: {
        source: { path: sourcePath, manifest: found.file },
        compatibilityDate: manifest.compatibilityDate,
        compatibilityFlags: manifest.compatibilityFlags,
        vars: manifest.vars,
        kvNamespaces: manifest.kvNamespaces,
        r2Buckets: manifest.r2Buckets,
        d1Databases: manifest.d1Databases,
        queues: manifest.queues,
        durableObjects: manifest.durableObjects,
      },
    }
    deps.store.updateResourceConfig(resource.id, config)

    // Replaced, not restarted: the image and the manifest environment are
    // both fixed at container create time.
    await deps.runtime.stop(config.containerName, { timeoutSec: STOP_TIMEOUT_SEC })
    await deps.runtime.remove(config.containerName)

    const updated = deps.store.getResource(resource.id)
    if (updated === null || updated.kind !== 'worker') {
      throw new HobbyError('internal', `worker ${resource.id} vanished during deploy`)
    }

    await startWorker(deps, updated)
    await stopWorker(deps, updated)

    const final = deps.store.getResource(resource.id)
    if (final === null || final.kind !== 'worker') {
      throw new HobbyError('internal', `worker ${resource.id} vanished during deploy`)
    }
    return { resource: final, image: tag, ignored: manifest.ignored, logs }
  } catch (err) {
    if (wasUndeployed) {
      // Same rule as deployApp's identical guard (packages/app/src/app.ts):
      // a first deploy can fail after startWorker already created and
      // started a real container (most commonly the readiness probe timing
      // out), and rolling `state` back to `undeployed` below makes that
      // container invisible to everything else in the daemon. skipReconcile
      // (packages/worker/src/kind.ts:45-46) hides an `undeployed` resource
      // from reconcile.ts entirely, and the hibernator's `state !== 'running'`
      // gate (packages/cli/src/daemon/hibernator.ts:35, :100) never reaches
      // it either. Stopped and removed right here, before the state write.
      // Best effort: a failure to clean up must not mask the original deploy
      // error, which is what the user actually needs to see.
      try {
        await deps.runtime.stop(resource.config.containerName, { timeoutSec: STOP_TIMEOUT_SEC })
        await deps.runtime.remove(resource.config.containerName)
      } catch {
        // Deliberately swallowed, see the comment above.
      }
    }
    deps.store.setResourceState(resource.id, wasUndeployed ? 'undeployed' : 'failed')
    throw err
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export function asWorker(resource: Resource): WorkerResource {
  if (resource.kind !== 'worker') {
    throw new HobbyError('internal', `resource ${resource.id} is a ${resource.kind}, not a worker`)
  }
  return resource
}
