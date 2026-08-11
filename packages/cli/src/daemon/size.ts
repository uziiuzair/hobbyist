// The policy half of "how big is this resource" (see query-side factual
// half in packages/pg/src/size.ts's getDatabaseSize). Two rules from the
// task brief live here and nowhere else:
//
//   - never wake a database merely to display its size on a list page: a
//     resource that is not `running` is never connected to at all.
//   - a sleeping resource reports its last known size if one is on record,
//     null otherwise, never a stale-looking guess and never a hang.
//
// "Last known" is a plain in-memory cache, one Map per DaemonContext, keyed
// by resourceId, registered in a WeakMap the same way studio/routes.ts
// keeps its own per-context session state: every test's own fresh ctx (see
// routes.test.ts's buildContext) gets an independent cache, and the real
// daemon's one long-lived ctx keeps one cache for its own process lifetime.
// Deliberately not persisted to the store: a restarted daemon has not
// actually seen this resource's size yet in its own process lifetime, so
// starting back at "unknown until it next runs" is the accurate answer, not
// a stale number surviving the restart.

import type { PostgresConfig, Resource } from '@hobby.sh/core'
import { getDatabaseSize } from '@hobby.sh/pg'
import type { DaemonContext } from './context.js'

const cache = new WeakMap<DaemonContext, Map<string, number>>()

function cacheFor(ctx: DaemonContext): Map<string, number> {
  let known = cache.get(ctx)
  if (known === undefined) {
    known = new Map()
    cache.set(ctx, known)
  }
  return known
}

export async function resourceSize(
  ctx: DaemonContext,
  resource: Resource,
  getSize: (config: PostgresConfig) => Promise<number | null> = getDatabaseSize
): Promise<number | null> {
  const known = cacheFor(ctx)

  // Size means "how big is the database", which only a database has. An app
  // or a worker has no equivalent number worth reporting here: their disk
  // footprint is an image, shared between resources and not attributable to
  // one. Answered null rather than 0, which is what every consumer already
  // renders as a dash for a resource whose size is unknown.
  if (resource.kind !== 'postgres') {
    return null
  }

  if (resource.state !== 'running') {
    return known.get(resource.id) ?? null
  }

  const size = await getSize(resource.config)
  if (size !== null) {
    known.set(resource.id, size)
    return size
  }

  // A running resource whose size query failed (mid-boot, a transient
  // connection hiccup) still falls back to the last known figure rather
  // than a bare dash if one exists, exactly the same fallback as the
  // sleeping case above.
  return known.get(resource.id) ?? null
}
