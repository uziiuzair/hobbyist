// A queue is `running` from creation and never changes, because it holds no
// process. Both background loops the daemon runs read every resource on
// every pass, and both would misread that permanent `running` state:
//
//   - the hibernator's candidate filter is exactly `state !== 'running'`, so
//     without its own queue skip (hibernator.ts) a queue matches on every
//     tick, forever.
//   - reconcile asks the runtime to inspect a container by name to decide
//     what `running` should really mean; a queue has no container behind
//     its (unused) containerName, so without reconcile's own skip
//     (reconcile.ts) a healthy queue would be relabeled `failed` on every
//     daemon start.
//
// This file pins both skips, plus the registration that makes `queue` a
// kind the daemon's registry can resolve at all.

import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  createFakeRuntime,
  openStore,
  resolvePaths,
  type ActivityGuardResult,
  type ComputeRuntime,
  type HobbyConfig,
  type QueueConfig,
  type Store,
  type WorkerConfig,
} from '@hobby.sh/core'
import { ActivityTracker } from '@hobby.sh/proxy'
import { reconcile, startHibernator, type DaemonContext } from '../src/index.js'
import { createDefaultKindRegistry } from '../src/daemon/context.js'
import { toWireResource } from '../src/daemon/wire.js'

test('the registry resolves the queue kind', () => {
  const registry = createDefaultKindRegistry()
  assert.equal(registry.get('queue').kind, 'queue')
})

// ---------------------------------------------------------------------------
// Shared fixture, copied in shape from hibernator.test.ts's own buildContext
// and testConfig, plus kind-dispatch.test.ts's sampleQueueConfig: every
// unused ResourceConfigBase field (image, containerName, hostPort) is
// present only because every existing call site expects it on any resource.
// ---------------------------------------------------------------------------

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
    ...overrides,
  }
}

function buildContext(
  runtime: ComputeRuntime = createFakeRuntime(),
  activity: ActivityTracker = new ActivityTracker()
): DaemonContext {
  const store: Store = openStore(':memory:')
  const paths = resolvePaths({ HOBBY_HOME: join(tmpdir(), `hobby-queue-kind-test-${randomUUID()}`) })
  return { store, runtime, paths, config: testConfig(), activity, kinds: createDefaultKindRegistry() }
}

function sampleQueueConfig(overrides: Partial<QueueConfig> = {}): QueueConfig {
  return {
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
    ...overrides,
  }
}

// Copied in shape from kind-dispatch.test.ts's own worker fixtures rather
// than imported from that file: this test moved here specifically so it does
// not depend on, or edit, a file another concurrent session is appending to
// (packages/cli/test/kind-dispatch.test.ts).
function sampleWorkerConfig(overrides: Partial<WorkerConfig> = {}): WorkerConfig {
  return {
    image: 'hobby/workerd:1',
    containerName: 'hobby-blog-api',
    hostPort: 15602,
    controlPort: 15603,
    queueToken: 'do-not-leak-this-bearer-token',
    containerPort: 8787,
    hostname: 'api.blog.localhost',
    durableObjectUniqueKeyModifier: 'stable-modifier',
    databaseResourceId: null,
    manifest: {
      source: { path: '/src/api', manifest: 'wrangler.toml' },
      compatibilityDate: '2026-08-01',
      compatibilityFlags: [],
      vars: {},
      kvNamespaces: [],
      r2Buckets: [],
      d1Databases: [],
      queues: { producers: [{ queue: 'jobs', binding: 'JOBS' }], consumers: [] },
      durableObjects: [],
    },
    ...overrides,
  }
}

// Drives startHibernator's loop one tick at a time. Copied in shape from
// hibernator.test.ts's own createStepController: sleepFor() blocks until
// step() releases it, and step()'s returned promise only resolves once the
// loop has come back around to block on the next interval, which is the
// signal that the triggered tick, including any awaited guard call, has
// fully finished.
function createStepController(): { sleepFor: (ms: number) => Promise<void>; step: () => Promise<void> } {
  let pendingRelease: (() => void) | null = null
  let onNextWait: (() => void) | null = null

  function sleepFor(): Promise<void> {
    return new Promise<void>((resolve) => {
      pendingRelease = resolve
      const notify = onNextWait
      onNextWait = null
      notify?.()
    })
  }

  function step(): Promise<void> {
    return new Promise<void>((resolveStep) => {
      onNextWait = resolveStep
      const release = pendingRelease
      pendingRelease = null
      release?.()
    })
  }

  return { sleepFor, step }
}

// Wraps a runtime's stop() with a counter, the same pattern hibernator.test.ts
// uses for start() (countingRuntime). The queue kind's own stop() never calls
// this today (it is a documented no-op, see kind.ts), which already makes the
// hibernator's sleep harmless for a queue; the skip this test protects is
// about never reaching the sleep decision at all, not merely about it being
// safe once reached, so this counter is the regression guard for the day
// stop() stops being a no-op.
function countingStopRuntime(base: ComputeRuntime): { runtime: ComputeRuntime; stopCalls: () => number } {
  let calls = 0
  const runtime: ComputeRuntime = {
    ...base,
    async stop(name: string, opts: { timeoutSec: number }): Promise<void> {
      calls++
      await base.stop(name, opts)
    },
  }
  return { runtime, stopCalls: () => calls }
}

test('hibernator: a queue past its idle threshold is never asked to sleep', async () => {
  const clock = { nowMs: 1_000_000 }
  const activity = new ActivityTracker(() => clock.nowMs)
  const { runtime, stopCalls } = countingStopRuntime(createFakeRuntime())
  const ctx = buildContext(runtime, activity)

  const project = ctx.store.createProject({ name: 'blog', sleepAfterSeconds: 120 })
  const resource = ctx.store.createResource({
    projectId: project.id,
    kind: 'queue',
    name: 'events',
    config: sampleQueueConfig(),
  })
  ctx.store.setResourceState(resource.id, 'running')

  // Same idle setup makeIdleRunningResource uses for a postgres resource:
  // without it, idleSeconds would read null and the resource would be
  // skipped by the ordinary idle check rather than by the queue skip this
  // test exists to pin.
  activity.close(activity.open(resource.id))
  clock.nowMs += 130_000 // 130s idle, past the 120s threshold

  let guardCalls = 0
  const guard = async (): Promise<ActivityGuardResult> => {
    guardCalls++
    return 'idle'
  }

  const { sleepFor, step } = createStepController()
  const hibernator = startHibernator(ctx, { intervalMs: 1, now: () => clock.nowMs, sleepFor, checkActiveQuery: guard })
  try {
    await step()
    // The queue skip sits immediately after the `state !== 'running'` check,
    // ahead of every other candidate check including the guard: if it ever
    // stopped short-circuiting, the guard below would be reached and this
    // would fail even before the assertions on stop and state do.
    assert.equal(guardCalls, 0, 'a queue must be excluded before the pre-sleep guard is ever consulted')
    assert.equal(stopCalls(), 0, 'the runtime must never be asked to stop a queue')
    assert.equal(ctx.store.getResource(resource.id)?.state, 'running')
  } finally {
    await hibernator.stop()
  }
})

test('reconcile: a queue recorded running is left alone, it has no container to inspect', async () => {
  const ctx = buildContext()
  const project = ctx.store.createProject({ name: 'blog', sleepAfterSeconds: 300 })
  const resource = ctx.store.createResource({
    projectId: project.id,
    kind: 'queue',
    name: 'events',
    config: sampleQueueConfig(),
  })
  ctx.store.setResourceState(resource.id, 'running')

  await reconcile(ctx)

  // Without the skip, reconcile would call runtime.inspect(resource.config
  // .containerName), find nothing (a queue's containerName is unused and no
  // container was ever created under it), read that as the `missing`
  // bucket, and relabel this queue `failed`, exactly the fate the sibling
  // test in routes.test.ts confirms for a genuinely absent postgres
  // container.
  assert.equal(ctx.store.getResource(resource.id)?.state, 'running')
  ctx.store.close()
})

// A worker producer binding, not a queue itself, but the wire boundary is a
// daemon-wide concern and this file is the one that already owns the queue
// kind's cross-cutting tests. Lives here rather than in kind-dispatch.test.ts
// on purpose: that file is owned by a concurrent session and this test does
// not belong to its worker-kind-dispatch subject matter anyway.
//
// The bearer token that authenticates a container to the daemon's enqueue
// listener. resource.id is already returned unredacted on every WireResource
// (it is the resource's own identity), so a token that WAS the id would be
// published everywhere the id already is: `hobby ls --json`, Studio, CI logs,
// agent transcripts. This pins that a real, distinct queueToken never
// crosses the wire boundary as itself.
test("a worker's queue token never crosses the wire boundary", async () => {
  const ctx = buildContext()
  const project = ctx.store.createProject({ name: 'blog', sleepAfterSeconds: null })
  const resource = ctx.store.createResource({
    projectId: project.id,
    kind: 'worker',
    name: 'api',
    config: sampleWorkerConfig(),
  })

  const wire = await toWireResource(ctx, resource)
  const serialized = JSON.stringify(wire)

  assert.equal(serialized.includes('do-not-leak-this-bearer-token'), false)
  assert.equal(wire.kind === 'worker' ? wire.config.queueToken : undefined, '<redacted>')
})
