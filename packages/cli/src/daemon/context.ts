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

import { createDockerRuntime, openStore, type ComputeRuntime, type HobbyConfig, type Paths, type Store } from '@hobby.sh/core'
import { ActivityTracker } from '@hobby.sh/proxy'

export interface DaemonContext {
  store: Store
  runtime: ComputeRuntime
  paths: Paths
  config: HobbyConfig
  activity: ActivityTracker
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
