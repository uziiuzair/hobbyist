import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { Client } from 'pg'
import { Timeline } from './timeline.ts'
import { summarise, type Summary } from './stats.ts'
import { startProxy } from './proxy.ts'
import { stopClean, killHard, create, removeIfExists } from './runtime.ts'
import { sleep, type Fixture } from './fixture.ts'

const run = promisify(execFile)

export const SEGMENTS = [
  ['accept', 'parsed'],
  ['parsed', 'wake_issued'],
  ['wake_issued', 'container_up'],
  ['container_up', 'pg_ready'],
  ['pg_ready', 'upstream_connected'],
] as const

const NAMES = ['accept_parse', 'wake_issue', 'container_up', 'pg_ready', 'connect_splice'] as const

export function segmentsOf(t: Timeline): Record<string, number> {
  const out: Record<string, number> = {}
  SEGMENTS.forEach(([from, to], i) => {
    out[NAMES[i]!] = t.segmentMs(from, to)
  })
  out.total = t.segmentMs('accept', 'upstream_connected')
  return out
}

export type ResetMode = 'stop' | 'kill' | 'recreate'

export type CellOpts = {
  label: string
  fixture: Fixture
  listenPort: number
  pollMs: number
  iterations: number
  reset: ResetMode
  dropCaches: boolean
}

export type CellResult = {
  label: string
  iterations: number
  segments: Record<string, Summary>
  total: Summary
  failures: number
}

export async function runCell(opts: CellOpts): Promise<CellResult> {
  const collected: Record<string, number>[] = []
  let failures = 0

  for (let i = 0; i < opts.iterations; i++) {
    await resetInstance(opts)
    if (opts.dropCaches) await dropPageCache()
    await sleep(500)

    let timeline: Timeline | null = null
    const proxy = await startProxy({
      listenPort: opts.listenPort,
      fixture: opts.fixture,
      pollMs: opts.pollMs,
      wakeTimeoutMs: 30_000,
      onTimeline: (t) => {
        timeline = t
      },
    })

    try {
      const client = new Client({
        host: '127.0.0.1',
        port: opts.listenPort,
        user: opts.fixture.user,
        password: opts.fixture.password,
        database: opts.fixture.database,
      })
      await client.connect()
      await client.query('SELECT 1')
      await client.end()
      if (timeline) collected.push(segmentsOf(timeline))
      else failures++
    } catch {
      failures++
    } finally {
      await proxy.close()
    }
  }

  const segments: Record<string, Summary> = {}
  for (const name of NAMES) {
    segments[name] = summarise(collected.map((c) => c[name]!))
  }

  return {
    label: opts.label,
    iterations: opts.iterations,
    segments,
    total: summarise(collected.map((c) => c.total!)),
    failures,
  }
}

async function resetInstance(opts: CellOpts): Promise<void> {
  const f = opts.fixture
  if (opts.reset === 'kill') {
    await killHard(f.name).catch(() => {})
    return
  }

  await stopClean(f.name).catch(() => {})

  if (opts.reset === 'recreate') {
    // Lever 1's comparison. The container object is thrown away and rebuilt,
    // while the data directory survives because it is bind mounted from the
    // host. Without that bind mount this would be measuring initdb instead.
    await removeIfExists(f.name)
    await create({
      name: f.name,
      image: f.image,
      hostPort: f.hostPort,
      password: f.password,
      dataDir: f.dataDir,
    })
  }
}

// Linux only. On macOS `purge` needs sudo and behaves differently, so a macOS
// cold-cache run is reported as "not dropped" rather than faked.
async function dropPageCache(): Promise<void> {
  if (process.platform !== 'linux') return
  try {
    await run('sudo', ['sh', '-c', 'sync; echo 3 > /proc/sys/vm/drop_caches'])
  } catch {
    // no sudo available, and the results doc must say so
  }
}
