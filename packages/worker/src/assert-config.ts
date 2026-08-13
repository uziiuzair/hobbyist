// One guard, wired into buildRunnerManifest (packages/worker/src/worker.ts),
// which sits on two paths: container start, via containerSpec, and eject,
// via packages/cli/src/daemon/routes.ts's renderCompose. It does NOT run on
// every read of a stored worker config. Two production reads of
// `config.manifest` are still unguarded: packages/cli/src/daemon/wire.ts's
// redactConfig, reached by every `hobby ls`, resource GET, Studio call and
// MCP call, and this package's deployWorker redeploy fallback
// (packages/worker/src/worker.ts). See the spec's "Migration: none,
// deliberately": there are zero worker rows in existence anywhere, both
// kinds are days old and unreleased, which is the same fact those two
// unguarded reads currently lean on instead of a normaliser or this guard.
// A loud failure here is the honest alternative to a silent `undefined`,
// because store.ts:122 parses the config column with an unchecked cast and
// would otherwise let a legacy row travel a long way before breaking.

import { HobbyError, type WorkerConfig } from '@hobby.sh/core'

export function assertWorkerConfig(config: WorkerConfig): WorkerConfig {
  if (!('manifest' in config)) {
    throw new HobbyError(
      'internal',
      'this worker row predates the manifest split and cannot be read',
      'delete it with `hobby rm <project>/<name>` and redeploy. No data is lost: a worker holds no state outside its Durable Object storage, which is keyed on the resource id and is not affected.'
    )
  }
  return config
}
