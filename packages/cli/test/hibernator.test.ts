// shouldSleep's truth table is pure, so it runs for real with zero timers,
// zero Postgres and zero Docker (same precedent as routes.test.ts). The
// wake-dedup and resolve tests below build a DaemonContext from a fake
// runtime and an in-memory store, exactly like routes.test.ts, and the two
// tests that exercise startPostgres's real readiness wait use the same
// short wakeTimeoutMs/readinessPollMs pattern task-4-report.md establishes,
// so they stay fast and deterministic against nothing actually listening.
//
// The tick-loop integration tests (idle resource sleeps, pinned resource
// never even reaches the guard, an active guard blocks sleep) use a hand
// rolled single-step controller around the injected `sleepFor` seam, so
// each test drives exactly one tick and awaits its completion with no real
// timer and no real Postgres in sight, per the brief's "testable with a
// fake clock and no real time passes in tests" requirement.

import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  createFakeRuntime,
  openStore,
  resolvePaths,
  type ComputeRuntime,
  type HobbyConfig,
  type PostgresConfig,
  type ResourceState,
  type Store,
} from '@hobby.sh/core'
import type { ActivityGuardResult } from '@hobby.sh/pg'
import { ActivityTracker } from '@hobby.sh/proxy'
import { createProxyDeps, shouldSleep, startHibernator, type DaemonContext } from '../src/index.js'

function testConfig(overrides: Partial<HobbyConfig> = {}): HobbyConfig {
  return {
    image: 'postgres:18-alpine',
    proxyPort: 5432,
    studioPort: 8443,
    apiPort: 7432,
    sleepAfterSeconds: 300,
    // Short on purpose: real startPostgres readiness waits below run against
    // a fake runtime with nothing actually listening on the allocated port,
    // so they always run out their timeout. Short values keep those cases
    // fast rather than three-minutes-slow. Same pattern as task-4's tests.
    wakeTimeoutMs: 150,
    readinessPollMs: 20,
    ...overrides,
  }
}

function buildContext(runtime: ComputeRuntime = createFakeRuntime(), activity: ActivityTracker = new ActivityTracker()): DaemonContext {
  const store: Store = openStore(':memory:')
  const paths = resolvePaths({ HOBBY_HOME: join(tmpdir(), `hobby-hibernator-test-${randomUUID()}`) })
  return { store, runtime, paths, config: testConfig(), activity }
}

function samplePostgresConfig(overrides: Partial<PostgresConfig> = {}): PostgresConfig {
  return {
    image: 'postgres:18-alpine',
    containerName: `hobby-blog-primary-${randomUUID()}`,
    dataDir: '/home/user/.hobby/projects/blog/primary/pgdata',
    hostPort: 25557,
    superuser: 'postgres',
    password: 'secret',
    database: 'blog',
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// shouldSleep: the full truth table. Every dimension is flipped away from a
// baseline that is true, one at a time, to prove each one is independently
// load-bearing; the state dimension is swept across every ResourceState.
// ---------------------------------------------------------------------------

const RESOURCE_STATES: ResourceState[] = ['creating', 'running', 'starting', 'sleeping', 'stopping', 'failed', 'destroying']

test('shouldSleep: true only when running, zero connections, idle at/above threshold, threshold set, no active query', () => {
  const trueCase = {
    state: 'running' as ResourceState,
    connections: 0,
    idleSeconds: 300,
    sleepAfterSeconds: 300,
    hasActiveQuery: false,
  }
  assert.equal(shouldSleep(trueCase), true, 'baseline: at the threshold exactly should sleep')
  assert.equal(shouldSleep({ ...trueCase, idleSeconds: 301 }), true, 'above the threshold should still sleep')
})

test('shouldSleep: false for every ResourceState except running', () => {
  for (const state of RESOURCE_STATES) {
    const result = shouldSleep({ state, connections: 0, idleSeconds: 300, sleepAfterSeconds: 300, hasActiveQuery: false })
    assert.equal(result, state === 'running', `state ${state} should ${state === 'running' ? '' : 'not '}sleep`)
  }
})

test('shouldSleep: false when connections is anything other than zero', () => {
  for (const connections of [1, 2, 100]) {
    assert.equal(
      shouldSleep({ state: 'running', connections, idleSeconds: 300, sleepAfterSeconds: 300, hasActiveQuery: false }),
      false
    )
  }
})

test('shouldSleep: false when idleSeconds is null (never idle, or currently connected)', () => {
  assert.equal(shouldSleep({ state: 'running', connections: 0, idleSeconds: null, sleepAfterSeconds: 300, hasActiveQuery: false }), false)
})

test('shouldSleep: false when idleSeconds is below the threshold', () => {
  assert.equal(shouldSleep({ state: 'running', connections: 0, idleSeconds: 299, sleepAfterSeconds: 300, hasActiveQuery: false }), false)
})

test('shouldSleep: a pinned resource (sleepAfterSeconds null) never sleeps, regardless of every other input', () => {
  assert.equal(
    shouldSleep({ state: 'running', connections: 0, idleSeconds: 1_000_000, sleepAfterSeconds: null, hasActiveQuery: false }),
    false
  )
  // Even the otherwise-worst combination (long idle, no active query) stays pinned.
  assert.equal(shouldSleep({ state: 'running', connections: 0, idleSeconds: null, sleepAfterSeconds: null, hasActiveQuery: true }), false)
})

test('shouldSleep: false when the pg_stat_activity guard found an active query or transaction', () => {
  assert.equal(shouldSleep({ state: 'running', connections: 0, idleSeconds: 300, sleepAfterSeconds: 300, hasActiveQuery: true }), false)
})

// ---------------------------------------------------------------------------
// wake: concurrent de-duplication and map-clearing on failure.
// ---------------------------------------------------------------------------

function countingRuntime(base: ComputeRuntime): { runtime: ComputeRuntime; startCalls: () => number } {
  let calls = 0
  const runtime: ComputeRuntime = {
    ...base,
    async start(name: string): Promise<void> {
      calls++
      await base.start(name)
    },
  }
  return { runtime, startCalls: () => calls }
}

test('wake: ten concurrent callers for the same sleeping resource produce exactly one startPostgres call', async () => {
  const { runtime, startCalls } = countingRuntime(createFakeRuntime())
  const ctx = buildContext(runtime)
  const project = ctx.store.createProject({ name: 'blog', sleepAfterSeconds: 300 })
  const resource = ctx.store.createResource({ projectId: project.id, kind: 'postgres', name: 'primary', config: samplePostgresConfig() })
  ctx.store.setResourceState(resource.id, 'sleeping')

  const deps = createProxyDeps(ctx)

  const attempts = Array.from({ length: 10 }, () => deps.wake(resource.id))
  const results = await Promise.allSettled(attempts)

  // Nothing is really listening on the fake resource's host port, so every
  // attempt rejects with the same wake_timeout failure (startPostgres's own
  // real readiness wait, run out against testConfig's short wakeTimeoutMs).
  // That is expected and is not what this test is checking; the dedup
  // property is checked next regardless of outcome.
  for (const result of results) {
    assert.equal(result.status, 'rejected')
  }

  assert.equal(startCalls(), 1, 'ten concurrent wake() calls for the same resource must start the container exactly once')
})

test('wake: the in-flight map entry is cleared after a failed wake, so a later call tries again', async () => {
  const { runtime, startCalls } = countingRuntime(createFakeRuntime())
  const ctx = buildContext(runtime)
  const project = ctx.store.createProject({ name: 'blog', sleepAfterSeconds: 300 })
  const resource = ctx.store.createResource({ projectId: project.id, kind: 'postgres', name: 'primary', config: samplePostgresConfig() })
  ctx.store.setResourceState(resource.id, 'sleeping')

  const deps = createProxyDeps(ctx)

  await assert.rejects(deps.wake(resource.id))
  assert.equal(startCalls(), 1)

  // If the map entry were not cleared on failure, this second, fully
  // sequential call would resolve (or reject) the exact same stale promise
  // rather than trying again, and startCalls would stay at 1.
  await assert.rejects(deps.wake(resource.id))
  assert.equal(startCalls(), 2, 'a wake after a prior failure must attempt startPostgres again, not reuse the failed promise')
})

test('wake: an unknown resourceId rejects with resource_not_found and never touches the runtime', async () => {
  const { runtime, startCalls } = countingRuntime(createFakeRuntime())
  const ctx = buildContext(runtime)
  const deps = createProxyDeps(ctx)

  await assert.rejects(deps.wake('does-not-exist'), (err: unknown) => {
    assert.equal((err as { code?: string }).code, 'resource_not_found')
    return true
  })
  assert.equal(startCalls(), 0)
})

// ---------------------------------------------------------------------------
// resolve: project/resource lookup and the database field's contract.
// ---------------------------------------------------------------------------

test('resolve: unknown project resolves to null', async () => {
  const ctx = buildContext()
  const deps = createProxyDeps(ctx)
  assert.equal(await deps.resolve('does-not-exist'), null)
})

test('resolve: a project with no resources resolves to null', async () => {
  const ctx = buildContext()
  ctx.store.createProject({ name: 'blog', sleepAfterSeconds: 300 })
  const deps = createProxyDeps(ctx)
  assert.equal(await deps.resolve('blog'), null)
})

test('resolve: a project with exactly one resource returns its host, port, state and database', async () => {
  const ctx = buildContext()
  const project = ctx.store.createProject({ name: 'blog', sleepAfterSeconds: 300 })
  const config = samplePostgresConfig({ database: 'blog', hostPort: 25558 })
  const resource = ctx.store.createResource({ projectId: project.id, kind: 'postgres', name: 'primary', config })
  ctx.store.setResourceState(resource.id, 'running')

  const deps = createProxyDeps(ctx)
  const target = await deps.resolve('blog')

  assert.deepEqual(target, {
    resourceId: resource.id,
    host: '127.0.0.1',
    port: 25558,
    state: 'running',
    database: 'blog',
  })
})

test('resolve: a project with more than one resource throws ambiguous_target rather than guessing', async () => {
  const ctx = buildContext()
  const project = ctx.store.createProject({ name: 'blog', sleepAfterSeconds: 300 })
  ctx.store.createResource({ projectId: project.id, kind: 'postgres', name: 'primary', config: samplePostgresConfig({ hostPort: 25559 }) })
  ctx.store.createResource({ projectId: project.id, kind: 'postgres', name: 'analytics', config: samplePostgresConfig({ hostPort: 25560 }) })

  const deps = createProxyDeps(ctx)
  await assert.rejects(deps.resolve('blog'), (err: unknown) => {
    assert.equal((err as { code?: string }).code, 'ambiguous_target')
    return true
  })
})

// ---------------------------------------------------------------------------
// The tick loop: real DaemonContext wiring, fake Postgres guard, a single
// step controller so each test drives exactly one tick deterministically.
// ---------------------------------------------------------------------------

// Drives startHibernator's loop one tick at a time. sleepFor() (installed as
// the hibernator's own injected seam) blocks until step() releases it, and
// step()'s returned promise only resolves once the loop has come back
// around to block on the *next* interval, which is exactly the signal that
// the tick triggered by this step() has fully finished (including its
// `await`ed pg_stat_activity guard and any stopPostgres call). No real
// timer is ever created.
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

function makeIdleRunningResource(ctx: DaemonContext, opts: { projectSleepAfterSeconds: number | null; hostPort: number }): {
  resourceId: string
} {
  const project = ctx.store.createProject({ name: 'blog', sleepAfterSeconds: opts.projectSleepAfterSeconds })
  const resource = ctx.store.createResource({
    projectId: project.id,
    kind: 'postgres',
    name: 'primary',
    config: samplePostgresConfig({ hostPort: opts.hostPort }),
  })
  ctx.store.setResourceState(resource.id, 'running')
  return { resourceId: resource.id }
}

test('tick: an idle running resource past its threshold, with an idle guard, gets stopped', async () => {
  const clock = { nowMs: 1_000_000 }
  const activity = new ActivityTracker(() => clock.nowMs)
  const ctx = buildContext(createFakeRuntime(), activity)
  const { resourceId } = makeIdleRunningResource(ctx, { projectSleepAfterSeconds: 120, hostPort: 25561 })

  activity.open(resourceId)
  activity.close(resourceId) // idle starting at clock.nowMs (1_000_000)
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
    assert.equal(guardCalls, 1, 'the guard must be consulted exactly once for a real sleep candidate')
    assert.equal(ctx.store.getResource(resourceId)?.state, 'sleeping')
  } finally {
    hibernator.stop()
  }
})

test('tick: a pinned project (sleepAfterSeconds null) never reaches the guard and never sleeps', async () => {
  const clock = { nowMs: 1_000_000 }
  const activity = new ActivityTracker(() => clock.nowMs)
  const ctx = buildContext(createFakeRuntime(), activity)
  const { resourceId } = makeIdleRunningResource(ctx, { projectSleepAfterSeconds: null, hostPort: 25562 })

  activity.open(resourceId)
  activity.close(resourceId)
  clock.nowMs += 10_000_000 // absurdly idle; must not matter for a pinned project

  let guardCalls = 0
  const guard = async (): Promise<ActivityGuardResult> => {
    guardCalls++
    return 'idle'
  }

  const { sleepFor, step } = createStepController()
  const hibernator = startHibernator(ctx, { intervalMs: 1, now: () => clock.nowMs, sleepFor, checkActiveQuery: guard })
  try {
    await step()
    assert.equal(guardCalls, 0, 'a pinned resource must be rejected before the expensive guard ever runs')
    assert.equal(ctx.store.getResource(resourceId)?.state, 'running')
  } finally {
    hibernator.stop()
  }
})

test('tick: an active pg_stat_activity guard blocks sleep even past the idle threshold', async () => {
  const clock = { nowMs: 1_000_000 }
  const activity = new ActivityTracker(() => clock.nowMs)
  const ctx = buildContext(createFakeRuntime(), activity)
  const { resourceId } = makeIdleRunningResource(ctx, { projectSleepAfterSeconds: 60, hostPort: 25563 })

  activity.open(resourceId)
  activity.close(resourceId)
  clock.nowMs += 100_000

  const guard = async (): Promise<ActivityGuardResult> => 'active'

  const { sleepFor, step } = createStepController()
  const hibernator = startHibernator(ctx, { intervalMs: 1, now: () => clock.nowMs, sleepFor, checkActiveQuery: guard })
  try {
    await step()
    assert.equal(ctx.store.getResource(resourceId)?.state, 'running', 'a direct connection or mid-transaction guard must refuse the sleep')
  } finally {
    hibernator.stop()
  }
})

test('tick: an unreachable guard is treated as "do not sleep", not as "no activity"', async () => {
  const clock = { nowMs: 1_000_000 }
  const activity = new ActivityTracker(() => clock.nowMs)
  const ctx = buildContext(createFakeRuntime(), activity)
  const { resourceId } = makeIdleRunningResource(ctx, { projectSleepAfterSeconds: 60, hostPort: 25564 })

  activity.open(resourceId)
  activity.close(resourceId)
  clock.nowMs += 100_000

  const guard = async (): Promise<ActivityGuardResult> => 'unreachable'

  const { sleepFor, step } = createStepController()
  const hibernator = startHibernator(ctx, { intervalMs: 1, now: () => clock.nowMs, sleepFor, checkActiveQuery: guard })
  try {
    await step()
    assert.equal(
      ctx.store.getResource(resourceId)?.state,
      'running',
      'a resource whose readiness could not be confirmed must not be read as idle'
    )
  } finally {
    hibernator.stop()
  }
})

test('tick: a resource that is not running is skipped entirely, guard never called', async () => {
  const clock = { nowMs: 1_000_000 }
  const activity = new ActivityTracker(() => clock.nowMs)
  const ctx = buildContext(createFakeRuntime(), activity)
  const project = ctx.store.createProject({ name: 'blog', sleepAfterSeconds: 60 })
  const resource = ctx.store.createResource({
    projectId: project.id,
    kind: 'postgres',
    name: 'primary',
    config: samplePostgresConfig({ hostPort: 25565 }),
  })
  ctx.store.setResourceState(resource.id, 'starting')

  activity.open(resource.id)
  activity.close(resource.id)
  clock.nowMs += 100_000

  let guardCalls = 0
  const guard = async (): Promise<ActivityGuardResult> => {
    guardCalls++
    return 'idle'
  }

  const { sleepFor, step } = createStepController()
  const hibernator = startHibernator(ctx, { intervalMs: 1, now: () => clock.nowMs, sleepFor, checkActiveQuery: guard })
  try {
    await step()
    assert.equal(guardCalls, 0)
    assert.equal(ctx.store.getResource(resource.id)?.state, 'starting')
  } finally {
    hibernator.stop()
  }
})
