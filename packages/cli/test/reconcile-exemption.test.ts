// Task 9b's seam: `skipReconcile` on ResourceKindHandler
// (packages/core/src/kinds.ts). This lives in its own file rather than
// appended to kind-dispatch.test.ts, which already has the fake-handler
// machinery this could have reused: a parallel session (building the
// `queue` kind, the one that asked for this seam) was editing that file
// while this task ran, and the two tests here are about exactly one
// question, "does reconcile skip a resource whose handler says to skip
// it," which stands on its own as a reason for a dedicated file, not only
// as a way around the contention.
//
// buildContext and the two stub handlers below are small, self-contained
// copies of kind-dispatch.test.ts's own stubAppHandler/buildContext
// shape, not imports from that file, for the same contention reason.

import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  createFakeRuntime,
  createKindRegistry,
  openStore,
  resolvePaths,
  type AppConfig,
  type HobbyConfig,
  type KindContext,
  type Resource,
  type ResourceKindHandler,
  type Store,
} from '@hobby.sh/core'
import { ActivityTracker } from '@hobby.sh/proxy'
import { reconcile, type DaemonContext } from '../src/index.js'

function testConfig(overrides: Partial<HobbyConfig> = {}): HobbyConfig {
  return {
    image: 'postgres:18-alpine',
    proxyPort: 5432,
    studioPort: 8443,
    apiPort: 7432,
    httpPort: 7433,
    domain: 'localhost',
    sleepAfterSeconds: 300,
    wakeTimeoutMs: 150,
    readinessPollMs: 20,
    queuePort: 0,
    caddyEnabled: false,
    caddyAdminPort: 2019,
    caddyStudioHost: null,
    ...overrides,
  }
}

function sampleAppConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    image: 'hobby/blog-web:1',
    containerName: `hobby-blog-web-${randomUUID()}`,
    hostPort: 15500,
    containerPort: 3000,
    hostname: 'web.blog.localhost',
    source: null,
    env: {},
    databaseResourceId: null,
    ...overrides,
  }
}

// Only the one handler under test is registered: neither test here creates
// a postgres resource, so there is nothing for a postgres handler to do.
function buildContext(handler: ResourceKindHandler): DaemonContext {
  const store: Store = openStore(':memory:')
  const paths = resolvePaths({ HOBBY_HOME: join(tmpdir(), `hobby-reconcile-exemption-test-${randomUUID()}`) })
  return {
    store,
    runtime: createFakeRuntime(),
    paths,
    config: testConfig(),
    activity: new ActivityTracker(),
    kinds: createKindRegistry([handler]),
  }
}

// A handler whose skipReconcile answers true unconditionally: the shape the
// `queue` kind needs. A queue has no container in ANY state, so its
// exemption cannot be spelled as a per-state check the way app and
// worker's `undeployed` exemption is (packages/app/src/kind.ts,
// packages/worker/src/kind.ts).
function stubHandlerThatAlwaysSkipsReconcile(): ResourceKindHandler & { calls: string[] } {
  const calls: string[] = []
  return {
    kind: 'app',
    calls,
    async start(_ctx: KindContext, resource: Resource): Promise<void> {
      calls.push(`start:${resource.name}`)
    },
    async stop(_ctx: KindContext, resource: Resource): Promise<void> {
      calls.push(`stop:${resource.name}`)
    },
    async destroy(_ctx: KindContext, resource: Resource): Promise<void> {
      calls.push(`destroy:${resource.name}`)
    },
    async probe(_ctx: KindContext, resource: Resource): Promise<boolean> {
      calls.push(`probe:${resource.name}`)
      return true
    },
    skipReconcile(): boolean {
      return true
    },
  }
}

// A handler with no skipReconcile at all, otherwise identical: the control
// case proving the optional predicate defaults to "do not skip."
function stubHandlerWithNoSkipReconcile(): ResourceKindHandler & { calls: string[] } {
  const calls: string[] = []
  return {
    kind: 'app',
    calls,
    async start(_ctx: KindContext, resource: Resource): Promise<void> {
      calls.push(`start:${resource.name}`)
    },
    async stop(_ctx: KindContext, resource: Resource): Promise<void> {
      calls.push(`stop:${resource.name}`)
    },
    async destroy(_ctx: KindContext, resource: Resource): Promise<void> {
      calls.push(`destroy:${resource.name}`)
    },
    async probe(_ctx: KindContext, resource: Resource): Promise<boolean> {
      calls.push(`probe:${resource.name}`)
      return true
    },
  }
}

test('a handler whose skipReconcile always answers true survives a reconcile tick untouched, even in a state that would otherwise be corrected to failed', async () => {
  const handler = stubHandlerThatAlwaysSkipsReconcile()
  const ctx = buildContext(handler)
  const project = ctx.store.createProject({ name: 'blog', sleepAfterSeconds: 300 })
  const resource = ctx.store.createResource({
    projectId: project.id,
    kind: 'app',
    name: 'web',
    config: sampleAppConfig(),
  })
  // Recorded running, with a fake runtime that was never told this
  // container exists. Without the exemption, ctx.runtime.inspect reports
  // missing, and correctedState (packages/cli/src/daemon/reconcile.ts:137)
  // maps that to failed, exactly as it does for postgres in
  // routes.test.ts's own reconcile tests.
  ctx.store.setResourceState(resource.id, 'running')

  await reconcile(ctx)

  assert.equal(ctx.store.getResource(resource.id)?.state, 'running')
  // Zero calls, not just an unchanged state: skipReconcile has to be
  // checked before ctx.runtime.inspect in reconcile.ts, so an exempt
  // resource costs no Docker round trip and no probe call either.
  assert.deepEqual(handler.calls, [])
  ctx.store.close()
})

test('a handler with no skipReconcile still gets its container checked on reconcile, so the absent predicate defaults to "do not skip"', async () => {
  const handler = stubHandlerWithNoSkipReconcile()
  assert.equal(handler.skipReconcile, undefined, 'this stub deliberately declares no skipReconcile')
  const ctx = buildContext(handler)
  const project = ctx.store.createProject({ name: 'blog', sleepAfterSeconds: 300 })
  const resource = ctx.store.createResource({
    projectId: project.id,
    kind: 'app',
    name: 'web',
    config: sampleAppConfig(),
  })
  ctx.store.setResourceState(resource.id, 'running')

  await reconcile(ctx)

  // failed, not running: the same relabeling correctedState applies to any
  // recorded-running resource whose container has vanished. Nothing about
  // this path is app-specific; it is what happens whenever a handler
  // declares no skipReconcile at all.
  assert.equal(ctx.store.getResource(resource.id)?.state, 'failed')
  ctx.store.close()
})
