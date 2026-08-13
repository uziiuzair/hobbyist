import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { resolvePaths, type KindContext, type QueueResource, type Store } from '@hobby.sh/core'
import { queueDbPath, queueKindHandler } from '../src/kind.js'

const homes: string[] = []
after(() => {
  for (const home of homes) rmSync(home, { recursive: true, force: true })
})

function context(): { ctx: KindContext; resource: QueueResource } {
  const home = mkdtempSync(join(tmpdir(), 'hobby-queue-kind-'))
  homes.push(home)
  const paths = resolvePaths({ HOBBY_HOME: home })
  const resource: QueueResource = {
    id: 'q-1',
    projectId: 'p-1',
    name: 'vault-embed',
    kind: 'queue',
    state: 'running',
    lastActiveAt: null,
    createdAt: new Date(),
    config: {
      image: '',
      containerName: '',
      hostPort: 0,
      retentionSeconds: 345600,
      consumerResourceId: null,
      maxBatchSize: 5,
      maxBatchTimeoutSeconds: 1,
      maxRetries: 2,
      retryDelaySeconds: 0,
      deadLetterQueue: null,
    },
  }
  // Only `paths` and `store.getProject` are read by this handler. The store
  // stub is a narrow object, not a full fake Store, and everything else in
  // KindContext is filled with a value that fails loudly if it is ever
  // touched, so a handler that starts reading `runtime` or `config` breaks
  // this test instead of silently working.
  const store = {
    getProject: () => ({ name: 'proj' }),
  } as unknown as Store
  const ctx = {
    paths,
    store,
    runtime: null as never,
    config: null as never,
  } as unknown as KindContext
  return { ctx, resource }
}

test('the handler declares the queue kind', () => {
  assert.equal(queueKindHandler.kind, 'queue')
})

test('start creates the queue database and never asks for a container', async () => {
  const { ctx, resource } = context()
  await queueKindHandler.start(ctx, resource)
  assert.ok(existsSync(queueDbPath(ctx.paths, 'proj', 'vault-embed')))
})

test('stop resolves and does nothing, because a queue has no process', async () => {
  const { ctx, resource } = context()
  await queueKindHandler.stop(ctx, resource)
})

test('probe answers true for a queue whose file is readable', async () => {
  const { ctx, resource } = context()
  await queueKindHandler.start(ctx, resource)
  assert.equal(await queueKindHandler.probe(ctx, resource), true)
})
