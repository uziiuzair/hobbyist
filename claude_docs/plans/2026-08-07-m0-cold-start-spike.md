# M0 Cold Start Spike Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Measure, honestly and per segment, how long it takes to serve a Postgres connection to an instance that was stopped, then answer the go/no-go gate in `docs/proxy/specs/2026-08-07-m0-cold-start-spike.md`.

**Architecture:** A throwaway TypeScript harness in `spike/m0/`. A minimal TCP proxy parses the Postgres startup packet, starts a stopped container, polls until Postgres accepts connections, then splices the sockets. A timeline records marks at each boundary, a runner sweeps a scenario matrix, and a reporter emits markdown. The spike is committed so the measurements are reproducible from history, then deleted in the final task.

**Tech Stack:** TypeScript. Bun and Node, both measured. Docker CLI via `node:child_process`. `node:net` for sockets. `pg` as the client, because the honest question is what a real client experiences. `bun test` for the test suite.

## Global Constraints

- **No em-dashes anywhere.** Docs, code comments, commit messages, output. Use commas, colons, parentheses, or restructure. From the root `CLAUDE.md`.
- **Source files import only from `node:*`.** No `Bun.*` APIs in `spike/m0/src/`. The whole point is running identical source on both runtimes. Test files may use `bun:test`. From ADR 0006.
- **Default Postgres configuration throughout.** Do not tune `fsync`, `shared_buffers` or anything else. Tuning to win the benchmark produces a number we cannot ship behind.
- **50 iterations per matrix cell.** Report p50, p95 and max.
- **Every result states its hardware:** CPU, RAM, disk type, filesystem, OS version, Postgres image tag. A benchmark without hardware is a rumour.
- **Target: under 1 second. Hard ceiling: 3 seconds.** Measured p95 on the five dollar VPS with a cold page cache.
- **The spike is deleted in Task 9.** Nothing in M1 may import from `spike/`.

---

### Task 1: Scaffold and the timing primitives

**Files:**
- Create: `spike/m0/package.json`
- Create: `spike/m0/tsconfig.json`
- Create: `spike/m0/src/timeline.ts`
- Create: `spike/m0/src/stats.ts`
- Test: `spike/m0/test/timeline.test.ts`
- Test: `spike/m0/test/stats.test.ts`
- Modify: `.gitignore`

**Interfaces:**
- Consumes: nothing
- Produces: `Timeline` class with `mark(name: string): void` and `segmentMs(from: string, to: string): number`, constructed as `new Timeline(now?: () => bigint)`. `percentile(sorted: number[], p: number): number` and `summarise(samples: number[]): Summary` where `Summary = { n: number; p50: number; p95: number; max: number }`.

- [ ] **Step 1: Create the scaffold**

`spike/m0/package.json`:

```json
{
  "name": "m0-spike",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "bun test"
  },
  "dependencies": {
    "pg": "^8.13.0"
  },
  "devDependencies": {
    "@types/node": "^22.0.0",
    "@types/pg": "^8.11.0",
    "typescript": "^5.6.0"
  }
}
```

`spike/m0/tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "types": ["node"],
    "skipLibCheck": true,
    "noEmit": true
  },
  "include": ["src", "test"]
}
```

Append to `.gitignore`:

```
node_modules
```

Then run `cd spike/m0 && bun install`.

- [ ] **Step 2: Write the failing tests**

`spike/m0/test/stats.test.ts`:

```ts
import { test, expect } from 'bun:test'
import { percentile, summarise } from '../src/stats'

test('percentile returns the exact value at a whole rank', () => {
  expect(percentile([1, 2, 3, 4, 5], 50)).toBe(3)
})

test('percentile interpolates between ranks', () => {
  expect(percentile([0, 10], 50)).toBe(5)
})

test('percentile 0 is the minimum and 100 is the maximum', () => {
  expect(percentile([4, 8, 15, 16, 23, 42], 0)).toBe(4)
  expect(percentile([4, 8, 15, 16, 23, 42], 100)).toBe(42)
})

test('percentile of a single sample is that sample', () => {
  expect(percentile([7], 95)).toBe(7)
})

test('percentile of an empty sample throws rather than returning NaN', () => {
  expect(() => percentile([], 50)).toThrow('empty sample')
})

test('summarise sorts before computing, so caller order does not matter', () => {
  const s = summarise([300, 100, 200])
  expect(s.n).toBe(3)
  expect(s.p50).toBe(200)
  expect(s.max).toBe(300)
})
```

`spike/m0/test/timeline.test.ts`:

```ts
import { test, expect } from 'bun:test'
import { Timeline } from '../src/timeline'

function fakeClock(values: bigint[]): () => bigint {
  let i = 0
  return () => values[i++]!
}

test('segmentMs converts nanosecond marks to milliseconds', () => {
  const t = new Timeline(fakeClock([0n, 1_500_000n]))
  t.mark('a')
  t.mark('b')
  expect(t.segmentMs('a', 'b')).toBe(1.5)
})

test('segmentMs throws on an unknown mark rather than returning NaN', () => {
  const t = new Timeline(fakeClock([0n]))
  t.mark('a')
  expect(() => t.segmentMs('a', 'nope')).toThrow('no mark named "nope"')
})

test('marking the same name twice throws, because a duplicate silently ruins a segment', () => {
  const t = new Timeline(fakeClock([0n, 1n]))
  t.mark('a')
  expect(() => t.mark('a')).toThrow('duplicate mark "a"')
})
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd spike/m0 && bun test`
Expected: FAIL, both files, cannot resolve `../src/stats` and `../src/timeline`.

- [ ] **Step 4: Implement**

`spike/m0/src/stats.ts`:

```ts
export type Summary = { n: number; p50: number; p95: number; max: number }

export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) throw new Error('percentile of empty sample')
  const rank = (p / 100) * (sorted.length - 1)
  const lo = Math.floor(rank)
  const hi = Math.ceil(rank)
  if (lo === hi) return sorted[lo]!
  return sorted[lo]! + (rank - lo) * (sorted[hi]! - sorted[lo]!)
}

export function summarise(samples: number[]): Summary {
  const sorted = [...samples].sort((a, b) => a - b)
  return {
    n: sorted.length,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    max: percentile(sorted, 100),
  }
}
```

`spike/m0/src/timeline.ts`:

```ts
export class Timeline {
  private marks = new Map<string, bigint>()

  constructor(private readonly now: () => bigint = () => process.hrtime.bigint()) {}

  mark(name: string): void {
    if (this.marks.has(name)) throw new Error(`duplicate mark "${name}"`)
    this.marks.set(name, this.now())
  }

  segmentMs(from: string, to: string): number {
    const a = this.marks.get(from)
    const b = this.marks.get(to)
    if (a === undefined) throw new Error(`no mark named "${from}"`)
    if (b === undefined) throw new Error(`no mark named "${to}"`)
    return Number(b - a) / 1_000_000
  }

  has(name: string): boolean {
    return this.marks.has(name)
  }
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd spike/m0 && bun test`
Expected: PASS, 9 tests.

- [ ] **Step 6: Commit**

```bash
git add .gitignore spike/m0
git commit -m "spike(m0): timing and percentile primitives"
```

---

### Task 2: Postgres startup packet parser

**Files:**
- Create: `spike/m0/src/startup.ts`
- Test: `spike/m0/test/startup.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `parseStartup(buf: Buffer): ParsedStartup | null` returning `null` when more bytes are needed. `type ParsedStartup = { message: StartupMessage; consumed: number }`. `type StartupMessage = { type: 'ssl_request' } | { type: 'cancel_request'; processId: number; secretKey: number } | { type: 'startup'; version: number; params: Record<string, string> }`. Also exports `SSL_REQUEST_CODE`, `CANCEL_REQUEST_CODE`, `PROTOCOL_3_0` and the test helper `buildStartupPacket(params: Record<string, string>): Buffer`.

- [ ] **Step 1: Write the failing test**

`spike/m0/test/startup.test.ts`:

```ts
import { test, expect } from 'bun:test'
import {
  parseStartup,
  buildStartupPacket,
  SSL_REQUEST_CODE,
  CANCEL_REQUEST_CODE,
  PROTOCOL_3_0,
} from '../src/startup'

test('parses user and database out of a startup packet', () => {
  const buf = buildStartupPacket({ user: 'hobby', database: 'blog' })
  const parsed = parseStartup(buf)
  expect(parsed).not.toBeNull()
  expect(parsed!.message.type).toBe('startup')
  if (parsed!.message.type !== 'startup') throw new Error('unreachable')
  expect(parsed!.message.version).toBe(PROTOCOL_3_0)
  expect(parsed!.message.params.user).toBe('hobby')
  expect(parsed!.message.params.database).toBe('blog')
  expect(parsed!.consumed).toBe(buf.length)
})

test('returns null when the packet is incomplete, so the caller keeps reading', () => {
  const buf = buildStartupPacket({ user: 'hobby', database: 'blog' })
  expect(parseStartup(buf.subarray(0, 4))).toBeNull()
  expect(parseStartup(buf.subarray(0, buf.length - 1))).toBeNull()
})

test('recognises an SSLRequest', () => {
  const buf = Buffer.alloc(8)
  buf.writeInt32BE(8, 0)
  buf.writeInt32BE(SSL_REQUEST_CODE, 4)
  const parsed = parseStartup(buf)
  expect(parsed!.message.type).toBe('ssl_request')
  expect(parsed!.consumed).toBe(8)
})

test('recognises a CancelRequest and reads its key', () => {
  const buf = Buffer.alloc(16)
  buf.writeInt32BE(16, 0)
  buf.writeInt32BE(CANCEL_REQUEST_CODE, 4)
  buf.writeInt32BE(4242, 8)
  buf.writeInt32BE(9999, 12)
  const parsed = parseStartup(buf)
  if (parsed!.message.type !== 'cancel_request') throw new Error('unreachable')
  expect(parsed!.message.processId).toBe(4242)
  expect(parsed!.message.secretKey).toBe(9999)
})

test('rejects an implausible length rather than allocating on it', () => {
  const buf = Buffer.alloc(8)
  buf.writeInt32BE(999_999, 0)
  buf.writeInt32BE(PROTOCOL_3_0, 4)
  expect(() => parseStartup(buf)).toThrow('implausible startup length')
})

test('rejects a packet whose final key is unterminated', () => {
  const body = Buffer.from('user\0hobby\0database', 'utf8')
  const buf = Buffer.alloc(8 + body.length)
  buf.writeInt32BE(buf.length, 0)
  buf.writeInt32BE(PROTOCOL_3_0, 4)
  body.copy(buf, 8)
  expect(() => parseStartup(buf)).toThrow('malformed startup')
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd spike/m0 && bun test test/startup.test.ts`
Expected: FAIL, cannot resolve `../src/startup`.

- [ ] **Step 3: Implement**

`spike/m0/src/startup.ts`:

```ts
export const PROTOCOL_3_0 = 196608
export const SSL_REQUEST_CODE = 80877103
export const CANCEL_REQUEST_CODE = 80877102

const MAX_STARTUP_BYTES = 10_000

export type StartupMessage =
  | { type: 'ssl_request' }
  | { type: 'cancel_request'; processId: number; secretKey: number }
  | { type: 'startup'; version: number; params: Record<string, string> }

export type ParsedStartup = { message: StartupMessage; consumed: number }

export function parseStartup(buf: Buffer): ParsedStartup | null {
  if (buf.length < 8) return null

  const length = buf.readInt32BE(0)
  if (length < 8 || length > MAX_STARTUP_BYTES) {
    throw new Error(`implausible startup length ${length}`)
  }
  if (buf.length < length) return null

  const code = buf.readInt32BE(4)

  if (length === 8 && code === SSL_REQUEST_CODE) {
    return { message: { type: 'ssl_request' }, consumed: 8 }
  }
  if (length === 16 && code === CANCEL_REQUEST_CODE) {
    return {
      message: {
        type: 'cancel_request',
        processId: buf.readInt32BE(8),
        secretKey: buf.readInt32BE(12),
      },
      consumed: 16,
    }
  }

  const params: Record<string, string> = {}
  let i = 8
  while (i < length) {
    if (buf[i] === 0) break
    const keyEnd = buf.indexOf(0, i)
    if (keyEnd === -1 || keyEnd >= length) throw new Error('malformed startup: unterminated key')
    const valueEnd = buf.indexOf(0, keyEnd + 1)
    if (valueEnd === -1 || valueEnd >= length) throw new Error('malformed startup: unterminated value')
    params[buf.toString('utf8', i, keyEnd)] = buf.toString('utf8', keyEnd + 1, valueEnd)
    i = valueEnd + 1
  }

  return { message: { type: 'startup', version: code, params }, consumed: length }
}

export function buildStartupPacket(params: Record<string, string>): Buffer {
  const parts: Buffer[] = []
  for (const [k, v] of Object.entries(params)) {
    parts.push(Buffer.from(`${k}\0${v}\0`, 'utf8'))
  }
  parts.push(Buffer.from([0]))
  const body = Buffer.concat(parts)
  const buf = Buffer.alloc(8 + body.length)
  buf.writeInt32BE(buf.length, 0)
  buf.writeInt32BE(PROTOCOL_3_0, 4)
  body.copy(buf, 8)
  return buf
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd spike/m0 && bun test test/startup.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add spike/m0/src/startup.ts spike/m0/test/startup.test.ts
git commit -m "spike(m0): parse the postgres startup packet"
```

---

### Task 3: Container runtime wrapper and the prepared fixture

**Files:**
- Create: `spike/m0/src/runtime.ts`
- Create: `spike/m0/src/fixture.ts`
- Test: `spike/m0/test/runtime.integration.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `start(name: string): Promise<void>`, `stopClean(name: string, timeoutSec?: number): Promise<void>`, `killHard(name: string): Promise<void>`, `isRunning(name: string): Promise<boolean>`, `removeIfExists(name: string): Promise<void>`, `create(opts: CreateOpts): Promise<void>` where `CreateOpts = { name: string; image: string; hostPort: number; password: string; dataDir: string }`. And `prepareFixture(opts: FixtureOpts): Promise<Fixture>` where `FixtureOpts = { name: string; image: string; hostPort: number; dataDir: string }` and `Fixture = { name: string; image: string; hostPort: number; dataDir: string; password: string; user: string; database: string }`.

**Why the data directory is bind mounted from the host:** if `PGDATA` lived in the container's writable layer, removing the container would destroy the data, which makes lever 1's remove-and-recreate comparison impossible, and it would measure a storage arrangement we will never ship. ADR 0003 requires a plain data directory on the host, so the spike uses one. On macOS this means the numbers include Docker Desktop's bind mount overhead, which is honest, because that is what a Mac Mini deployment would actually pay.

- [ ] **Step 1: Write the integration test**

This one talks to real Docker on purpose. There is no value in a mocked Docker for a spike whose entire output is real timings.

`spike/m0/test/runtime.integration.test.ts`:

```ts
import { test, expect, afterAll } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { create, start, stopClean, isRunning, removeIfExists } from '../src/runtime'

const NAME = 'm0-runtime-test'
const DATA = mkdtempSync(join(tmpdir(), 'm0-runtime-'))

afterAll(async () => {
  await removeIfExists(NAME)
})

test('a created container is not running until started, and stops cleanly', async () => {
  await removeIfExists(NAME)
  await create({ name: NAME, image: 'postgres:18-alpine', hostPort: 55599, password: 'spike', dataDir: DATA })
  expect(await isRunning(NAME)).toBe(false)

  await start(NAME)
  expect(await isRunning(NAME)).toBe(true)

  await stopClean(NAME)
  expect(await isRunning(NAME)).toBe(false)
}, 120_000)

test('isRunning is false for a container that does not exist', async () => {
  expect(await isRunning('m0-definitely-not-here')).toBe(false)
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd spike/m0 && bun test test/runtime.integration.test.ts`
Expected: FAIL, cannot resolve `../src/runtime`.

- [ ] **Step 3: Implement the runtime wrapper**

`spike/m0/src/runtime.ts`:

```ts
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(execFile)

export type CreateOpts = {
  name: string
  image: string
  hostPort: number
  password: string
  dataDir: string
}

export async function create(opts: CreateOpts): Promise<void> {
  await run('docker', [
    'create',
    '--name', opts.name,
    '-e', `POSTGRES_PASSWORD=${opts.password}`,
    '-p', `${opts.hostPort}:5432`,
    '-v', `${opts.dataDir}:/var/lib/postgresql/data`,
    opts.image,
  ])
}

export async function start(name: string): Promise<void> {
  await run('docker', ['start', name])
}

export async function stopClean(name: string, timeoutSec = 30): Promise<void> {
  await run('docker', ['stop', '-t', String(timeoutSec), name])
}

export async function killHard(name: string): Promise<void> {
  await run('docker', ['kill', name])
}

export async function isRunning(name: string): Promise<boolean> {
  try {
    const { stdout } = await run('docker', ['inspect', '-f', '{{.State.Running}}', name])
    return stdout.trim() === 'true'
  } catch {
    return false
  }
}

export async function removeIfExists(name: string): Promise<void> {
  try {
    await run('docker', ['rm', '-f', '-v', name])
  } catch {
    // already gone, which is the desired state
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd spike/m0 && bun test test/runtime.integration.test.ts`
Expected: PASS, 2 tests. The first pulls the image on a cold machine, so allow time.

- [ ] **Step 5: Implement the fixture**

The fixture is the state a hibernated instance is in: initialised data directory, container created, container stopped cleanly, never removed.

`spike/m0/src/fixture.ts`:

```ts
import { mkdirSync } from 'node:fs'
import { Client } from 'pg'
import { create, start, stopClean, removeIfExists } from './runtime'

export type FixtureOpts = {
  name: string
  image: string
  hostPort: number
  dataDir: string
}

export type Fixture = {
  name: string
  image: string
  hostPort: number
  dataDir: string
  password: string
  user: string
  database: string
}

const PASSWORD = 'spike'
const USER = 'postgres'
const DATABASE = 'postgres'

export async function prepareFixture(opts: FixtureOpts): Promise<Fixture> {
  await removeIfExists(opts.name)
  mkdirSync(opts.dataDir, { recursive: true })
  await create({
    name: opts.name,
    image: opts.image,
    hostPort: opts.hostPort,
    password: PASSWORD,
    dataDir: opts.dataDir,
  })

  // First boot runs initdb. Wait for it, then shut down cleanly so that every
  // measured start begins from a clean data directory rather than recovery.
  await start(opts.name)
  const deadline = Date.now() + 120_000
  for (;;) {
    if (await canConnect(opts.hostPort)) break
    if (Date.now() > deadline) throw new Error('fixture never became ready')
    await sleep(200)
  }
  await stopClean(opts.name)

  return {
    name: opts.name,
    image: opts.image,
    hostPort: opts.hostPort,
    dataDir: opts.dataDir,
    password: PASSWORD,
    user: USER,
    database: DATABASE,
  }
}

async function canConnect(port: number): Promise<boolean> {
  const client = new Client({
    host: '127.0.0.1',
    port,
    user: USER,
    password: PASSWORD,
    database: DATABASE,
    connectionTimeoutMillis: 1000,
  })
  try {
    await client.connect()
    await client.end()
    return true
  } catch {
    return false
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
```

- [ ] **Step 6: Commit**

```bash
git add spike/m0/src/runtime.ts spike/m0/src/fixture.ts spike/m0/test/runtime.integration.test.ts
git commit -m "spike(m0): container runtime wrapper and prepared fixture"
```

---

### Task 4: Readiness probing, with the poll interval as a variable

**Files:**
- Create: `spike/m0/src/ready.ts`
- Test: `spike/m0/test/ready.test.ts`

**Interfaces:**
- Consumes: `sleep` from `src/fixture.ts`
- Produces: `waitReady(opts: WaitOpts): Promise<WaitResult>` where `WaitOpts = { probe: () => Promise<boolean>; pollMs: number; timeoutMs: number; now?: () => number; sleepFor?: (ms: number) => Promise<void> }` and `WaitResult = { ready: boolean; attempts: number; waitedMs: number }`. Also `pgProbe(f: Fixture): () => Promise<boolean>`.

**Why this is its own task:** the spec calls `ready_detect` the segment most likely to be needlessly large and entirely ours. Making the poll interval an injected variable is what turns lever 3 into a measurement instead of an opinion.

- [ ] **Step 1: Write the failing test**

`spike/m0/test/ready.test.ts`:

```ts
import { test, expect } from 'bun:test'
import { waitReady } from '../src/ready'

function controlledClock() {
  let t = 0
  return {
    now: () => t,
    sleepFor: async (ms: number) => {
      t += ms
    },
    advance: (ms: number) => {
      t += ms
    },
  }
}

test('returns immediately when the first probe succeeds', async () => {
  const c = controlledClock()
  const r = await waitReady({
    probe: async () => true,
    pollMs: 100,
    timeoutMs: 5000,
    now: c.now,
    sleepFor: c.sleepFor,
  })
  expect(r.ready).toBe(true)
  expect(r.attempts).toBe(1)
  expect(r.waitedMs).toBe(0)
})

test('polls until the probe succeeds and counts every attempt', async () => {
  const c = controlledClock()
  let calls = 0
  const r = await waitReady({
    probe: async () => ++calls >= 4,
    pollMs: 25,
    timeoutMs: 5000,
    now: c.now,
    sleepFor: c.sleepFor,
  })
  expect(r.ready).toBe(true)
  expect(r.attempts).toBe(4)
  expect(r.waitedMs).toBe(75)
})

test('a coarser poll interval costs more waiting for the same readiness point', async () => {
  const fine = controlledClock()
  const coarse = controlledClock()
  let a = 0
  let b = 0
  const fineResult = await waitReady({
    probe: async () => ++a >= 4,
    pollMs: 25,
    timeoutMs: 5000,
    now: fine.now,
    sleepFor: fine.sleepFor,
  })
  const coarseResult = await waitReady({
    probe: async () => ++b >= 4,
    pollMs: 1000,
    timeoutMs: 50_000,
    now: coarse.now,
    sleepFor: coarse.sleepFor,
  })
  expect(coarseResult.waitedMs).toBeGreaterThan(fineResult.waitedMs)
})

test('gives up at the timeout and reports not ready rather than hanging', async () => {
  const c = controlledClock()
  const r = await waitReady({
    probe: async () => false,
    pollMs: 100,
    timeoutMs: 500,
    now: c.now,
    sleepFor: c.sleepFor,
  })
  expect(r.ready).toBe(false)
  expect(r.waitedMs).toBeGreaterThanOrEqual(500)
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd spike/m0 && bun test test/ready.test.ts`
Expected: FAIL, cannot resolve `../src/ready`.

- [ ] **Step 3: Implement**

`spike/m0/src/ready.ts`:

```ts
import { Client } from 'pg'
import { sleep, type Fixture } from './fixture'

export type WaitOpts = {
  probe: () => Promise<boolean>
  pollMs: number
  timeoutMs: number
  now?: () => number
  sleepFor?: (ms: number) => Promise<void>
}

export type WaitResult = { ready: boolean; attempts: number; waitedMs: number }

export async function waitReady(opts: WaitOpts): Promise<WaitResult> {
  const now = opts.now ?? Date.now
  const sleepFor = opts.sleepFor ?? sleep
  const startedAt = now()
  let attempts = 0

  for (;;) {
    attempts++
    if (await opts.probe()) {
      return { ready: true, attempts, waitedMs: now() - startedAt }
    }
    if (now() - startedAt >= opts.timeoutMs) {
      return { ready: false, attempts, waitedMs: now() - startedAt }
    }
    await sleepFor(opts.pollMs)
  }
}

export function pgProbe(f: Fixture): () => Promise<boolean> {
  return async () => {
    const client = new Client({
      host: '127.0.0.1',
      port: f.hostPort,
      user: f.user,
      password: f.password,
      database: f.database,
      connectionTimeoutMillis: 1000,
    })
    try {
      await client.connect()
      await client.end()
      return true
    } catch {
      return false
    }
  }
}
```

Note for the results write-up: `pgProbe` opens a full connection per attempt, which is the honest measure of "Postgres accepts connections" but is heavier than needed. A lighter probe that sends a startup packet and reads the first response byte is a candidate optimisation for M2, and the difference is worth a sentence in the results even though it is not measured here.

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd spike/m0 && bun test test/ready.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add spike/m0/src/ready.ts spike/m0/test/ready.test.ts
git commit -m "spike(m0): readiness probing with an injectable poll interval"
```

---

### Task 5: The wake proxy

**Files:**
- Create: `spike/m0/src/proxy.ts`
- Test: `spike/m0/test/proxy.integration.test.ts`

**Interfaces:**
- Consumes: `parseStartup` from `src/startup.ts`, `Timeline` from `src/timeline.ts`, `start`/`isRunning` from `src/runtime.ts`, `waitReady`/`pgProbe` from `src/ready.ts`, `Fixture` from `src/fixture.ts`
- Produces: `startProxy(opts: ProxyOpts): Promise<ProxyHandle>` where `ProxyOpts = { listenPort: number; fixture: Fixture; pollMs: number; wakeTimeoutMs: number; onTimeline: (t: Timeline) => void }` and `ProxyHandle = { close: () => Promise<void> }`. Timeline mark names, which Task 6 depends on exactly: `accept`, `parsed`, `wake_issued`, `container_up`, `pg_ready`, `upstream_connected`.

- [ ] **Step 1: Write the integration test**

`spike/m0/test/proxy.integration.test.ts`:

```ts
import { test, expect, afterAll } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from 'pg'
import { prepareFixture } from '../src/fixture'
import { removeIfExists, stopClean, isRunning } from '../src/runtime'
import { startProxy } from '../src/proxy'
import type { Timeline } from '../src/timeline'

const NAME = 'm0-proxy-test'
const DATA = mkdtempSync(join(tmpdir(), 'm0-proxy-'))

afterAll(async () => {
  await removeIfExists(NAME)
})

test('a connection to a stopped instance wakes it and serves the query', async () => {
  const fixture = await prepareFixture({
    name: NAME,
    image: 'postgres:18-alpine',
    hostPort: 55598,
    dataDir: DATA,
  })
  expect(await isRunning(NAME)).toBe(false)

  const timelines: Timeline[] = []
  const proxy = await startProxy({
    listenPort: 55597,
    fixture,
    pollMs: 25,
    wakeTimeoutMs: 30_000,
    onTimeline: (t) => timelines.push(t),
  })

  const client = new Client({
    host: '127.0.0.1',
    port: 55597,
    user: fixture.user,
    password: fixture.password,
    database: fixture.database,
  })
  await client.connect()
  const res = await client.query('SELECT 1 AS one')
  expect(res.rows[0].one).toBe(1)
  await client.end()

  expect(timelines.length).toBe(1)
  const t = timelines[0]!
  expect(t.segmentMs('accept', 'upstream_connected')).toBeGreaterThan(0)
  expect(t.has('container_up')).toBe(true)
  expect(t.has('pg_ready')).toBe(true)

  await proxy.close()
  await stopClean(NAME)
}, 180_000)
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd spike/m0 && bun test test/proxy.integration.test.ts`
Expected: FAIL, cannot resolve `../src/proxy`.

- [ ] **Step 3: Implement**

`spike/m0/src/proxy.ts`:

```ts
import net from 'node:net'
import { parseStartup } from './startup'
import { Timeline } from './timeline'
import { start, isRunning } from './runtime'
import { waitReady, pgProbe } from './ready'
import { sleep, type Fixture } from './fixture'

export type ProxyOpts = {
  listenPort: number
  fixture: Fixture
  pollMs: number
  wakeTimeoutMs: number
  onTimeline: (t: Timeline) => void
}

export type ProxyHandle = { close: () => Promise<void> }

export async function startProxy(opts: ProxyOpts): Promise<ProxyHandle> {
  const server = net.createServer((client) => {
    handleConnection(client, opts).catch((err) => {
      sendFatal(client, String(err))
    })
  })

  await new Promise<void>((resolve) => server.listen(opts.listenPort, '127.0.0.1', resolve))
  return {
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

async function handleConnection(client: net.Socket, opts: ProxyOpts): Promise<void> {
  const t = new Timeline()
  t.mark('accept')

  const startup = await readStartup(client)
  t.mark('parsed')

  // Mark after start returns, not before. The segment is defined as "parsed to
  // the start command returning", so marking first would report roughly zero
  // and quietly fold the command's own cost into container_up.
  if (!(await isRunning(opts.fixture.name))) {
    await start(opts.fixture.name)
  }
  t.mark('wake_issued')

  const upDeadline = Date.now() + opts.wakeTimeoutMs
  while (!(await isRunning(opts.fixture.name))) {
    if (Date.now() > upDeadline) {
      sendFatal(client, 'container did not start')
      return
    }
    await sleep(5)
  }
  t.mark('container_up')

  const ready = await waitReady({
    probe: pgProbe(opts.fixture),
    pollMs: opts.pollMs,
    timeoutMs: opts.wakeTimeoutMs,
  })
  if (!ready.ready) {
    sendFatal(client, 'postgres did not become ready before the wake timeout')
    return
  }
  t.mark('pg_ready')

  const upstream = net.createConnection({ host: '127.0.0.1', port: opts.fixture.hostPort })
  await new Promise<void>((resolve, reject) => {
    upstream.once('connect', resolve)
    upstream.once('error', reject)
  })
  upstream.write(startup)
  t.mark('upstream_connected')
  opts.onTimeline(t)

  client.pipe(upstream)
  upstream.pipe(client)
  const teardown = () => {
    client.destroy()
    upstream.destroy()
  }
  client.on('error', teardown)
  upstream.on('error', teardown)
  client.on('close', teardown)
  upstream.on('close', teardown)
}

// Reads until a real startup packet arrives, declining SSL along the way. The
// spike does not terminate TLS, so it answers SSLRequest with 'N' and the
// client retries in plaintext. M2 terminates instead, because it must.
async function readStartup(client: net.Socket): Promise<Buffer> {
  let buf = Buffer.alloc(0)
  for (;;) {
    const chunk = await once(client)
    buf = Buffer.concat([buf, chunk])
    const parsed = parseStartup(buf)
    if (!parsed) continue
    if (parsed.message.type === 'ssl_request') {
      client.write(Buffer.from('N'))
      buf = buf.subarray(parsed.consumed)
      continue
    }
    if (parsed.message.type === 'cancel_request') {
      throw new Error('cancel request is out of scope for the spike')
    }
    return buf.subarray(0, parsed.consumed)
  }
}

function once(socket: net.Socket): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    socket.once('data', resolve)
    socket.once('error', reject)
    socket.once('close', () => reject(new Error('client closed before sending a startup packet')))
  })
}

// A real Postgres ErrorResponse, so a client library shows a message instead of
// an unreadable socket error. The spec calls this out as the failure mode that
// makes people uninstall.
function sendFatal(client: net.Socket, message: string): void {
  const fields = [
    Buffer.from(`S${'FATAL'}\0`, 'utf8'),
    Buffer.from(`C${'57P03'}\0`, 'utf8'),
    Buffer.from(`M${message}\0`, 'utf8'),
    Buffer.from([0]),
  ]
  const body = Buffer.concat(fields)
  const out = Buffer.alloc(5 + body.length)
  out.write('E', 0, 'ascii')
  out.writeInt32BE(4 + body.length, 1)
  body.copy(out, 5)
  client.end(out)
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd spike/m0 && bun test test/proxy.integration.test.ts`
Expected: PASS. The full suite should also pass: `bun test`.

- [ ] **Step 5: Commit**

```bash
git add spike/m0/src/proxy.ts spike/m0/test/proxy.integration.test.ts
git commit -m "spike(m0): wake proxy that starts a stopped instance on connect"
```

---

### Task 6: The measurement harness

**Files:**
- Create: `spike/m0/src/harness.ts`
- Test: `spike/m0/test/harness.test.ts`

**Interfaces:**
- Consumes: `Timeline`, `summarise`/`Summary`, `startProxy`, `Fixture`, `stopClean`
- Produces: `SEGMENTS: readonly [string, string][]`, `segmentsOf(t: Timeline): Record<string, number>`, `runCell(opts: CellOpts): Promise<CellResult>` where `CellOpts = { label: string; fixture: Fixture; listenPort: number; pollMs: number; iterations: number; reset: 'stop' | 'kill' | 'recreate'; dropCaches: boolean }` and `CellResult = { label: string; iterations: number; segments: Record<string, Summary>; total: Summary; failures: number }`.

**`reset` is how the levers get measured.** `stop` is a clean shutdown and is lever 1's baseline. `kill` is lever 2, a `SIGKILL`ed container whose next start does recovery. `recreate` is lever 1's comparison: remove the container and create a new one against the same bind-mounted data directory, which is why the data directory had to leave the container layer in Task 3.

- [ ] **Step 1: Write the failing test**

`spike/m0/test/harness.test.ts`:

```ts
import { test, expect } from 'bun:test'
import { Timeline } from '../src/timeline'
import { segmentsOf, SEGMENTS } from '../src/harness'

function timelineWith(values: number[]): Timeline {
  let i = 0
  const t = new Timeline(() => BigInt(values[i++]!) * 1_000_000n)
  t.mark('accept')
  t.mark('parsed')
  t.mark('wake_issued')
  t.mark('container_up')
  t.mark('pg_ready')
  t.mark('upstream_connected')
  return t
}

test('the six segments are named exactly as the spec names them', () => {
  expect(SEGMENTS.map(([, to]) => to)).toEqual([
    'parsed',
    'wake_issued',
    'container_up',
    'pg_ready',
    'upstream_connected',
  ])
})

test('segmentsOf reports each gap in milliseconds', () => {
  const t = timelineWith([0, 1, 2, 200, 900, 910])
  const s = segmentsOf(t)
  expect(s.accept_parse).toBe(1)
  expect(s.wake_issue).toBe(1)
  expect(s.container_up).toBe(198)
  expect(s.pg_ready).toBe(700)
  expect(s.connect_splice).toBe(10)
  expect(s.total).toBe(910)
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd spike/m0 && bun test test/harness.test.ts`
Expected: FAIL, cannot resolve `../src/harness`.

- [ ] **Step 3: Implement**

`spike/m0/src/harness.ts`:

```ts
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { Client } from 'pg'
import { Timeline } from './timeline'
import { summarise, type Summary } from './stats'
import { startProxy } from './proxy'
import { stopClean, killHard, create, removeIfExists } from './runtime'
import { sleep, type Fixture } from './fixture'

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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd spike/m0 && bun test test/harness.test.ts`
Expected: PASS, 2 tests.

- [ ] **Step 5: Commit**

```bash
git add spike/m0/src/harness.ts spike/m0/test/harness.test.ts
git commit -m "spike(m0): per-segment measurement harness"
```

---

### Task 7: Scenario matrix, runner and markdown report

**Files:**
- Create: `spike/m0/src/scenarios.ts`
- Create: `spike/m0/src/report.ts`
- Create: `spike/m0/src/run.ts`
- Test: `spike/m0/test/report.test.ts`

**Interfaces:**
- Consumes: `CellOpts`/`CellResult`/`runCell`, `prepareFixture`
- Produces: `SCENARIOS: Scenario[]` where `Scenario = { label: string; image: string; pollMs: number; reset: ResetMode; dropCaches: boolean }`, `renderReport(env: Env, results: CellResult[]): string` where `Env = { machine: string; cpu: string; ram: string; disk: string; filesystem: string; os: string; runtime: string; runtimeVersion: string; cachesDropped: boolean }`, and an executable entrypoint `run.ts`.

- [ ] **Step 1: Write the failing test**

`spike/m0/test/report.test.ts`:

```ts
import { test, expect } from 'bun:test'
import { renderReport } from '../src/report'
import { SCENARIOS } from '../src/scenarios'

const env = {
  machine: 'test',
  cpu: '1 vCPU',
  ram: '1GB',
  disk: 'nvme',
  filesystem: 'ext4',
  os: 'Debian 12',
  runtime: 'bun',
  runtimeVersion: '1.1.0',
  cachesDropped: true,
}

const result = {
  label: 'baseline',
  iterations: 50,
  segments: {
    accept_parse: { n: 50, p50: 0.4, p95: 0.9, max: 2 },
    wake_issue: { n: 50, p50: 30, p95: 45, max: 60 },
    container_up: { n: 50, p50: 180, p95: 240, max: 300 },
    pg_ready: { n: 50, p50: 400, p95: 620, max: 900 },
    connect_splice: { n: 50, p50: 5, p95: 9, max: 14 },
  },
  total: { n: 50, p50: 615, p95: 915, max: 1276 },
  failures: 0,
}

test('the report states the hardware, because a benchmark without it is a rumour', () => {
  const md = renderReport(env, [result])
  expect(md).toContain('1 vCPU')
  expect(md).toContain('ext4')
  expect(md).toContain('bun 1.1.0')
})

test('the report answers the gate rather than leaving it to the reader', () => {
  const md = renderReport(env, [result])
  expect(md).toContain('Gate:')
  expect(md).toContain('915')
})

test('a p95 over 3000ms is reported as a blocker', () => {
  const bad = { ...result, total: { n: 50, p50: 2000, p95: 3400, max: 4000 } }
  expect(renderReport(env, [bad])).toContain('BLOCKER')
})

test('every scenario has a distinct label, so report rows cannot collide', () => {
  const labels = SCENARIOS.map((s) => s.label)
  expect(new Set(labels).size).toBe(labels.length)
})

test('the report contains no em-dashes', () => {
  expect(renderReport(env, [result])).not.toContain('—')
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd spike/m0 && bun test test/report.test.ts`
Expected: FAIL, cannot resolve `../src/report`.

- [ ] **Step 3: Implement scenarios**

`spike/m0/src/scenarios.ts`:

```ts
import type { ResetMode } from './harness'

export type Scenario = {
  label: string
  image: string
  pollMs: number
  reset: ResetMode
  dropCaches: boolean
}

// One scenario per lever, each differing from the baseline in exactly one way,
// so a difference in the results has exactly one explanation.
//
//   lever 1  stopped versus recreated       baseline vs recreate
//   lever 2  clean stop versus SIGKILL      baseline vs kill
//   lever 3  poll interval                  poll25 vs poll100 vs poll1000
//   free     base image                     alpine vs debian
//   context  page cache                     warm vs cold
export const SCENARIOS: Scenario[] = [
  { label: 'baseline-alpine-poll25', image: 'postgres:18-alpine', pollMs: 25, reset: 'stop', dropCaches: false },
  { label: 'poll100-alpine', image: 'postgres:18-alpine', pollMs: 100, reset: 'stop', dropCaches: false },
  { label: 'poll1000-alpine', image: 'postgres:18-alpine', pollMs: 1000, reset: 'stop', dropCaches: false },
  { label: 'debian-poll25', image: 'postgres:18', pollMs: 25, reset: 'stop', dropCaches: false },
  { label: 'kill-alpine-poll25', image: 'postgres:18-alpine', pollMs: 25, reset: 'kill', dropCaches: false },
  { label: 'recreate-alpine-poll25', image: 'postgres:18-alpine', pollMs: 25, reset: 'recreate', dropCaches: false },
  { label: 'coldcache-alpine-poll25', image: 'postgres:18-alpine', pollMs: 25, reset: 'stop', dropCaches: true },
]
```

- [ ] **Step 4: Implement the report**

`spike/m0/src/report.ts`:

```ts
import type { CellResult } from './harness'

export type Env = {
  machine: string
  cpu: string
  ram: string
  disk: string
  filesystem: string
  os: string
  runtime: string
  runtimeVersion: string
  cachesDropped: boolean
}

const TARGET_MS = 1000
const CEILING_MS = 3000

export function renderReport(env: Env, results: CellResult[]): string {
  const lines: string[] = []

  lines.push('## Hardware')
  lines.push('')
  lines.push(`- Machine: ${env.machine}`)
  lines.push(`- CPU: ${env.cpu}`)
  lines.push(`- RAM: ${env.ram}`)
  lines.push(`- Disk: ${env.disk}`)
  lines.push(`- Filesystem: ${env.filesystem}`)
  lines.push(`- OS: ${env.os}`)
  lines.push(`- Runtime: ${env.runtime} ${env.runtimeVersion}`)
  lines.push(`- Page cache dropped between iterations: ${env.cachesDropped ? 'yes' : 'no'}`)
  lines.push('')

  lines.push('## Results, milliseconds')
  lines.push('')
  lines.push('| scenario | n | fail | accept_parse p50 | wake_issue p50 | container_up p50 | pg_ready p50 | connect_splice p50 | total p50 | total p95 | total max |')
  lines.push('|---|---|---|---|---|---|---|---|---|---|---|')
  for (const r of results) {
    lines.push(
      `| ${r.label} | ${r.iterations} | ${r.failures} | ` +
        `${fmt(r.segments.accept_parse?.p50)} | ${fmt(r.segments.wake_issue?.p50)} | ` +
        `${fmt(r.segments.container_up?.p50)} | ${fmt(r.segments.pg_ready?.p50)} | ` +
        `${fmt(r.segments.connect_splice?.p50)} | ` +
        `${fmt(r.total.p50)} | ${fmt(r.total.p95)} | ${fmt(r.total.max)} |`,
    )
  }
  lines.push('')

  const worst = Math.max(...results.map((r) => r.total.p95))
  lines.push('## Gate')
  lines.push('')
  lines.push(`Target ${TARGET_MS}ms, hard ceiling ${CEILING_MS}ms, measured on total p95.`)
  lines.push('')
  lines.push(`Gate: worst total p95 across scenarios is ${fmt(worst)}ms. ${verdict(worst)}`)
  lines.push('')

  return lines.join('\n')
}

function verdict(worstP95: number): string {
  if (worstP95 < TARGET_MS) return 'Under target. Proceed to M1 as designed.'
  if (worstP95 <= CEILING_MS) {
    return 'Over target but under the ceiling. Proceed, publish the real number, revisit the levers in M2.'
  }
  return 'BLOCKER. Over the 3000ms ceiling. A warm pool becomes mandatory or the wedge is re-examined, and either way it needs an ADR before M1 continues.'
}

function fmt(v: number | undefined): string {
  return v === undefined ? 'n/a' : v.toFixed(1)
}
```

- [ ] **Step 5: Implement the entrypoint**

`spike/m0/src/run.ts`:

```ts
import { writeFileSync, rmSync } from 'node:fs'
import { prepareFixture } from './fixture'
import { removeIfExists } from './runtime'
import { runCell, type CellResult } from './harness'
import { SCENARIOS } from './scenarios'
import { renderReport, type Env } from './report'

const ITERATIONS = Number(process.env.M0_ITERATIONS ?? 50)
const NAME = 'm0-bench'
const HOST_PORT = 55432
const LISTEN_PORT = 55433
// Required, and deliberately not defaulted to a temp directory. On many Linux
// distributions /tmp is tmpfs, which is RAM, and a benchmark whose data
// directory lives in RAM measures the wrong thing entirely while looking
// excellent. Point this at the disk the results claim to describe.
const DATA_DIR = process.env.M0_DATA_DIR

function envFromArgs(): Env {
  const need = (k: string): string => {
    const v = process.env[k]
    if (!v) throw new Error(`set ${k}, the results are worthless without it`)
    return v
  }
  return {
    machine: need('M0_MACHINE'),
    cpu: need('M0_CPU'),
    ram: need('M0_RAM'),
    disk: need('M0_DISK'),
    filesystem: need('M0_FS'),
    os: need('M0_OS'),
    runtime: need('M0_RUNTIME'),
    runtimeVersion: need('M0_RUNTIME_VERSION'),
    cachesDropped: process.platform === 'linux',
  }
}

if (!DATA_DIR) throw new Error('set M0_DATA_DIR to a path on the disk being measured, not /tmp')

const env = envFromArgs()
const results: CellResult[] = []

for (const scenario of SCENARIOS) {
  process.stderr.write(`running ${scenario.label}\n`)
  await removeIfExists(NAME)
  // Each scenario gets a fresh data directory, so an earlier scenario's
  // bloat or WAL state cannot leak into a later one's numbers.
  rmSync(DATA_DIR, { recursive: true, force: true })
  const fixture = await prepareFixture({
    name: NAME,
    image: scenario.image,
    hostPort: HOST_PORT,
    dataDir: DATA_DIR,
  })
  results.push(
    await runCell({
      label: scenario.label,
      fixture,
      listenPort: LISTEN_PORT,
      pollMs: scenario.pollMs,
      iterations: ITERATIONS,
      reset: scenario.reset,
      dropCaches: scenario.dropCaches,
    }),
  )
}

await removeIfExists(NAME)
rmSync(DATA_DIR, { recursive: true, force: true })

const out = `m0-${env.machine}-${env.runtime}.md`
writeFileSync(out, renderReport(env, results))
process.stderr.write(`wrote ${out}\n`)
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd spike/m0 && bun test`
Expected: PASS, whole suite.

- [ ] **Step 7: Commit**

```bash
git add spike/m0/src/scenarios.ts spike/m0/src/report.ts spike/m0/src/run.ts spike/m0/test/report.test.ts
git commit -m "spike(m0): scenario matrix, runner and markdown report"
```

---

### Task 8: Execute the matrix and write the results

**Files:**
- Create: `docs/proxy/research/2026-08-XX-cold-start-measurements.md` (dated the day the numbers were taken)
- Modify: `docs/proxy/CLAUDE.md` if the target moved
- Modify: `CLAUDE.md` if the target moved
- Modify: `claude_docs/ACTIVE_CONTEXT.md`

**Interfaces:**
- Consumes: `spike/m0/src/run.ts`
- Produces: the answered gate

- [ ] **Step 1: Run the matrix on the Mac Mini, on Bun**

```bash
cd spike/m0
M0_MACHINE="mac-mini" M0_CPU="<fill from sysctl -n machdep.cpu.brand_string>" \
M0_RAM="<fill>" M0_DISK="internal nvme" M0_FS="apfs" \
M0_DATA_DIR="$HOME/m0-bench-data" \
M0_OS="$(sw_vers -productVersion)" M0_RUNTIME="bun" M0_RUNTIME_VERSION="$(bun --version)" \
bun src/run.ts
```

`M0_DATA_DIR` must be on the disk the results claim to describe. Do not point it
at `/tmp`, which is tmpfs on many Linux distributions and would measure RAM.
Confirm with `df -T "$M0_DATA_DIR"` on Linux before the first run and record the
filesystem it reports.

- [ ] **Step 2: Run the same matrix on the Mac Mini, on Node**

```bash
cd spike/m0
M0_MACHINE="mac-mini" M0_CPU="<same>" M0_RAM="<same>" M0_DISK="internal nvme" M0_FS="apfs" \
M0_OS="$(sw_vers -productVersion)" M0_RUNTIME="node" M0_RUNTIME_VERSION="$(node --version)" \
node --experimental-strip-types src/run.ts
```

If `--experimental-strip-types` is unavailable on the installed Node, install `tsx` as a dev dependency and run `npx tsx src/run.ts` instead. Record which was used in the results.

- [ ] **Step 3: Run both on the five dollar VPS**

Same two commands, with `M0_MACHINE="vps"`, `M0_FS="$(df -T . | awk 'NR==2{print $2}')"`, `M0_OS="$(. /etc/os-release; echo "$PRETTY_NAME")"`, and CPU, RAM and disk filled from `lscpu`, `free -h` and `lsblk -d -o name,rota`.

The VPS run with `dropCaches` needs passwordless sudo, or the results must say the page cache was not dropped. Do not report a warm number as cold.

- [ ] **Step 4: Write the results document**

Create `docs/proxy/research/2026-08-XX-cold-start-measurements.md` with:

- Status header: `Status: NOTES. Measurements.` and the date the numbers were taken.
- The four generated report bodies, one section per machine and runtime.
- A **Findings** section answering, in prose, each of: which segment dominates; what recreating the container costs versus keeping it stopped, which is lever 1 and the assumption `docs/engine/CLAUDE.md` already made; what a `SIGKILL` costs versus a clean stop, which is lever 2 and the case that will happen in production whether we like it or not; what the poll interval sweep cost, which is lever 3 and the closest thing we get to `ready_detect` since true readiness is not directly observable; whether alpine or debian starts faster; whether Bun or Node differs materially on `accept_parse` and `connect_splice`; and what the cold page cache cost.
- The **failure timing** and the confirmation that a client receives a real `ErrorResponse`. If Task 5's `sendFatal` path was never exercised, exercise it by pointing the fixture at a container that cannot start, and record what `psql` prints.
- The **idle cost** of the proxy holding 20 idle connections, from `ps -o rss` against the envelope in `docs/hibernation/CLAUDE.md` of under 15MiB and 0.05 CPU.
- The **gate verdict**, copied from the generated report, stated once and unambiguously.
- The note from Task 4 that `pgProbe` opens a full connection per attempt and a lighter startup-packet probe is an M2 candidate.

- [ ] **Step 5: Update the docs if the target moved**

If the verdict is under target, no change. If it is between target and ceiling, update the cold start line in `docs/proxy/CLAUDE.md` and in the root `CLAUDE.md` to state the measured number alongside the target. If it is a BLOCKER, stop and write an ADR proposing the warm pool or a re-examination of the wedge. Do not proceed to M1 in that case.

Update `claude_docs/ACTIVE_CONTEXT.md`: M0 moves to done, the immediate next step becomes M1, and the "cold start is still unmeasured" risk is replaced with the number.

- [ ] **Step 6: Commit**

```bash
git add docs/proxy/research docs/proxy/CLAUDE.md CLAUDE.md claude_docs/ACTIVE_CONTEXT.md
git commit -m "docs: M0 cold start measurements and gate verdict"
```

---

### Task 9: Delete the spike

**Files:**
- Delete: `spike/`
- Modify: `claude_docs/PROGRESS.md`

**Interfaces:**
- Consumes: nothing
- Produces: nothing. That is the point.

**Why this is a task and not a footnote:** the spec says the spike code is deleted, not moved into a package and not kept for reference. Its output is the measurements, which are now committed as a document, and the code itself is preserved in git history for anyone who wants to reproduce it. A spike that survives becomes a foundation nobody reviewed as one.

- [ ] **Step 1: Confirm nothing depends on it**

Run: `grep -rn "spike/" --include='*.ts' --include='*.json' --include='*.md' . | grep -v claude_docs/plans | grep -v PROGRESS`
Expected: no hits outside the plan and the history entry.

- [ ] **Step 2: Delete**

```bash
git rm -r spike
```

- [ ] **Step 3: Append the history entry**

Add an entry at the top of `claude_docs/PROGRESS.md`, below the header and the first `---`, following the existing format: what changed, what it cost, and what was learned. Include the measured p95 numbers for both machines, the gate verdict, and the single most surprising finding from the matrix. Do not rewrite the existing entries.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "spike(m0): delete the spike, its output is the measurements"
```

---

## Notes for the implementer

**On the six segments.** The spec's table lists `ready_detect` as its own segment, from "Postgres ready" to "we notice it is ready." That is not directly observable, because we cannot see the moment Postgres became ready without polling, and polling is the thing being measured. The harness therefore collects five segments and derives detection lag from the poll interval sweep instead. This is a real limitation and Task 8 requires writing it down rather than quietly reporting five segments where six were promised.

**On honesty.** Every number in the results document must come from a run that actually happened on the hardware named. If a cell could not be run, the results say so and say why. An absent number is fine. A guessed one poisons every decision built on it.
