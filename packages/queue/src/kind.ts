// The `queue` entry in core's resource kind registry.
//
// It is the first kind with no container, and every method here is shaped by
// that. `stop` is a no-op rather than an error because the hibernator and the
// daemon's shutdown both call stop on things they are holding, and a queue
// answering "I have nothing to stop" is the truthful answer. The hibernator
// additionally skips this kind outright, so stop is never reached from there.

import { rmSync } from 'node:fs'
import { join } from 'node:path'
import type { KindContext, Paths, QueueResource, ResourceKindHandler } from '@hobby.sh/core'
import { openQueueDb } from './schema.js'

export function queueDbPath(paths: Paths, projectName: string, queueName: string): string {
  return join(paths.resourcePath(projectName, queueName, 'queue'), 'messages.sqlite')
}

function pathFor(ctx: KindContext, resource: QueueResource): string {
  const project = ctx.store.getProject(resource.projectId)
  if (project === null) {
    throw new Error(`queue ${resource.name} has no project`)
  }
  return queueDbPath(ctx.paths, project.name, resource.name)
}

export const queueKindHandler: ResourceKindHandler<QueueResource> = {
  kind: 'queue',

  async start(ctx: KindContext, resource: QueueResource): Promise<void> {
    openQueueDb(pathFor(ctx, resource)).close()
  },

  async stop(): Promise<void> {
    // Nothing to stop. A queue holds no process, which is exactly why its
    // messages outlive the worker that produced them.
  },

  async destroy(ctx: KindContext, resource: QueueResource): Promise<void> {
    const project = ctx.store.getProject(resource.projectId)
    if (project !== null) {
      rmSync(ctx.paths.resourcePath(project.name, resource.name, 'queue'), {
        recursive: true,
        force: true,
      })
    }
  },

  async probe(ctx: KindContext, resource: QueueResource): Promise<boolean> {
    try {
      openQueueDb(pathFor(ctx, resource)).close()
      return true
    } catch {
      return false
    }
  },
}
