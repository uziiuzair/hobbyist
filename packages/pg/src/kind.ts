// The `postgres` entry in core's resource kind registry.
//
// Deliberately thin. Every method here forwards to a function that already
// existed and is already tested (postgres.ts, readiness.ts,
// activity-guard.ts); nothing about how Postgres starts, stops or is torn
// down changed when the registry arrived. That is the whole acceptance
// criterion for M6: the daemon stops naming Postgres, and Postgres itself
// does not notice.
//
// The parameter type is PgDeps rather than core's KindContext. The two are
// structurally the same four required fields, and ResourceKindHandler
// declares its methods with method syntax, whose bivariant parameter checking
// is what lets a handler ask for the slightly richer type it actually reads
// (PgDeps carries the probeFactory and removeDataDir test seams that core has
// no business knowing about).

import type { PostgresResource, ResourceKindHandler } from '@hobby.sh/core'
import { checkActiveQuery, type ActivityGuardResult } from './activity-guard.js'
import { destroyPostgres, startPostgres, stopPostgres, type PgDeps } from './postgres.js'
import { pgProbe } from './readiness.js'

export const postgresKindHandler: ResourceKindHandler<PostgresResource> = {
  kind: 'postgres',

  start(deps: PgDeps, resource: PostgresResource): Promise<void> {
    return startPostgres(deps, resource)
  },

  stop(deps: PgDeps, resource: PostgresResource): Promise<void> {
    return stopPostgres(deps, resource)
  },

  destroy(deps: PgDeps, resource: PostgresResource): Promise<void> {
    return destroyPostgres(deps, resource)
  },

  // "Did Postgres itself answer", not "is the container running". The
  // distinction is the bug reconcile.ts's own comment describes at length: a
  // container's published port accepts TCP the instant it starts, seconds
  // before the postmaster finishes crash recovery, so a resource that looked
  // `running` could hand a client `FATAL: the database system is starting
  // up`. Honouring probeFactory here matters for the same reason it matters
  // in startPostgres: without it, every daemon-level test against a fake
  // runtime would wait out a real connection timeout to nothing.
  probe(deps: PgDeps, resource: PostgresResource): Promise<boolean> {
    return (deps.probeFactory ?? pgProbe)(resource.config)()
  },

  // The one kind with a real pre-sleep guard: a database mid-transaction
  // must not be stopped underneath its client. Apps and workers have no
  // equivalent and declare no guard at all, which core reads as 'idle'.
  guard(_deps: PgDeps, resource: PostgresResource): Promise<ActivityGuardResult> {
    return checkActiveQuery(resource.config)
  },
}
