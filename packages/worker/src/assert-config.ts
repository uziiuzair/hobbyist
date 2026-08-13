// One guard, called wherever a stored worker config is read back out of the
// store. See the spec's "Migration: none, deliberately": there are zero
// worker rows in existence, both kinds are days old and unreleased, so a
// normaliser would be carried for rows that do not exist. A loud failure is
// the honest alternative to a silent `undefined`, because store.ts:122
// parses the config column with an unchecked cast and would otherwise let a
// legacy row travel a long way before breaking.

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
