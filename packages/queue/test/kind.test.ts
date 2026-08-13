import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { resolvePaths, type ComputeRuntime, type KindContext, type QueueResource, type Store } from '@hobby.sh/core'
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

// Three callers hold a resource and call stop() on it without checking its
// kind first: the hibernator's sleep path (packages/cli/src/daemon
// /hibernator.ts), the daemon's own shutdown sequence (server.ts), and
// `hobby eject --release` (routes.ts). None of them special-case a queue,
// and none of them needs to, because a queue holds no process, which makes
// stopping one a no-op by construction rather than by omission. That is
// only true for as long as this function stays empty, and nothing else
// enforces it: there is no compile-time exhaustiveness on ResourceKind in
// this repo, so a future stop() that reaches for the store, the runtime, or
// the file it is holding would compile and pass every other test in this
// file. This is the one that catches it, and its failure message names the
// three callers that were relying on the old behaviour.
test('stop does nothing, and three callers depend on that: the hibernator, the daemon shutdown, and eject --release', async () => {
  const { ctx, resource } = context()
  await queueKindHandler.start(ctx, resource)
  const path = queueDbPath(ctx.paths, 'proj', 'vault-embed')
  const before = readFileSync(path)

  // Counting rather than asserting on an eventual side effect, the same
  // reasoning as the hibernator's own guardCalls: any property read on
  // either stub, called or not, is itself proof stop() reached for
  // something it must not need.
  let storeCalls = 0
  let runtimeCalls = 0
  const watchedStore = new Proxy(
    {},
    {
      get(_target, prop) {
        storeCalls++
        return (): undefined => undefined
      },
    }
  ) as unknown as Store
  const watchedRuntime = new Proxy(
    {},
    {
      get(_target, prop) {
        runtimeCalls++
        return (): undefined => undefined
      },
    }
  ) as unknown as ComputeRuntime

  await queueKindHandler.stop({ ...ctx, store: watchedStore, runtime: watchedRuntime }, resource)

  assert.equal(storeCalls, 0, 'stop must never touch the store: none of its three callers checks first')
  assert.equal(runtimeCalls, 0, 'stop must never touch the runtime: a queue has no container for any of its three callers to stop')
  assert.deepEqual(readFileSync(path), before, "stop must leave the queue's database exactly as it found it")
})

test('probe answers true for a queue whose file is readable', async () => {
  const { ctx, resource } = context()
  await queueKindHandler.start(ctx, resource)
  assert.equal(await queueKindHandler.probe(ctx, resource), true)
})

// The defect this pins: probe used to call openQueueDb, which creates the
// directory, the file and the schema as a side effect of merely looking, so
// a queue that had never been started still probed true. A probe
// implemented as `return true` would pass every other test in this file
// (they all call start() first) but fails these two.
test('probe answers false for a queue that was never started', async () => {
  const { ctx, resource } = context()
  assert.equal(await queueKindHandler.probe(ctx, resource), false)
})

test('probe does not create the file it is asked to observe', async () => {
  const { ctx, resource } = context()
  const path = queueDbPath(ctx.paths, 'proj', 'vault-embed')
  await queueKindHandler.probe(ctx, resource)
  assert.equal(existsSync(path), false)
})

test('probe answers false once destroy has removed the queue directory', async () => {
  const { ctx, resource } = context()
  await queueKindHandler.start(ctx, resource)
  assert.equal(await queueKindHandler.probe(ctx, resource), true)
  await queueKindHandler.destroy(ctx, resource)
  assert.equal(await queueKindHandler.probe(ctx, resource), false)
})
