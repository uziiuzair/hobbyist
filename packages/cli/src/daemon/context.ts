// DaemonContext is the one piece of shared state every route handler,
// reconcile, and shutdown read and write. It is built once, outside this
// file (by whatever process starts the daemon), and threaded through
// createApp and startDaemon. It is also, structurally, a superset of
// @hobby.sh/pg's PgDeps: store, runtime, paths and config are the same four
// required fields, so a DaemonContext can be passed straight into
// createPostgres/startPostgres/stopPostgres/destroyPostgres without any
// adapting. The extra `activity` field they ignore is exactly what makes
// this a daemon context rather than just a PgDeps.
//
// Constructing an ActivityTracker is the daemon's job, not the proxy's: see
// packages/proxy/src/activity.ts's own file comment. Task 7 wires this same
// instance into ProxyDeps when it starts the wake-on-connect proxy; nothing
// here starts that proxy, see the task report for why that split is
// deliberate.

import {
  createDockerRuntime,
  createKindRegistry,
  HobbyError,
  openStore,
  type ComputeRuntime,
  type HobbyConfig,
  type KindRegistry,
  type Paths,
  type PostgresConfig,
  type PostgresResource,
  type Store,
} from '@hobby.sh/core'
import { appKindHandler } from '@hobby.sh/app'
import { postgresKindHandler } from '@hobby.sh/pg'
import { workerKindHandler } from '@hobby.sh/worker'
import {
  ActivityTracker,
  type HttpProxyDeps,
  type HttpTarget,
  type ProxyDeps,
  type ProxyTarget,
} from '@hobby.sh/proxy'

// Every kind this daemon knows how to run. One list, built here, read by
// every dispatch site (routes, hibernator, reconcile, the wake path). Adding
// a kind is adding a line here plus its package; nothing else in the daemon
// learns a new name. That is what ADR 0007's "later kinds are registered by
// implementing an interface, and earlier phases do not change" buys.
export function createDefaultKindRegistry(): KindRegistry {
  return createKindRegistry([postgresKindHandler, appKindHandler, workerKindHandler])
}

export interface DaemonContext {
  store: Store
  runtime: ComputeRuntime
  paths: Paths
  config: HobbyConfig
  activity: ActivityTracker
  kinds: KindRegistry
  // Optional test seam, identical in shape and reasoning to
  // PgDeps.probeFactory (packages/pg/src/postgres.ts) and read by exactly
  // that code, since a DaemonContext structurally IS a PgDeps. Declaring it
  // here is what lets a daemon-level test (routes, hibernator, reconcile)
  // simulate a Postgres that genuinely answers, rather than having every
  // wake run out its readiness timeout against a fake runtime with nothing
  // listening. reconcile.ts reads the same field for its own readiness
  // probe. Production never sets it and gets pgProbe, a real connection.
  probeFactory?: (config: PostgresConfig) => () => Promise<boolean>
}

// A convenience factory for the real, production wiring: opens the real
// sqlite store at paths.statePath and talks to the real Docker daemon.
// Entirely optional. Tests build a DaemonContext by hand, from a fake
// runtime and an in-memory store, and never call this. Whatever eventually
// implements `hobby init` (not built in this task) is the intended caller.
export function createDaemonContext(opts: {
  paths: Paths
  config: HobbyConfig
  runtime?: ComputeRuntime
}): DaemonContext {
  return {
    store: openStore(opts.paths.statePath),
    runtime: opts.runtime ?? createDockerRuntime(),
    paths: opts.paths,
    config: opts.config,
    activity: new ActivityTracker(),
    kinds: createDefaultKindRegistry(),
  }
}

// The one real, idempotent wake function for a given DaemonContext:
// concurrent callers for the same resourceId all await the same in-flight
// startPostgres call, tracked in a Map private to this closure. The proxy
// itself deliberately does not de-duplicate concurrent wakes for the same
// resource (see packages/proxy/src/proxy.ts's own comment on
// ProxyDeps.wake); this is what turns ten simultaneous connections to one
// sleeping resource into exactly one startPostgres call, with every caller
// awaiting the same promise. The entry is removed in a `finally` on both
// success and failure, so one failed wake does not permanently poison the
// resource for every connection after it.
function buildWake(ctx: DaemonContext): (resourceId: string) => Promise<void> {
  const inFlightWakes = new Map<string, Promise<void>>()

  return function wake(resourceId: string): Promise<void> {
    const existing = inFlightWakes.get(resourceId)
    if (existing !== undefined) {
      return existing
    }

    const promise = (async (): Promise<void> => {
      const resource = ctx.store.getResource(resourceId)
      if (resource === null) {
        throw new HobbyError('resource_not_found', `no resource with id ${resourceId}`)
      }
      // Dispatched by kind rather than calling startPostgres directly, which
      // is what makes this one wake path serve every kind: an app waking on
      // an HTTP request and a database waking on a connection are the same
      // call here, differing only in which handler answers it.
      await ctx.kinds.get(resource.kind).start(ctx, resource)
    })().finally(() => {
      inFlightWakes.delete(resourceId)
    })

    inFlightWakes.set(resourceId, promise)
    return promise
  }
}

const wakeRegistry = new WeakMap<DaemonContext, (resourceId: string) => Promise<void>>()

// Memoized per DaemonContext in a WeakMap, the same pattern
// studio/routes.ts uses for its own per-context session state: this is what
// lets createProxyDeps (below, the proxy's own caller) and
// packages/cli/src/daemon/routes.ts's queryRoute (POST
// /v1/resources/:id/query) share the exact same wake function, and the
// exact same in-flight map, whenever they are handed the same ctx, which in
// production they always are, one DaemonContext per running daemon. That is
// what makes the query route's wake genuinely "the same idempotent wake
// path the proxy uses" rather than a second, independent implementation of
// the same idea: a client connecting through the proxy and Studio calling
// the query route for the same sleeping resource at the same moment await
// the one real startPostgres call in flight, not two. A fresh ctx (every
// test's own buildContext()) gets its own independent function and map, so
// tests stay isolated from each other and from production.
export function getOrCreateWake(ctx: DaemonContext): (resourceId: string) => Promise<void> {
  let wake = wakeRegistry.get(ctx)
  if (wake === undefined) {
    wake = buildWake(ctx)
    wakeRegistry.set(ctx, wake)
  }
  return wake
}

// The real ProxyDeps the wake-on-connect proxy runs against, bound to this
// DaemonContext. Task 4 left this exact wiring as Task 7's to do (see
// task-4-report.md's "What Task 7 must wire"): resolve looks a project up
// by the routing key's project segment and returns its resource's running
// host, port and database; wake calls startPostgres, which already waits
// for real readiness before resolving, satisfying ProxyDeps.wake's
// contract that it must not resolve until Postgres is actually accepting
// connections.
export function createProxyDeps(ctx: DaemonContext): ProxyDeps {
  async function resolve(projectName: string): Promise<ProxyTarget | null> {
    const project = ctx.store.getProjectByName(projectName)
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
    const resources = ctx.store.listResources(project.id).filter((r) => r.kind === 'postgres')
    if (resources.length === 0) {
      return null
    }
    if (resources.length > 1) {
      // The wire protocol's routing key (core's parseRoutingKey) carries a
      // project and, optionally, a database, never a resource name: there
      // is nothing in a Postgres startup packet that can disambiguate which
      // of several resources under one project a client means. The CLI's
      // own resolveTarget (packages/cli/src/cli/commands.ts) hits the same
      // ambiguity for `project/resource` targets and throws the same code;
      // matching it here keeps one error identity for "this project needs a
      // specific resource named" across both surfaces. proxy.ts's own
      // try/catch around deps.resolve turns this into a FATAL error on the
      // wire rather than crashing the connection handler.
      throw new HobbyError(
        'ambiguous_target',
        `project ${projectName} has more than one postgres resource: ${resources.map((r) => r.name).join(', ')}`,
        'the wake-on-connect proxy cannot disambiguate resources by database name alone; connect to a project with exactly one postgres resource'
      )
    }

    const resource = resources[0] as PostgresResource
    return {
      resourceId: resource.id,
      host: '127.0.0.1',
      port: resource.config.hostPort,
      state: resource.state,
      database: resource.config.database,
    }
  }

  return { resolve, wake: getOrCreateWake(ctx), activity: ctx.activity }
}

// `<resource>.<project>.<domain>` split back into its two names.
//
// Exactly two labels ahead of the domain, never a wildcard match on the
// leftmost label alone: `a.b.c.blog.localhost` must not resolve to project
// `blog`, because accepting extra labels would let one deployed app be
// reached under names that look like other people's subdomains.
//
// Exported for its own tests: this is pure string handling with no store, no
// clock and no I/O, and it is the one place a hostname becomes a routing
// decision.
export function parseAppHostname(
  hostname: string,
  domain: string
): { project: string; resource: string } | null {
  const suffix = `.${domain.toLowerCase()}`
  const lower = hostname.toLowerCase()
  if (!lower.endsWith(suffix) || lower.length === suffix.length) {
    return null
  }
  const labels = lower.slice(0, -suffix.length).split('.')
  if (labels.length !== 2) {
    return null
  }
  const [resource, project] = labels
  if (resource === undefined || project === undefined || resource === '' || project === '') {
    return null
  }
  return { project, resource }
}

// The HTTP wake router's view of the world, bound to this DaemonContext.
// Mirrors createProxyDeps above: resolve reads the store, wake is the same
// memoized, de-duplicated wake the Postgres proxy and the query route
// already share, and activity is the same tracker hibernation reads. One
// wake path for every kind and every protocol is the point.
export function createHttpProxyDeps(ctx: DaemonContext): HttpProxyDeps {
  async function resolve(hostname: string): Promise<HttpTarget | null> {
    const parsed = parseAppHostname(hostname, ctx.config.domain)
    if (parsed === null) {
      return null
    }
    const project = ctx.store.getProjectByName(parsed.project)
    if (project === null) {
      return null
    }

    // Same refusal as the Postgres proxy's, for the same reason: a released
    // project's containers belong to the user's own compose stack now, and
    // waking one here would start a second copy of something already
    // running. Thrown rather than returned as null so the router can render
    // 503 with this reason rather than a bare 404, which would read as "you
    // never deployed this".
    if (project.releasedAt != null) {
      throw new HobbyError(
        'conflict',
        `project ${parsed.project} was released and is no longer managed by hobby`,
        `run \`hobby adopt ${parsed.project}\` to take it back`
      )
    }

    const resource = ctx.store.getResourceByName(project.id, parsed.resource)
    if (resource === null) {
      return null
    }
    // Only compute kinds serve HTTP. A postgres resource has a hostname
    // shaped like this one by accident of the naming scheme, and routing a
    // browser to port 5432 would hand it a Postgres wire protocol error.
    if (resource.kind !== 'app' && resource.kind !== 'worker') {
      return null
    }

    return {
      resourceId: resource.id,
      host: '127.0.0.1',
      port: resource.config.hostPort,
      state: resource.state,
    }
  }

  // Caddy's on-demand TLS gate. Deliberately the same lookup as resolve, so
  // there is exactly one definition of "a hostname this box serves", and
  // deliberately swallowing the released-project refusal: a released project
  // is a reason not to route a request, not a reason to refuse a
  // certificate for a name that genuinely belongs to this box.
  async function allowHostname(hostname: string): Promise<boolean> {
    try {
      return (await resolve(hostname)) !== null
    } catch {
      return true
    }
  }

  return { resolve, allowHostname, wake: getOrCreateWake(ctx), activity: ctx.activity }
}
