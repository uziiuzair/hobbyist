// Which Durable Object schedules the alarm mirror should be watching.
//
// The mirror itself (@hobby.sh/do) knows how to read a schedule and when to
// ask for a wake, and deliberately knows nothing about the store. This is the
// one function that joins the two, and it lives in the daemon for the same
// reason ProxyDeps does: the store is the daemon's, and a package that could
// reach it would be a package that could act on it.

import { namespaceDirs, type MirroredNamespace } from '@hobby.sh/do'
import type { DaemonContext } from './context.js'

// Every namespace directory belonging to a worker that is not currently able
// to fire its own alarms.
//
// Three exclusions, each of which would otherwise cause a wake that is at best
// wasted and at worst wrong:
//
//   - Not a `worker`. Postgres and `app` have no alarms.
//   - Already running or starting. A live workerd has its own timer and fires
//     its own alarms, deleting the row as it goes. Asking to wake a running
//     resource is a no-op, but it is a no-op repeated every tick for every
//     alarm a busy worker has pending, which turns a quiet loop into a noisy
//     one for no benefit.
//   - A released project. `hobby eject --release` handed the data directory
//     to the user's own compose stack, and Project.releasedAt exists precisely
//     so hobby stops acting on it. Waking a released worker would start a
//     container hobby no longer owns, which is the failure that flag prevents.
//     The hibernator applies the same rule for the same reason.
export function durableObjectNamespaces(ctx: DaemonContext): MirroredNamespace[] {
  const namespaces: MirroredNamespace[] = []

  for (const resource of ctx.store.listResources()) {
    if (resource.kind !== 'worker') {
      continue
    }
    if (resource.state === 'running' || resource.state === 'starting') {
      continue
    }

    const project = ctx.store.getProject(resource.projectId)
    if (project == null || project.releasedAt != null) {
      continue
    }

    for (const namespaceDir of namespaceDirs(ctx.paths.resourcePath(project.name, resource.name, 'do'))) {
      namespaces.push({ resourceId: resource.id, namespaceDir })
    }
  }

  return namespaces
}
