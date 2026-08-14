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
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
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
  type Resource,
  type ResourceState,
  type Store,
  expectKind,
} from '@hobby.sh/core'
import { startPostgres, stopPostgres, type ActivityGuardResult } from '@hobby.sh/pg'
import { ActivityTracker, type ConnectionHandle } from '@hobby.sh/proxy'
import { createApp, createProxyDeps, shouldSleep, startHibernator, type DaemonContext } from '../src/index.js'
import { createDefaultKindRegistry } from '../src/daemon/context.js'

function testConfig(overrides: Partial<HobbyConfig> = {}): HobbyConfig {
  return {
    image: 'postgres:18-alpine',
    proxyPort: 5432,
    studioPort: 8443,
    apiPort: 7432,
    httpPort: 7433,
    domain: 'localhost',
    sleepAfterSeconds: 300,
    // Short on purpose: real startPostgres readiness waits below run against
    // a fake runtime with nothing actually listening on the allocated port,
    // so they always run out their timeout. Short values keep those cases
    // fast rather than three-minutes-slow. Same pattern as task-4's tests.
    wakeTimeoutMs: 150,
    readinessPollMs: 20,
    caddyEnabled: false,
    caddyAdminPort: 2019,
    caddyStudioHost: null,
    ...overrides,
  }
}

function buildContext(runtime: ComputeRuntime = createFakeRuntime(), activity: ActivityTracker = new ActivityTracker()): DaemonContext {
  const store: Store = openStore(':memory:')
  const paths = resolvePaths({ HOBBY_HOME: join(tmpdir(), `hobby-hibernator-test-${randomUUID()}`) })
  return { store, runtime, paths, config: testConfig(), activity, kinds: createDefaultKindRegistry() }
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

  activity.close(activity.open(resourceId)) // idle starting at clock.nowMs (1_000_000)
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
    await hibernator.stop()
  }
})

test('tick: a pinned project (sleepAfterSeconds null) never reaches the guard and never sleeps', async () => {
  const clock = { nowMs: 1_000_000 }
  const activity = new ActivityTracker(() => clock.nowMs)
  const ctx = buildContext(createFakeRuntime(), activity)
  const { resourceId } = makeIdleRunningResource(ctx, { projectSleepAfterSeconds: null, hostPort: 25562 })

  activity.close(activity.open(resourceId))
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
    await hibernator.stop()
  }
})

test('tick: an active pg_stat_activity guard blocks sleep even past the idle threshold', async () => {
  const clock = { nowMs: 1_000_000 }
  const activity = new ActivityTracker(() => clock.nowMs)
  const ctx = buildContext(createFakeRuntime(), activity)
  const { resourceId } = makeIdleRunningResource(ctx, { projectSleepAfterSeconds: 60, hostPort: 25563 })

  activity.close(activity.open(resourceId))
  clock.nowMs += 100_000

  const guard = async (): Promise<ActivityGuardResult> => 'active'

  const { sleepFor, step } = createStepController()
  const hibernator = startHibernator(ctx, { intervalMs: 1, now: () => clock.nowMs, sleepFor, checkActiveQuery: guard })
  try {
    await step()
    assert.equal(ctx.store.getResource(resourceId)?.state, 'running', 'a direct connection or mid-transaction guard must refuse the sleep')
  } finally {
    await hibernator.stop()
  }
})

test('tick: an unreachable guard is treated as "do not sleep", not as "no activity"', async () => {
  const clock = { nowMs: 1_000_000 }
  const activity = new ActivityTracker(() => clock.nowMs)
  const ctx = buildContext(createFakeRuntime(), activity)
  const { resourceId } = makeIdleRunningResource(ctx, { projectSleepAfterSeconds: 60, hostPort: 25564 })

  activity.close(activity.open(resourceId))
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
    await hibernator.stop()
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

  activity.close(activity.open(resource.id))
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
    await hibernator.stop()
  }
})

// A guard that reports when it has actually been called, and only resolves
// once the test explicitly releases it. This is what makes it possible to
// force a deterministic interleaving (open a connection, or call stop(),
// exactly while a tick is blocked inside the guard's round trip) without
// any real timer or real network involved.
function createControllableGuard(): {
  guard: (resource: Resource) => Promise<ActivityGuardResult>
  invoked: Promise<void>
  release: (result: ActivityGuardResult) => void
} {
  let resolveInvoked: (() => void) | null = null
  let resolveGuard: ((result: ActivityGuardResult) => void) | null = null
  const invoked = new Promise<void>((resolve) => {
    resolveInvoked = resolve
  })
  const guard = (): Promise<ActivityGuardResult> => {
    resolveInvoked?.()
    return new Promise<ActivityGuardResult>((resolve) => {
      resolveGuard = resolve
    })
  }
  return {
    guard,
    invoked,
    release: (result: ActivityGuardResult): void => {
      resolveGuard?.(result)
    },
  }
}

test('tick: a connection that lands while the guard is still in flight aborts the sleep, even though the guard itself reports idle', async () => {
  const clock = { nowMs: 1_000_000 }
  const activity = new ActivityTracker(() => clock.nowMs)
  const ctx = buildContext(createFakeRuntime(), activity)
  const { resourceId } = makeIdleRunningResource(ctx, { projectSleepAfterSeconds: 60, hostPort: 25566 })

  activity.close(activity.open(resourceId))
  clock.nowMs += 100_000 // well past the 60s threshold: every cheap, pre-guard check passes

  const { guard, invoked, release } = createControllableGuard()

  const { sleepFor, step } = createStepController()
  const hibernator = startHibernator(ctx, { intervalMs: 1, now: () => clock.nowMs, sleepFor, checkActiveQuery: guard })
  let late: ConnectionHandle | null = null
  try {
    const stepPromise = step()
    await invoked // the tick has called the guard and is now blocked on it

    // A client connects through the proxy while the guard's round trip is
    // still outstanding: the exact race the fix closes. The stale
    // `connections`/`idleSeconds` captured before the guard call already
    // said zero/idle and cannot see this; a fresh connection with no query
    // yet issued also reads pg_stat_activity state 'idle', so the guard
    // itself cannot see it either.
    late = activity.open(resourceId)
    release('idle')
    await stepPromise

    assert.equal(
      ctx.store.getResource(resourceId)?.state,
      'running',
      'a connection that landed during the guard round trip must abort the sleep'
    )
    assert.equal(activity.count(resourceId), 1)
  } finally {
    if (late !== null) activity.close(late)
    await hibernator.stop()
  }
})

test('tick: a resource whose state changed away from running while the guard was in flight aborts the sleep', async () => {
  const clock = { nowMs: 1_000_000 }
  const activity = new ActivityTracker(() => clock.nowMs)
  const ctx = buildContext(createFakeRuntime(), activity)
  const { resourceId } = makeIdleRunningResource(ctx, { projectSleepAfterSeconds: 60, hostPort: 25567 })

  activity.close(activity.open(resourceId))
  clock.nowMs += 100_000

  const { guard, invoked, release } = createControllableGuard()

  const { sleepFor, step } = createStepController()
  const hibernator = startHibernator(ctx, { intervalMs: 1, now: () => clock.nowMs, sleepFor, checkActiveQuery: guard })
  try {
    const stepPromise = step()
    await invoked

    // Something else (a manual `hobby wake`, a concurrent proxy wake)
    // moves the resource out of `running` while the guard is still
    // outstanding.
    ctx.store.setResourceState(resourceId, 'starting')
    release('idle')
    await stepPromise

    assert.equal(ctx.store.getResource(resourceId)?.state, 'starting', 'the tick must not stomp a state change that happened mid-guard')
  } finally {
    await hibernator.stop()
  }
})

// ---------------------------------------------------------------------------
// Activity has one meaning, for the proxy, the control API and the
// hibernator alike. Before this, ActivityTracker.open() was called from
// exactly one place (the proxy's splice), so a resource woken by `hobby
// wake` or by Studio was never reported to the tracker at all: idleSeconds
// returned null forever, the hibernator read null as "skip," and that
// resource ran until the daemon died. The mirror of it: the idle clock was
// never cleared when a resource stopped, so a resource that had once cycled
// through the proxy could be woken and then slept again on the very next
// tick, on an idle time measured against the previous run.
// ---------------------------------------------------------------------------

test('a wake that came from the CLI or Studio, with no proxy connection at all, eventually sleeps', async () => {
  const clock = { nowMs: 1_000_000 }
  const activity = new ActivityTracker(() => clock.nowMs)
  const ctx = buildContext(createFakeRuntime(), activity)
  // A Postgres that actually answers, so startPostgres reaches `running`
  // rather than running out its readiness timeout.
  ctx.probeFactory = () => async (): Promise<boolean> => true

  const project = ctx.store.createProject({ name: 'blog', sleepAfterSeconds: 60 })
  const resource = ctx.store.createResource({
    projectId: project.id,
    kind: 'postgres',
    name: 'primary',
    config: samplePostgresConfig({ hostPort: 25569 }),
  })
  ctx.store.setResourceState(resource.id, 'sleeping')

  // The wake path `hobby wake` and Studio both use (context.ts's
  // getOrCreateWake, which POST /v1/resources/:id/start reaches through
  // startPostgres). No proxy connection is ever opened here, which is the
  // whole point: this is the case that used to run forever.
  await startPostgres(ctx, expectKind(resource, 'postgres'))
  assert.equal(ctx.store.getResource(resource.id)?.state, 'running')
  assert.equal(activity.idleSeconds(resource.id), 0, 'a wake must start the idle clock at the moment of the wake')

  const guard = async (): Promise<ActivityGuardResult> => 'idle'
  const { sleepFor, step } = createStepController()
  const hibernator = startHibernator(ctx, { intervalMs: 1, now: () => clock.nowMs, sleepFor, checkActiveQuery: guard })
  try {
    // Not yet: the resource has only been idle for 30 of its 60 seconds.
    clock.nowMs += 30_000
    await step()
    assert.equal(ctx.store.getResource(resource.id)?.state, 'running', 'must not sleep before its own threshold')

    // Past the threshold now.
    clock.nowMs += 40_000
    await step()
    assert.equal(ctx.store.getResource(resource.id)?.state, 'sleeping')
  } finally {
    await hibernator.stop()
  }
})

test('stopping a resource clears its idle clock, so the next wake is not slept on the previous run\'s idle time', async () => {
  const clock = { nowMs: 1_000_000 }
  const activity = new ActivityTracker(() => clock.nowMs)
  const ctx = buildContext(createFakeRuntime(), activity)
  ctx.probeFactory = () => async (): Promise<boolean> => true

  const project = ctx.store.createProject({ name: 'blog', sleepAfterSeconds: 60 })
  const resource = ctx.store.createResource({
    projectId: project.id,
    kind: 'postgres',
    name: 'primary',
    config: samplePostgresConfig({ hostPort: 25570 }),
  })
  ctx.store.setResourceState(resource.id, 'running')

  // A full proxy connection, opened and closed: the tracker now holds an
  // idle timestamp for this resource.
  activity.close(activity.open(resource.id))
  clock.nowMs += 10_000_000 // absurdly long ago

  await stopPostgres(ctx, expectKind(resource, 'postgres'))
  assert.equal(activity.idleSeconds(resource.id), null, 'a stopped resource has no idle clock to reason from')

  // Now something wakes it again (Studio's query route, `hobby wake`).
  const woken = ctx.store.getResource(resource.id)
  assert.ok(woken !== null)
  await startPostgres(ctx, expectKind(woken, 'postgres'))
  assert.equal(ctx.store.getResource(resource.id)?.state, 'running')

  const guard = async (): Promise<ActivityGuardResult> => 'idle'
  const { sleepFor, step } = createStepController()
  const hibernator = startHibernator(ctx, { intervalMs: 1, now: () => clock.nowMs, sleepFor, checkActiveQuery: guard })
  try {
    await step()
    assert.equal(
      ctx.store.getResource(resource.id)?.state,
      'running',
      'the very next tick must not sleep a just-woken resource on an idle time from its previous run'
    )
  } finally {
    await hibernator.stop()
  }
})

test('a query through the control API counts as activity, so the next tick does not sleep the resource', async () => {
  const clock = { nowMs: 1_000_000 }
  const activity = new ActivityTracker(() => clock.nowMs)
  const ctx = buildContext(createFakeRuntime(), activity)
  const project = ctx.store.createProject({ name: 'blog', sleepAfterSeconds: 60 })
  const resource = ctx.store.createResource({
    projectId: project.id,
    kind: 'postgres',
    name: 'primary',
    config: samplePostgresConfig({ hostPort: 25571 }),
  })
  ctx.store.setResourceState(resource.id, 'running')

  // Long idle: on the numbers alone this resource is a sleep candidate.
  activity.close(activity.open(resource.id))
  clock.nowMs += 100_000

  const server = createServer(createApp(ctx))
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const address = server.address() as AddressInfo

  const guard = async (): Promise<ActivityGuardResult> => 'idle'
  const { sleepFor, step } = createStepController()
  const hibernator = startHibernator(ctx, { intervalMs: 1, now: () => clock.nowMs, sleepFor, checkActiveQuery: guard })
  try {
    // The query itself fails: nothing is listening on the fake resource's
    // host port, and the resource is already `running` so no wake is
    // attempted. That is deliberate. A failed statement is still someone
    // using this database right now, and the marking must not depend on the
    // query succeeding, or a user's failing query would be the one thing
    // that lets the database be slept out from under them.
    const res = await fetch(`http://127.0.0.1:${address.port}/v1/resources/${resource.id}/query`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sql: 'SELECT 1' }),
    })
    await res.text()

    assert.equal(activity.idleSeconds(resource.id), 0, 'a query must reset the idle clock to this instant')

    await step()
    assert.equal(
      ctx.store.getResource(resource.id)?.state,
      'running',
      'a resource queried a moment ago must not be slept on the very next tick'
    )
  } finally {
    await hibernator.stop()
    // See routes.test.ts's withServer for why: without forcing lingering
    // keep-alive sockets closed, server.close()'s callback can wait forever
    // on a connection the client already finished with but never
    // explicitly closed, hanging this file's own test process.
    const closed = new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())))
    server.closeAllConnections()
    await closed
  }
})

test("stop() awaits an in-flight tick, so it can never run stopPostgres concurrently with the caller's own shutdown loop", async () => {
  const clock = { nowMs: 1_000_000 }
  const activity = new ActivityTracker(() => clock.nowMs)
  const ctx = buildContext(createFakeRuntime(), activity)
  const { resourceId } = makeIdleRunningResource(ctx, { projectSleepAfterSeconds: 60, hostPort: 25568 })

  activity.close(activity.open(resourceId))
  clock.nowMs += 100_000

  const { guard, invoked, release } = createControllableGuard()

  const { sleepFor, step } = createStepController()
  const hibernator = startHibernator(ctx, { intervalMs: 1, now: () => clock.nowMs, sleepFor, checkActiveQuery: guard })

  // step()'s own promise is not awaited here: it only resolves once the
  // loop comes back around and calls sleepFor() for the *next* interval,
  // but stop() (called below, mid-tick) sets the loop's stopped flag
  // immediately, so once this tick finishes the loop exits without ever
  // calling sleepFor() again. That is exactly correct hibernator behavior,
  // not a bug in it; this test's own signal for "the tick is done" is
  // stopPromise below, driven directly by stop()'s awaited currentTick,
  // not by the interval controller.
  void step()
  await invoked // the tick has already decided this resource is a sleep candidate and is blocked in the guard

  let stopResolved = false
  const stopPromise = hibernator.stop().then(() => {
    stopResolved = true
  })

  // Give the microtask queue several turns: stop() must not resolve while
  // the tick it is draining is still waiting on the guard.
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
  assert.equal(stopResolved, false, 'stop() must not resolve before the in-flight tick has drained')

  release('idle')
  await stopPromise

  assert.equal(stopResolved, true)
  assert.equal(ctx.store.getResource(resourceId)?.state, 'sleeping', 'the drained tick was still allowed to finish its own stopPostgres')
})
