// Phase A, workers (2026-11-18): redeploying a running worker fails no
// request. End to end on the daemon side: the real HTTP router
// (startHttpRouter) over the real HttpProxyDeps (createHttpProxyDeps), the
// real wake (getOrCreateWake) and its per-resource hold, the real
// deployWorker and its swap, the real queue tick, alarm mirror tick and cron
// tick. The fakes are an in-memory store and a fake runtime whose start puts
// a stand-in worker on the resource's host port, answering with the image it
// was created from, and whose stop takes it off again (so a request sent to
// a stopped container is really refused). No Docker.

import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { createServer, request as httpRequest, type Server } from 'node:http'
import type { Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { test } from 'node:test'
import {
  createFakeRuntime,
  HobbyError,
  openDatabase,
  openStore,
  resolvePaths,
  type ComputeRuntime,
  type HobbyConfig,
  type WorkerConfig,
  type WorkerResource,
} from '@hobby.sh/core'
import { tickOnce as tickAlarms } from '@hobby.sh/do'
import { ActivityTracker, startHttpRouter } from '@hobby.sh/proxy'
import {
  DEFAULT_CONSUMER_OPTIONS,
  depth,
  enqueue,
  openQueueDb,
  tickOnce as tickQueues,
  type DrainableQueue,
} from '@hobby.sh/queue'
import { createWorkerResource, deployWorker, startWorker, type WorkerDeps } from '@hobby.sh/worker'
import {
  createDefaultKindRegistry,
  createHttpProxyDeps,
  getOrCreateWake,
  isResourceWakeHeld,
  resourceWakeHoldFor,
  type DaemonContext,
} from '../src/daemon/context.js'
import { tickCrons, type CronOutcome } from '../src/daemon/crons.js'
import { queueStateOf } from '../src/daemon/queues.js'

const HOST = 'api.blog.localhost'
const WAKE_TIMEOUT_MS = 3000

function testConfig(): HobbyConfig {
  return {
    image: 'postgres:18-alpine',
    proxyPort: 5432,
    proxyHost: '127.0.0.1',
    proxyTls: null,
    studioPort: 8443,
    apiPort: 7432,
    httpPort: 7433,
    domain: 'localhost',
    sleepAfterSeconds: 300,
    wakeTimeoutMs: WAKE_TIMEOUT_MS,
    readinessPollMs: 10,
    deployDrainMs: 5000,
    queuePort: 0,
    caddyEnabled: false,
    caddyAdminPort: 2019,
    caddyStudioHost: null,
    project: null,
  }
}

interface Gate {
  reached: Promise<void>
  open: () => void
  wait: () => Promise<void>
}

function gate(): Gate {
  let reach: () => void = () => {}
  let open: () => void = () => {}
  const reached = new Promise<void>((resolve) => (reach = resolve))
  const opened = new Promise<void>((resolve) => (open = resolve))
  return {
    reached,
    open,
    wait: async () => {
      reach()
      await opened
    },
  }
}

// A runtime whose containers are real HTTP servers on their published host
// port. Every response body is the image the container was created from, so
// a test can tell the old version from the new. GET /slow waits on a gate
// before answering, to hold a request in flight on a container. An image in
// `crashing` exits right after it starts, the way a runner that throws at
// init does.
function workerRuntime(events: string[]) {
  const base = createFakeRuntime()
  const live = new Map<string, { server: Server; sockets: Set<Socket> }>()
  const served: string[] = []
  let slowGate: Gate | null = null
  let startGate: Gate | null = null
  const crashing = new Set<string>()

  const imageOf = (name: string): string => base._specs.get(name)?.image ?? '?'

  const runtime: ComputeRuntime = {
    ...base,
    async start(name) {
      const image = imageOf(name)
      await startGate?.wait()
      events.push(`start ${image}`)
      await base.start(name)
      if (crashing.has(image)) {
        await base.stop(name, { timeoutSec: 0 })
        return
      }
      const port = base._specs.get(name)?.ports[0]?.host
      assert.ok(port !== undefined)
      const sockets = new Set<Socket>()
      const server = createServer((req, res) => {
        served.push(`${image} ${req.url}`)
        const answer = (): void => {
          res.writeHead(200, { 'content-type': 'text/plain' })
          res.end(image)
          if (req.url === '/slow') events.push(`slow finished on ${image}`)
        }
        if (req.url === '/slow' && slowGate !== null) {
          void slowGate.wait().then(answer)
          return
        }
        answer()
      })
      server.on('connection', (socket) => {
        sockets.add(socket)
        socket.on('close', () => sockets.delete(socket))
      })
      await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', () => resolve()))
      live.set(name, { server, sockets })
    },
    async stop(name, opts) {
      const current = live.get(name)
      if (current !== undefined) {
        events.push(`stop ${imageOf(name)}`)
        live.delete(name)
        // A stopped container takes whatever was still open with it.
        for (const socket of current.sockets) socket.destroy()
        await new Promise<void>((resolve) => current.server.close(() => resolve()))
      }
      await base.stop(name, opts)
    },
  }
  return {
    runtime,
    served,
    crashing,
    slowGate: (g: Gate | null) => (slowGate = g),
    startGate: (g: Gate | null) => (startGate = g),
    closeAll: async () => {
      for (const [name] of live) await runtime.stop(name, { timeoutSec: 0 })
    },
  }
}

const WRANGLER = 'name = "api"\nmain = "index.ts"\ncompatibility_date = "2026-08-01"\n'

async function setup() {
  const events: string[] = []
  const rt = workerRuntime(events)
  let clock = 1_754_870_400_000
  const ctx = {
    store: openStore(':memory:'),
    runtime: rt.runtime,
    paths: resolvePaths({ HOBBY_HOME: join(tmpdir(), `hobby-worker-swap-${randomUUID()}`) }),
    config: testConfig(),
    activity: new ActivityTracker(),
    kinds: createDefaultKindRegistry(),
    // A container is ready once its stand-in is listening; one that crashed
    // never is.
    workerProbeFactory: (config: WorkerConfig) => async () => !rt.crashing.has(config.image ?? ''),
    // Each deploy gets its own image tag.
    now: () => (clock += 1000),
  } as DaemonContext & WorkerDeps
  ctx.holdResourceWakes = resourceWakeHoldFor(ctx)

  const project = ctx.store.createProject({ name: 'blog', sleepAfterSeconds: 300 })
  const source = mkdtempSync(join(tmpdir(), 'hobby-worker-swap-src-'))
  writeFileSync(join(source, 'wrangler.toml'), WRANGLER)
  writeFileSync(join(source, 'index.ts'), 'export default { fetch: () => new Response("ok") }\n')
  const created = await createWorkerResource(ctx, { project, name: 'api', sourcePath: source, databaseResourceId: null })
  await startWorker(ctx, created.resource)
  const running = read(ctx, created.resource.id)
  assert.equal(running.state, 'running')
  events.length = 0

  const router = await startHttpRouter(createHttpProxyDeps(ctx), { port: 0, wakeTimeoutMs: WAKE_TIMEOUT_MS })
  return {
    ctx,
    rt,
    events,
    worker: running,
    router,
    close: async () => {
      await router.close()
      await rt.closeAll()
    },
  }
}

function read(ctx: DaemonContext, id: string): WorkerResource {
  const resource = ctx.store.getResource(id)
  assert.ok(resource !== null && resource.kind === 'worker')
  return resource
}

function get(port: number, path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path, method: 'GET', headers: { host: HOST } }, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (chunk: string) => (body += chunk))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }))
      res.on('error', reject)
    })
    req.on('error', reject)
    req.end()
  })
}

async function until(check: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 3000
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await delay(5)
  }
}

test('a running worker redeploy holds new requests, drains the in-flight one, swaps, then serves the held ones from the new version', async () => {
  const s = await setup()
  try {
    const oldImage = s.worker.config.image
    const slow = gate()
    s.rt.slowGate(slow)

    const inFlight = get(s.router.port, '/slow')
    await slow.reached

    const deploying = deployWorker(s.ctx, s.worker)
    await until(() => read(s.ctx, s.worker.id).state === 'starting', 'the swap to hold requests')

    const held = Array.from({ length: 5 }, () => get(s.router.port, '/'))
    await delay(50)
    // Held, not sent: nothing new reached the old container while it drains.
    assert.deepEqual(s.rt.served, [`${oldImage} /slow`])
    assert.ok(!s.events.some((e) => e.startsWith('stop')), 'the old container is not stopped while a request is in flight')

    slow.open()
    const finished = await inFlight
    assert.deepEqual(finished, { status: 200, body: oldImage })

    const result = await deploying
    const newImage = result.image
    assert.notEqual(newImage, oldImage)
    for (const response of await Promise.all(held)) {
      assert.deepEqual(response, { status: 200, body: newImage })
    }

    assert.deepEqual(s.events, [`slow finished on ${oldImage}`, `stop ${oldImage}`, `start ${newImage}`])
    assert.deepEqual(s.rt.served.slice(1), Array.from({ length: 5 }, () => `${newImage} /`))
    const after = read(s.ctx, s.worker.id)
    assert.equal(after.state, 'running')
    assert.equal(after.config.image, newImage)
    assert.equal(isResourceWakeHeld(s.ctx, s.worker.id), false)
  } finally {
    await s.close()
  }
})

test('requests sent continuously through a running worker redeploy all succeed', async () => {
  const s = await setup()
  try {
    let stop = false
    const results: Array<{ status: number; body: string }> = []
    const failures: unknown[] = []
    const client = (async () => {
      while (!stop) {
        try {
          results.push(await get(s.router.port, '/'))
        } catch (err) {
          failures.push(err)
        }
      }
    })()
    await until(() => results.length >= 3, 'traffic to start')
    const result = await deployWorker(s.ctx, s.worker)
    const before = results.length
    await until(() => results.length >= before + 3, 'traffic after the swap')
    stop = true
    await client

    assert.deepEqual(failures, [])
    assert.ok(results.every((r) => r.status === 200), JSON.stringify(results.filter((r) => r.status !== 200)))
    assert.equal(results.at(-1)?.body, result.image)
  } finally {
    await s.close()
  }
})

test('a new version that fails readiness puts the old one back, and held requests are served by it', async () => {
  const s = await setup()
  try {
    const oldImage = s.worker.config.image
    assert.ok(oldImage !== null)
    // The next tag the deploy will build is the one that crashes on boot.
    const start = gate()
    s.rt.startGate(start)
    const deploying = deployWorker(s.ctx, s.worker)
    await until(() => read(s.ctx, s.worker.id).state === 'starting', 'the swap to hold requests')
    const held = Array.from({ length: 3 }, () => get(s.router.port, '/'))
    await start.reached
    const newImage = read(s.ctx, s.worker.id).config.image
    assert.ok(newImage !== null && newImage !== oldImage)
    s.rt.crashing.add(newImage)
    s.rt.startGate(null)
    start.open()

    await assert.rejects(deploying, (err: unknown) => {
      assert.ok(err instanceof HobbyError)
      assert.equal(err.code, 'wake_failed')
      assert.match(err.hint ?? '', new RegExp(`nothing was changed: api was started again from its previous image ${oldImage}`))
      return true
    })
    for (const response of await Promise.all(held)) {
      assert.deepEqual(response, { status: 200, body: oldImage })
    }
    assert.deepEqual(s.events, [`stop ${oldImage}`, `start ${newImage}`, `start ${oldImage}`])
    const after = read(s.ctx, s.worker.id)
    assert.equal(after.state, 'running')
    assert.equal(after.config.image, oldImage)
    assert.equal(isResourceWakeHeld(s.ctx, s.worker.id), false)
  } finally {
    await s.close()
  }
})

test('if the old version cannot be started again either, held requests are told why instead of starting it themselves', async () => {
  const s = await setup()
  try {
    const oldImage = s.worker.config.image
    assert.ok(oldImage !== null)
    const start = gate()
    s.rt.startGate(start)
    const deploying = deployWorker(s.ctx, s.worker)
    await until(() => read(s.ctx, s.worker.id).state === 'starting', 'the swap to hold requests')
    const held = get(s.router.port, '/')
    await start.reached
    s.rt.crashing.add(read(s.ctx, s.worker.id).config.image ?? '')
    s.rt.crashing.add(oldImage)
    s.rt.startGate(null)
    start.open()

    await assert.rejects(deploying, (err: unknown) => {
      assert.ok(err instanceof HobbyError)
      assert.match(err.hint ?? '', /could not be started again either/)
      return true
    })
    const response = await held
    assert.equal(response.status, 504)
    assert.match(response.body, /restarted by a redeploy, and did not come back/)
    // Two starts by the deploy (new, then old), none by the held request.
    assert.equal(s.events.filter((e) => e.startsWith('start')).length, 2)
    assert.equal(read(s.ctx, s.worker.id).state, 'failed')
  } finally {
    await s.close()
  }
})

test('a queue batch, an alarm and a cron firing that come due mid-swap are delivered once the new version is up', async () => {
  const s = await setup()
  try {
    const wake = getOrCreateWake(s.ctx)
    const workerId = s.worker.id

    // A queue this worker consumes, with one message ready.
    const dbPath = join(mkdtempSync(join(tmpdir(), 'hobby-worker-swap-q-')), 'q.sqlite')
    const db = openQueueDb(dbPath)
    enqueue(db, [{ body: '"job"', contentType: 'json' }], Date.now())
    const queue: DrainableQueue = {
      resourceId: 'queue-1',
      consumerResourceId: workerId,
      queueName: 'jobs',
      dbPath,
      deadLetterDbPath: null,
      options: { ...DEFAULT_CONSUMER_OPTIONS, maxBatchSize: 1 },
      retentionSeconds: 345600,
    }
    const delivered: string[] = []
    const queueOpts = {
      wake,
      stateOf: queueStateOf(s.ctx),
      deliver: async () => {
        delivered.push(read(s.ctx, workerId).state)
        return { outcome: 'ok' as const, retryBatch: { retry: false }, retryMessages: [] }
      },
    }

    // A Durable Object namespace whose alarm is already overdue.
    const namespaceDir = mkdtempSync(join(tmpdir(), 'hobby-worker-swap-do-'))
    const alarmDb = openDatabase(join(namespaceDir, 'metadata.sqlite'))
    alarmDb.exec('CREATE TABLE _cf_ALARM (actor_id TEXT PRIMARY KEY, scheduled_time INTEGER, actor_name TEXT) WITHOUT ROWID')
    alarmDb.exec(`INSERT INTO _cf_ALARM VALUES ('${'a'.repeat(64)}', ${Date.now() - 1000}000000, NULL)`)
    alarmDb.close()

    // A cron that is due.
    const fired: Array<{ state: string; scheduledTimeMs: number }> = []
    const cronState = { startedAtMs: Date.now() - 120_000, lastFiredAtMs: new Map<string, number>(), lastOutcome: new Map<string, CronOutcome>() }
    const cronOpts = {
      workers: () => [{ resourceId: workerId, projectName: 'blog', name: 'api', controlPort: 1, crons: ['* * * * *'] }],
      wake,
      stateOf: queueStateOf(s.ctx),
      isHeld: (id: string) => isResourceWakeHeld(s.ctx, id),
      fire: async (firing: { scheduledTimeMs: number }) => {
        fired.push({ state: read(s.ctx, workerId).state, scheduledTimeMs: firing.scheduledTimeMs })
        return { outcome: 'ok' as const }
      },
      state: cronState,
    }

    const start = gate()
    s.rt.startGate(start)
    const deploying = deployWorker(s.ctx, s.worker)
    await start.reached

    // Mid-swap: the old container is stopped and the new one is not up.
    await tickQueues([queue], queueOpts)
    assert.deepEqual(delivered, [], 'no batch is posted to a worker mid-swap')
    assert.equal(depth(db), 1, 'and the message is still queued')

    await tickCrons(cronOpts)
    assert.deepEqual(fired, [], 'no cron fires into a worker mid-swap')
    assert.equal(cronState.lastOutcome.size, 0, 'and the firing is not recorded as missed')

    let alarmWoke = false
    const alarmTick = tickAlarms([{ resourceId: workerId, namespaceDir }], Date.now, wake).then(() => {
      alarmWoke = true
    })
    await delay(50)
    assert.equal(alarmWoke, false, 'the alarm wake waits on the swap rather than starting a container')

    s.rt.startGate(null)
    start.open()
    const result = await deploying
    await alarmTick
    assert.equal(alarmWoke, true)
    // One start of the new version, by the deploy; the alarm wake started nothing.
    assert.deepEqual(s.events.filter((e) => e.startsWith('start')), [`start ${result.image}`])
    assert.equal(read(s.ctx, workerId).state, 'running')

    await tickQueues([queue], queueOpts)
    assert.deepEqual(delivered, ['running'])
    assert.equal(depth(db), 0)

    await tickCrons(cronOpts)
    const firing = fired.at(0) as { state: string; scheduledTimeMs: number } | undefined
    assert.equal(fired.length, 1)
    assert.equal(firing?.state, 'running')
    assert.ok(firing !== undefined && firing.scheduledTimeMs <= Date.now())
    db.close()
  } finally {
    await s.close()
  }
})
