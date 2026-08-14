// The `app` entry in core's resource kind registry. Thin, like
// @hobby.sh/pg's: every method forwards to a function in app.ts, so the
// daemon gains a kind without learning anything about containers.

import type { AppResource, ResourceKindHandler } from '@hobby.sh/core'
import { destroyApp, probeApp, startApp, stopApp, type AppDeps } from './app.js'

export const appKindHandler: ResourceKindHandler<AppResource> = {
  kind: 'app',

  start(deps: AppDeps, resource: AppResource): Promise<void> {
    return startApp(deps, resource)
  },

  stop(deps: AppDeps, resource: AppResource): Promise<void> {
    return stopApp(deps, resource)
  },

  destroy(deps: AppDeps, resource: AppResource): Promise<void> {
    return destroyApp(deps, resource)
  },

  probe(deps: AppDeps, resource: AppResource): Promise<boolean> {
    return probeApp(deps, resource)
  },

  // Deliberately no guard. An HTTP server with no in-flight request has
  // nothing to be interrupted, and the router's own connection count already
  // covers the in-flight case (see packages/proxy/src/http.ts, where the
  // activity handle is held for the whole response, streams included). core's
  // guardFor reads an absent guard as 'idle'.

  // An undeployed app has never had a container, by design: deploy is the
  // transition that creates one (see startApp in app.ts). Without this,
  // reconcile.ts would observe "no container" for a resource that never
  // asked for one and relabel it `failed` on the daemon's next tick. See
  // packages/core/src/kinds.ts's skipReconcile for why this lives on the
  // handler rather than as a state check in reconcile.ts itself.
  skipReconcile(resource: AppResource): boolean {
    return resource.state === 'undeployed'
  },
}
