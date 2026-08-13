// The resource kind registry. ADR 0007 promised that "later kinds are
// registered by implementing an interface, and earlier phases do not
// change"; this file is that interface, and the registry that dispatches to
// it.
//
// Before this existed, three files in the daemon named Postgres directly:
// hibernator.ts called stopPostgres on any sleep candidate, reconcile.ts
// probed Postgres readiness to tell `booting` from `ready`, and routes.ts
// called the Postgres lifecycle functions from its start/stop/destroy
// handlers. Each was correct while exactly one kind existed and each would
// have needed a switch statement per kind added. Now each looks a handler up
// by resource.kind and knows nothing else.
//
// Deliberately no behavior here beyond the lookup. core must never import
// Docker, Postgres or HTTP (see types.ts), so the handlers themselves live
// in the packages that own their kind: @hobby.sh/pg, @hobby.sh/app,
// @hobby.sh/worker.

import { HobbyError } from './errors.js'
import type { HobbyConfig, Paths } from './config.js'
import type { ComputeRuntime } from './runtime.js'
import type { Store } from './store.js'
import type { ActivitySink, Resource, ResourceKind } from './types.js'

// The answer to "is something using this right now", asked exactly once per
// resource per sleep attempt, immediately before an irreversible stop.
// `postgres` answers it with a real pg_stat_activity query
// (packages/pg/src/activity-guard.ts) so it can refuse to sleep
// mid-transaction. `app` and `worker` have no equivalent: an HTTP server
// with no in-flight request has nothing to be interrupted, and the proxy's
// connection count already covers the in-flight case. Declared here rather
// than in @hobby.sh/pg so core can name it without depending on pg.
//
// 'unreachable' is not 'idle'. A guard that could not answer must never be
// read as permission to stop.
export type ActivityGuardResult = 'active' | 'idle' | 'unreachable'

// The slice of the daemon a kind handler is allowed to see. Deliberately
// not the whole DaemonContext: a handler that could reach the HTTP server,
// Caddy or the proxy could break the seam the architecture rests on ("the
// proxy asks, the engine acts"). This is also, structurally, exactly
// @hobby.sh/pg's PgDeps, so postgres's existing functions satisfy it with
// no adapting.
export interface KindContext {
  store: Store
  runtime: ComputeRuntime
  paths: Paths
  config: HobbyConfig
  activity?: ActivitySink
}

// One kind's lifecycle. Every method takes the narrowed resource type, so a
// handler for 'app' is handed an AppResource and reads AppConfig fields
// without casting.
export interface ResourceKindHandler<TResource extends Resource = Resource> {
  kind: TResource['kind']

  // Bring the resource to `running`, or throw. Must be idempotent and cheap
  // when the resource is already running: the wake path calls it without
  // checking first, which is what makes ten simultaneous connections to one
  // sleeping resource safe (see getOrCreateWake in the daemon's context.ts).
  start(ctx: KindContext, resource: TResource): Promise<void>

  // Bring it to `sleeping`, cleanly. Never a kill: an ungracefully stopped
  // process pays for its recovery inside the next user's first request,
  // which is precisely what wake-on-demand exists to eliminate.
  stop(ctx: KindContext, resource: TResource): Promise<void>

  // Remove it and everything it owns on disk, then delete its row. Must be
  // resilient step by step (a resource can reach this having never had a
  // container created) while still reporting real failures rather than
  // swallowing them, since deleting the row while leaving data on disk
  // tells the caller their data is gone when it is not.
  destroy(ctx: KindContext, resource: TResource): Promise<void>

  // Observed reality for reconcile: is the thing INSIDE the container
  // actually serving, not merely running? The distinction is load-bearing
  // and was a real bug: a container's published port accepts TCP the
  // instant it starts, seconds before Postgres finishes crash recovery, so
  // trusting `docker inspect` alone reported `running` for a database that
  // answered `FATAL: the database system is starting up`. See reconcile.ts.
  probe(ctx: KindContext, resource: TResource): Promise<boolean>

  // Optional pre-sleep guard, called once immediately before stop(). An
  // absent guard means 'idle': a kind with nothing to interrupt should not
  // be forced to write a function that always says so.
  guard?(ctx: KindContext, resource: TResource): Promise<ActivityGuardResult>

  // Optional. Answers "should reconcile read a container state for this
  // resource at all?" An absent predicate means yes, which is the normal
  // case. It lives on the handler because whether a resource HAS a
  // container is a fact about its kind, not a fact reconcile should know.
  //
  // Two different shapes of "no" exist and both go through this one seam
  // rather than through separate exemptions in reconcile.ts. `app` and
  // `worker` answer per-resource: `undeployed` has no container yet, every
  // other state does. A kind with no container at all, in any state (a
  // `queue`, for instance) answers unconditionally. Sync, not async: the
  // whole point is to decide before paying for a Docker round trip
  // (ctx.runtime.inspect in reconcile.ts), so this cannot itself go ask
  // the runtime anything.
  skipReconcile?(resource: TResource): boolean
}

export type ResourceOfKind<K extends ResourceKind> = Extract<Resource, { kind: K }>

export interface KindRegistry {
  // Throws `unknown_kind` rather than returning undefined. Every caller is
  // dispatching on a kind that came out of the store, so an absent handler
  // means the daemon was built without a package it has rows for, which is
  // a misconfiguration to surface loudly, not a case to branch on.
  get(kind: ResourceKind): ResourceKindHandler
  has(kind: ResourceKind): boolean
  kinds(): ResourceKind[]
}

// Every concrete handler type, as a union. A handler is written against its
// own narrowed resource type (ResourceKindHandler<PostgresResource>), which
// is what makes the handler internally type-safe; the registry has to hold
// several different ones in one structure.
//
// ResourceKindHandler's methods are declared with method syntax, whose
// parameter checking is bivariant, so a handler for one kind is assignable
// to the general ResourceKindHandler. That is unsound in general and sound
// here because of one runtime invariant: the registry keys on handler.kind
// itself (below) rather than trusting a caller to pass a matching pair, so a
// handler registered under kind K is only ever handed a resource whose
// `kind` is K. Every dispatch site (routes, hibernator, reconcile, the wake
// path) reads `registry.get(resource.kind)` and therefore upholds it.
export type AnyResourceKindHandler = {
  [K in ResourceKind]: ResourceKindHandler<ResourceOfKind<K>>
}[ResourceKind]

export function createKindRegistry(handlers: AnyResourceKindHandler[]): KindRegistry {
  const byKind = new Map<ResourceKind, AnyResourceKindHandler>()

  for (const handler of handlers) {
    if (byKind.has(handler.kind)) {
      throw new HobbyError(
        'conflict',
        `two handlers registered for resource kind ${handler.kind}`,
        'each kind has exactly one owning package'
      )
    }
    byKind.set(handler.kind, handler)
  }

  return {
    get(kind: ResourceKind): ResourceKindHandler {
      const handler = byKind.get(kind)
      if (handler === undefined) {
        throw new HobbyError(
          'unknown_kind',
          `no handler registered for resource kind ${kind}`,
          `registered kinds: ${[...byKind.keys()].join(', ') || 'none'}`
        )
      }
      return handler as ResourceKindHandler
    },

    has(kind: ResourceKind): boolean {
      return byKind.has(kind)
    },

    kinds(): ResourceKind[] {
      return [...byKind.keys()]
    },
  }
}

// Narrow a Resource to one kind, or throw.
//
// Needed at the boundaries where a resource comes back out of the store
// (which can only promise `Resource`) and is handed to code that works on
// exactly one kind: `connectionString` wants a postgres, `startApp` wants an
// app. A plain `as` cast at each of those sites would compile and then hand
// a worker to code that reads `config.dataDir`, so this checks at runtime
// and fails loudly instead.
//
// 'internal', not a user-facing code: every caller has already established
// which kind it is dealing with (from a route's own kind check, or from
// having just created the resource), so reaching this throw means a bug
// here, not a mistake by whoever ran the command.
export function expectKind<K extends ResourceKind>(resource: Resource, kind: K): ResourceOfKind<K> {
  if (resource.kind !== kind) {
    throw new HobbyError(
      'internal',
      `resource ${resource.id} is a ${resource.kind}, but a ${kind} was expected`
    )
  }
  return resource as ResourceOfKind<K>
}

// The guard result for a resource whose handler declares none. Reading it
// through one named function rather than inlining `?? 'idle'` at each
// dispatch site keeps the "absent means idle, never means unreachable"
// rule in one place.
export async function guardFor(
  registry: KindRegistry,
  ctx: KindContext,
  resource: Resource
): Promise<ActivityGuardResult> {
  const handler = registry.get(resource.kind)
  if (handler.guard === undefined) {
    return 'idle'
  }
  return handler.guard(ctx, resource)
}
