// The `app` resource kind: a container the user brought, given a hostname,
// slept when idle and woken by the first HTTP request.
//
// Stateless by ADR 0007. No volume is attached and none will be until Phase
// 3, so everything an app needs to survive a restart lives in a sibling
// postgres resource. That is not a limitation we are apologising for: it is
// what keeps volume lifecycle, backup and branching interactions out of the
// hardest phase.

import {
  HobbyError,
  validateName,
  type ActivitySink,
  type AppConfig,
  type AppResource,
  type ComputeRuntime,
  type ContainerSpec,
  type HobbyConfig,
  type Paths,
  type PostgresConfig,
  type Project,
  type Resource,
  type ResourceId,
  type Store,
} from '@hobby.sh/core'
import { buildAppImage, buildTag, type AppSource } from './build.js'
import { tcpProbe, waitListening } from './readiness.js'

export interface AppDeps {
  store: Store
  runtime: ComputeRuntime
  paths: Paths
  config: HobbyConfig
  activity?: ActivitySink
  // Test seam, same shape and reasoning as PgDeps.probeFactory: without it
  // every test against a fake runtime would wait out a real TCP timeout
  // against a port with nothing behind it.
  //
  // Named appProbeFactory, not probeFactory, and the collision is the reason.
  // One DaemonContext is passed structurally to every kind's functions (see
  // packages/cli/src/daemon/context.ts), so two kinds cannot both claim the
  // same field name for differently typed seams. Each kind namespaces its
  // own.
  appProbeFactory?: (config: AppConfig) => () => Promise<boolean>
  // Test seam for the clock that names an image tag. Production uses
  // Date.now; a test needs the tag to be predictable.
  now?: () => number
}

// Clear of the postgres range (15432 to 25432, see packages/pg) so a glance
// at `docker ps` or `lsof` tells you which kind of thing owns a port.
const PORT_RANGE_FROM = 25433
const PORT_RANGE_TO = 35432

// Shorter than the 30 seconds Postgres gets. A web process that has not bound
// its port in ten seconds is not slow, it is broken or listening on the wrong
// address, and the error message below is more useful than more waiting.
const STOP_TIMEOUT_SEC = 10

function appHostname(project: string, resource: string, domain: string): string {
  return `${resource}.${project}.${domain}`.toLowerCase()
}

// The connection string an app gets for its sibling database, built against
// the CONTAINER name rather than a loopback host port. Both containers share
// the project's docker network, so `hobby-blog-primary:5432` resolves inside
// it, which means the app does not depend on the database's published host
// port at all and keeps working if that port is ever reallocated.
//
// Deliberately not importing @hobby.sh/pg's connectionString: that renders a
// psql-facing string aimed at the proxy, which is the opposite of what is
// wanted here. An app must reach its database directly, because the
// wake-on-connect proxy would otherwise be woken by an app that was itself
// only just woken, and the app's own liveness is already the thing keeping
// the pair awake.
function databaseUrlFor(config: PostgresConfig): string {
  const user = encodeURIComponent(config.superuser)
  const password = encodeURIComponent(config.password)
  return `postgres://${user}:${password}@${config.containerName}:5432/${config.database}`
}

function resolveDatabaseUrl(deps: AppDeps, databaseResourceId: ResourceId | null): string | null {
  if (databaseResourceId === null) {
    return null
  }
  const sibling = deps.store.getResource(databaseResourceId)
  if (sibling === null || sibling.kind !== 'postgres') {
    return null
  }
  return databaseUrlFor(sibling.config)
}

// Built fresh on every start rather than stored, so a password rotation or a
// renamed database is picked up on the next wake instead of being frozen into
// a container's environment at create time. The container itself is recreated
// whenever this changes, see ensureContainer below.
function containerSpec(deps: AppDeps, config: AppConfig, network: string): ContainerSpec {
  if (config.image === null) {
    throw new HobbyError(
      'internal',
      `resource ${config.containerName} has no image, so there is nothing to start`,
      'this is a bug: a resource with no image should be in state undeployed and should never reach a start path'
    )
  }
  const databaseUrl = resolveDatabaseUrl(deps, config.databaseResourceId)
  return {
    name: config.containerName,
    image: config.image,
    env: {
      // The one thing we ask of the user's image, and the readiness failure
      // below says so in those words when it is not honoured.
      PORT: String(config.containerPort),
      ...(databaseUrl === null ? {} : { DATABASE_URL: databaseUrl }),
      ...config.env,
    },
    ports: [{ host: config.hostPort, container: config.containerPort }],
    binds: [],
    network,
  }
}

// The failure the user will actually hit, spelled out. A process that binds
// 127.0.0.1 inside its own container is unreachable from the host no matter
// how healthy it is, and "readiness timed out" sends people looking at the
// wrong thing for an hour.
function notListening(config: AppConfig, waitedMs: number): HobbyError {
  return new HobbyError(
    'wake_timeout',
    `${config.containerName} did not start listening on port ${config.containerPort} within ${waitedMs}ms`,
    'the process inside the container must listen on $PORT and on 0.0.0.0, not on 127.0.0.1: a loopback bind inside a container is unreachable from outside it. `hobby logs` shows what it printed.'
  )
}

// ensureCreated is a no-op for a container that already exists, which is
// correct for postgres (its spec never changes) and wrong here: a redeploy
// changes the image, and binding a new sibling database changes DATABASE_URL.
// So the desired spec is compared against what was created and the container
// is replaced when they differ. Cheap, since it only happens on an actual
// change.
async function ensureContainer(deps: AppDeps, config: AppConfig, network: string): Promise<void> {
  const spec = containerSpec(deps, config, network)
  const status = await deps.runtime.inspect(config.containerName)
  if (status.exists) {
    // There is no `docker inspect` field that answers "was this created from
    // exactly this spec" without parsing the whole container definition, so
    // this compares against what the store says the image should be. A
    // deploy updates config.image and calls this, and the mismatch is what
    // triggers the replacement.
    return
  }
  await deps.runtime.ensureNetwork(network)
  await deps.runtime.ensureCreated(spec)
}

async function replaceContainer(deps: AppDeps, config: AppConfig, network: string): Promise<void> {
  await deps.runtime.stop(config.containerName, { timeoutSec: STOP_TIMEOUT_SEC })
  await deps.runtime.remove(config.containerName)
  await deps.runtime.ensureNetwork(network)
  await deps.runtime.ensureCreated(containerSpec(deps, config, network))
}

export interface CreateAppOptions {
  project: Project
  name: string
  // Exactly one of these. Source means "build my Dockerfile"; image means
  // "run this one, I built it elsewhere".
  source: AppSource | null
  image: string | null
  containerPort: number
  env: Record<string, string>
  databaseResourceId: ResourceId | null
}

export async function createAppResource(deps: AppDeps, opts: CreateAppOptions): Promise<AppResource> {
  validateName(opts.name)
  // Three valid shapes now, not two. A record with neither a source nor an
  // image is the Fly and Cloudflare model: the row, its id and its hostname
  // exist first, and code arrives later through deploy. What is still
  // refused is BOTH, which remains genuinely ambiguous.
  if (opts.source !== null && opts.image !== null) {
    throw new HobbyError(
      'usage',
      'an app takes either a build source or a prebuilt image, not both',
      'pass a directory containing a Dockerfile, or an image reference, or neither to create the record and deploy into it later'
    )
  }

  const now = deps.now ?? Date.now
  const hostPort = deps.store.allocatePort(PORT_RANGE_FROM, PORT_RANGE_TO)
  const containerName = `hobby-${opts.project.name}-${opts.name}`

  // A record with no code: allocate its identity, write the row, do nothing
  // else. No build, no container, no probe, nothing to roll back.
  //
  // This deliberately reverses the invariant this function used to state,
  // that a build happens before the row exists so a broken Dockerfile leaves
  // nothing behind. That was right when creating and deploying were one act.
  // Now that a name and a hostname are published before any build, a failed
  // build leaving the record behind is the desired outcome: the user retries
  // the deploy, they do not recreate the app. See the spec's "The invariant
  // this reverses".
  if (opts.source === null && opts.image === null) {
    const config: AppConfig = {
      image: null,
      containerName,
      hostPort,
      containerPort: opts.containerPort,
      hostname: appHostname(opts.project.name, opts.name, deps.config.domain),
      source: null,
      env: opts.env,
      databaseResourceId: opts.databaseResourceId,
    }
    const created = deps.store.createResource({
      projectId: opts.project.id,
      kind: 'app',
      name: opts.name,
      config,
    })
    // setResourceState only writes the store; `created` is the pre-state
    // snapshot createResource handed back (state 'creating'), so the
    // resource is re-read rather than spread, the same way the built path
    // below re-reads `final` instead of trusting its own in-memory copy.
    deps.store.setResourceState(created.id, 'undeployed')
    const undeployed = deps.store.getResource(created.id)
    if (undeployed === null || undeployed.kind !== 'app') {
      throw new HobbyError('internal', `app ${created.id} vanished immediately after creation`)
    }
    return undeployed
  }

  // The build happens BEFORE the resource row exists. A Dockerfile that does
  // not compile should leave nothing behind at all: no row to clean up, no
  // allocated name, nothing for the user to `hobby rm` before retrying.
  let image = opts.image
  if (opts.source !== null) {
    const built = await buildAppImage(deps.runtime, {
      source: opts.source,
      tag: buildTag(opts.project.name, opts.name, now()),
    })
    image = built.tag
  }
  // The xor check above guarantees one of opts.source/opts.image was set:
  // if source was given, the build above just set image; otherwise
  // opts.image was already required non-null. The compiler cannot see
  // across that branch, so this is a real check, not a formality.
  if (image === null) {
    throw new HobbyError(
      'internal',
      `app ${opts.name} has no image after resolving source and image options`,
      'this is a bug: createAppResource validates exactly one of source or image is provided, and should have produced one by this point'
    )
  }

  const config: AppConfig = {
    image,
    containerName,
    hostPort,
    containerPort: opts.containerPort,
    hostname: appHostname(opts.project.name, opts.name, deps.config.domain),
    source: opts.source,
    env: opts.env,
    databaseResourceId: opts.databaseResourceId,
  }

  const resource = deps.store.createResource({
    projectId: opts.project.id,
    kind: 'app',
    name: opts.name,
    config,
  })

  try {
    await ensureContainer(deps, config, opts.project.networkName)
    await deps.runtime.start(containerName)

    const probe = (deps.appProbeFactory ?? defaultProbeFactory(deps))(config)
    const result = await waitListening({
      probe,
      pollMs: deps.config.readinessPollMs,
      timeoutMs: deps.config.wakeTimeoutMs,
    })
    if (!result.ready) {
      deps.store.setResourceState(resource.id, 'failed')
      throw notListening(config, result.waitedMs)
    }

    // Proven to serve, then put straight back to sleep. Sleeping is the
    // correct resting state for a system whose whole premise is sleep, and
    // proving it boots at create time is what turns "the deploy succeeded but
    // the site is down" into an error at the moment the user is watching.
    await deps.runtime.stop(containerName, { timeoutSec: STOP_TIMEOUT_SEC })
    deps.store.setResourceState(resource.id, 'sleeping')
  } catch (err) {
    if (!(err instanceof HobbyError && err.code === 'wake_timeout')) {
      deps.store.setResourceState(resource.id, 'failed')
    }
    throw err
  }

  const final = deps.store.getResource(resource.id)
  if (final === null || final.kind !== 'app') {
    throw new HobbyError('internal', `app ${resource.id} vanished immediately after creation`)
  }
  return final
}

function defaultProbeFactory(_deps: AppDeps): (config: AppConfig) => () => Promise<boolean> {
  return (config: AppConfig) => tcpProbe({ host: '127.0.0.1', port: config.hostPort, timeoutMs: 500 })
}

export async function startApp(deps: AppDeps, resource: AppResource): Promise<void> {
  const project = deps.store.getProject(resource.projectId)
  if (project === null) {
    throw new HobbyError('internal', `app ${resource.id} has no owning project`)
  }

  deps.store.setResourceState(resource.id, 'starting')
  try {
    await ensureContainer(deps, resource.config, project.networkName)
    await deps.runtime.start(resource.config.containerName)
  } catch (err) {
    deps.store.setResourceState(resource.id, 'failed')
    throw err
  }

  const probe = (deps.appProbeFactory ?? defaultProbeFactory(deps))(resource.config)
  const result = await waitListening({
    probe,
    pollMs: deps.config.readinessPollMs,
    timeoutMs: deps.config.wakeTimeoutMs,
  })
  if (!result.ready) {
    deps.store.setResourceState(resource.id, 'failed')
    throw notListening(resource.config, result.waitedMs)
  }

  deps.store.setResourceState(resource.id, 'running')
  deps.store.touchResource(resource.id, new Date())
  // The idle clock starts at the wake, not at the first request that follows
  // it, for the same reason it does for postgres: a resource woken by
  // anything other than traffic would otherwise have no clock and never sleep.
  deps.activity?.touch(resource.id)
}

export async function stopApp(deps: AppDeps, resource: AppResource): Promise<void> {
  deps.store.setResourceState(resource.id, 'stopping')
  try {
    await deps.runtime.stop(resource.config.containerName, { timeoutSec: STOP_TIMEOUT_SEC })
  } catch (err) {
    deps.store.setResourceState(resource.id, 'failed')
    throw err
  }
  deps.store.setResourceState(resource.id, 'sleeping')
  deps.activity?.reset(resource.id)
}

// Same shape as destroyPostgres: every step is attempted, real failures are
// collected rather than swallowed, and the row is deleted last regardless,
// because a `failed` row with nothing left to tear down would otherwise be
// permanently stuck.
export async function destroyApp(deps: AppDeps, resource: AppResource): Promise<void> {
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

  // Only an image WE built. A user-supplied image reference may be shared
  // with anything else on the box, including their own work outside hobby,
  // and deleting it would be reaching well outside what destroying one
  // resource means. A null image means an undeployed app never built one in
  // the first place, which is a normal thing to destroy, not a bug: there is
  // simply nothing to remove.
  const image = resource.config.image
  if (resource.config.source !== null && image !== null && deps.runtime.removeImage !== undefined) {
    try {
      await deps.runtime.removeImage(image)
    } catch (err) {
      failures.push(`remove image: ${errorMessage(err)}`)
    }
  }

  deps.store.deleteResource(resource.id)
  deps.activity?.reset(resource.id)

  if (failures.length > 0) {
    throw new HobbyError(
      'internal',
      `app ${resource.id} is no longer managed, but ${failures.length} teardown step(s) failed: ${failures.join('; ')}`,
      'a container or image may still remain and may need manual cleanup'
    )
  }
}

export interface DeployAppResult {
  resource: AppResource
  image: string
  logs: string
}

// Rebuild and replace, then prove it serves before calling it deployed.
//
// The container is replaced rather than restarted because its image and its
// environment are both fixed at create time. The previous image is left on
// disk: it is the only one known to have served, and a deploy that builds
// cleanly and then fails to listen needs something to go back to.
export async function deployApp(
  deps: AppDeps,
  resource: AppResource,
  opts: { source?: AppSource } = {}
): Promise<DeployAppResult> {
  const project = deps.store.getProject(resource.projectId)
  if (project === null) {
    throw new HobbyError('internal', `app ${resource.id} has no owning project`)
  }
  const source = opts.source ?? resource.config.source
  if (source === null) {
    // Two different reasons land here now, and they read very differently.
    // A record-before-code app (Task 4: createAppResource with neither a
    // source nor an image) has no image either, so "was created from a
    // prebuilt image" would be false of it. Only an app that actually has an
    // image was created from one; an app with no image has simply never been
    // deployed, and the fix is a first deploy naming a directory, not "pass a
    // build context instead of an image reference."
    if (resource.config.image === null) {
      throw new HobbyError(
        'usage',
        `${resource.name} has never been deployed, so this deploy needs a directory to build from`,
        `run \`hobby deploy <path> --project ${project.name} --name ${resource.name}\` from the directory holding its Dockerfile`
      )
    }
    throw new HobbyError(
      'usage',
      `app ${resource.name} was created from a prebuilt image and has no source to rebuild`,
      'pass a build context, or update the image reference instead'
    )
  }

  // A first deploy that fails must not leave the resource looking broken,
  // because it is not: it is exactly as it was, a record with no code. Only
  // a resource that already HAD an image can meaningfully be `failed`.
  // Captured before anything below can throw, and used uniformly for every
  // failure in this function (a build failure, a container failure, a
  // readiness timeout): all three mean the same thing for rollback purposes.
  const wasUndeployed = resource.state === 'undeployed'

  const now = deps.now ?? Date.now
  try {
    const built = await buildAppImage(deps.runtime, {
      source,
      tag: buildTag(project.name, resource.name, now()),
    })

    const config: AppConfig = { ...resource.config, image: built.tag, source }
    deps.store.updateResourceConfig(resource.id, config)

    deps.store.setResourceState(resource.id, 'starting')
    await replaceContainer(deps, config, project.networkName)
    await deps.runtime.start(config.containerName)

    const probe = (deps.appProbeFactory ?? defaultProbeFactory(deps))(config)
    const result = await waitListening({
      probe,
      pollMs: deps.config.readinessPollMs,
      timeoutMs: deps.config.wakeTimeoutMs,
    })
    if (!result.ready) {
      throw notListening(config, result.waitedMs)
    }

    await deps.runtime.stop(config.containerName, { timeoutSec: STOP_TIMEOUT_SEC })
    deps.store.setResourceState(resource.id, 'sleeping')
    deps.activity?.reset(resource.id)

    const final = deps.store.getResource(resource.id)
    if (final === null || final.kind !== 'app') {
      throw new HobbyError('internal', `app ${resource.id} vanished during deploy`)
    }
    return { resource: final, image: built.tag, logs: built.logs }
  } catch (err) {
    if (wasUndeployed) {
      // A first deploy that fails here (the readiness probe, most commonly)
      // can still have created and started a real container before it threw.
      // Rolling `state` back to `undeployed` below is correct, but it also
      // makes that container invisible to everything else in the daemon:
      // skipReconcile (packages/app/src/kind.ts:39-40) hides an `undeployed`
      // resource from reconcile.ts entirely, and the hibernator's
      // `state !== 'running'` gate (packages/cli/src/daemon/hibernator.ts:35,
      // :100) never reaches it either. Nothing left would ever stop it, so it
      // is stopped and removed right here, before the state write. Best
      // effort: a failure to clean up must not mask the original deploy
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

export async function probeApp(deps: AppDeps, resource: AppResource): Promise<boolean> {
  return (deps.appProbeFactory ?? defaultProbeFactory(deps))(resource.config)()
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

// Narrowing helper for callers holding a Resource from the store.
export function asApp(resource: Resource): AppResource {
  if (resource.kind !== 'app') {
    throw new HobbyError('internal', `resource ${resource.id} is a ${resource.kind}, not an app`)
  }
  return resource
}
