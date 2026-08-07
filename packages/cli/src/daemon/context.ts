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
  HobbyError,
  openStore,
  type ComputeRuntime,
  type HobbyConfig,
  type Paths,
  type PostgresConfig,
  type Resource,
  type Store,
} from '@hobby.sh/core'
import { startPostgres } from '@hobby.sh/pg'
import { ActivityTracker, type ProxyDeps, type ProxyTarget } from '@hobby.sh/proxy'

export interface DaemonContext {
  store: Store
  runtime: ComputeRuntime
  paths: Paths
  config: HobbyConfig
  activity: ActivityTracker
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
      await startPostgres(ctx, resource)
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

    const resources = ctx.store.listResources(project.id)
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
        `project ${projectName} has more than one resource: ${resources.map((r) => r.name).join(', ')}`,
        'the wake-on-connect proxy cannot disambiguate resources by database name alone; connect to a project with exactly one resource'
      )
    }

    const resource = resources[0] as Resource
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
