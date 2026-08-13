// The `queue` entry in core's resource kind registry.
//
// It is the first kind with no container, and every method here is shaped by
// that. `stop` is a no-op rather than an error because the hibernator and the
// daemon's shutdown both call stop on things they are holding, and a queue
// answering "I have nothing to stop" is the truthful answer. This kind is
// not wired into the daemon's registry yet, so nothing calls any of these
// methods today: Task 11 both registers the handler and gives the
// hibernator and reconcile an exemption for a kind with no container, so
// `stop` is not reached from there until that lands.

import { existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import {
  openDatabaseReadOnly,
  type KindContext,
  type Paths,
  type QueueResource,
  type ResourceKindHandler,
} from '@hobby.sh/core'
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

  // Observe, never create. openQueueDb (schema.ts) makes the directory,
  // creates the file if absent, and runs CREATE TABLE IF NOT EXISTS: calling
  // it from probe would mean a queue that was never started, or one whose
  // directory reconcile just removed, reports itself running simply because
  // asking the question brought it into existence. That is the same class
  // of bug as a Postgres probe trusting a container's open TCP port before
  // the postmaster has finished crash recovery (see core/kinds.ts's comment
  // on ResourceKindHandler.probe) and the same one worker.ts and app.ts
  // record for a published port that accepts a connection before anything
  // inside is listening. openDatabaseReadOnly exists for exactly this: it
  // opens without perturbing what it observes, the same reason @hobby.sh/do
  // uses it to read a Durable Object's alarm table.
  async probe(ctx: KindContext, resource: QueueResource): Promise<boolean> {
    const path = pathFor(ctx, resource)
    if (!existsSync(path)) {
      return false
    }
    try {
      const db = openDatabaseReadOnly(path)
      try {
        const row = db
          .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'messages'")
          .get()
        return row !== undefined
      } finally {
        db.close()
      }
    } catch {
      return false
    }
  },
}
