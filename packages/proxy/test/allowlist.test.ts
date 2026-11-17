// Per-project IP allowlists (access.ts, docs/proxy/CLAUDE.md's 2026-11-17
// amendment), through the real proxy on every path that reaches a database:
// plain TCP, TLS, CancelRequest, and the serverless driver's /sql and
// WebSocket. Against the SCRAM-speaking fake Postgres; no Docker.
//
// A remote client is played two ways. `sameBox: () => false` takes away the
// loopback exemption, so a connection from 127.0.0.1 is judged by the list
// alone. And where the point is that the real address survives a relay (the
// TLS terminator dials its inner server from 127.0.0.1), the client connects
// from ::1, which no relay on this box would report.

import assert from 'node:assert/strict'
import net from 'node:net'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { neon, neonConfig, Pool } from '@neondatabase/serverless'
import pg from 'pg'
import {
  ActivityTracker,
  buildCancelRequest,
  buildStartupPacket,
  RefusalLimiter,
  refusalLogLine,
  startPgProxy,
  type AccessRefusal,
  type ProxyDeps,
  type ProxyTarget,
} from '../src/index.js'
import { startFakePostgres, type FakePostgres, type FakeResult } from './fixtures/fake-postgres.js'

const FIXTURES = fileURLToPath(new URL('../../test/fixtures/', import.meta.url))
const PASSWORD = 'local-test-password'

function handler(sql: string): FakeResult {
  if (sql.trim() === 'SELECT 1 AS one') return { fields: [{ name: 'one', typeId: 23 }], rows: [['1']], command: 'SELECT' }
  return { fields: [], rows: [], command: 'SELECT' }
}

interface Harness {
  pg: FakePostgres
  port: number
  wakes: string[]
  resolves: string[]
  refusals: AccessRefusal[]
  activity: ActivityTracker
  // Mutable: what the allowlist lookup answers for project `blog`.
  list: { value: readonly string[] | null }
  close(): Promise<void>
}

async function harness(opts: {
  list: readonly string[] | null
  state?: string
  host?: string
  sameBox?: boolean
  tls?: boolean
}): Promise<Harness> {
  const fake = await startFakePostgres({ password: PASSWORD, handler })
  const state = { value: opts.state ?? 'running' }
  const wakes: string[] = []
  const resolves: string[] = []
  const refusals: AccessRefusal[] = []
  const list = { value: opts.list }
  const activity = new ActivityTracker()
  const target = (): ProxyTarget => ({
    resourceId: 'res-blog',
    label: 'blog/primary',
    host: '127.0.0.1',
    port: fake.port,
    state: state.value,
    database: 'blog',
  })
  const deps: ProxyDeps = {
    resolve: async (project) => {
      resolves.push(project)
      return project === 'blog' ? target() : null
    },
    wake: async (id) => {
      wakes.push(id)
      state.value = 'running'
    },
    allowlist: (project) => (project === 'blog' ? list.value : null),
    onAccessRefused: (refusal) => refusals.push(refusal),
    activity,
  }
  const proxy = await startPgProxy({
    port: 0,
    host: opts.host ?? '127.0.0.1',
    deps,
    wakeTimeoutMs: 3000,
    ...(opts.sameBox === undefined ? {} : { sameBox: () => opts.sameBox as boolean }),
    ...(opts.tls === true ? { tls: { certFile: `${FIXTURES}first.crt`, keyFile: `${FIXTURES}first.key` } } : {}),
  })
  return {
    pg: fake,
    port: proxy.port,
    wakes,
    resolves,
    refusals,
    activity,
    list,
    close: async () => {
      await proxy.close()
      await fake.close()
    },
  }
}

function sqlState(buf: Buffer): string | null {
  const i = buf.indexOf(Buffer.from('C', 'ascii'), 5)
  if (i === -1) return null
  return buf.toString('ascii', i + 1, buf.indexOf(0, i + 1))
}

function rawStartup(port: number, host = '127.0.0.1'): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port })
    const chunks: Buffer[] = []
    socket.once('connect', () => socket.write(buildStartupPacket({ user: 'app', database: 'blog' })))
    socket.on('data', (c: Buffer) => chunks.push(c))
    socket.on('close', () => resolve(Buffer.concat(chunks)))
    socket.on('error', reject)
  })
}

function pgClient(port: number, host: string, ssl = false): pg.Client {
  return new pg.Client({
    host,
    port,
    user: 'app',
    password: PASSWORD,
    database: 'blog',
    ...(ssl ? { ssl: { rejectUnauthorized: false } } : {}),
  })
}

test('a refused address gets FATAL 28000 naming the project and address, and is never resolved, woken or counted', async () => {
  const h = await harness({ list: ['10.0.0.0/8'], state: 'sleeping', sameBox: false })
  try {
    const reply = await rawStartup(h.port)
    assert.equal(reply[0], 'E'.charCodeAt(0))
    assert.equal(sqlState(reply), '28000')
    const text = reply.toString('utf8')
    assert.match(text, /project blog does not accept connections from 127\.0\.0\.1/)
    assert.deepEqual(h.resolves, [])
    assert.deepEqual(h.wakes, [])
    assert.equal(h.activity.idleSeconds('res-blog'), null)
    assert.equal(h.pg.sessions.length, 0)
    assert.deepEqual(h.refusals, [{ project: 'blog', address: '127.0.0.1', via: 'startup' }])
  } finally {
    await h.close()
  }
})

test('an address inside the allowlist reaches the database over plain TCP', async () => {
  const h = await harness({ list: ['127.0.0.0/8'], state: 'sleeping', sameBox: false })
  const client = pgClient(h.port, '127.0.0.1')
  try {
    await client.connect()
    const result = await client.query('SELECT 1 AS one')
    assert.equal(result.rows[0].one, 1)
    assert.deepEqual(h.wakes, ['res-blog'])
    assert.deepEqual(h.refusals, [])
  } finally {
    await client.end().catch(() => {})
    await h.close()
  }
})

test('no allowlist means every address is accepted, as before', async () => {
  const h = await harness({ list: null, sameBox: false })
  const client = pgClient(h.port, '127.0.0.1')
  try {
    await client.connect()
    await client.query('SELECT 1 AS one')
  } finally {
    await client.end().catch(() => {})
    await h.close()
  }
})

test('the box itself is exempt: loopback is accepted even with an empty allowlist', async () => {
  // Default sameBox: a loopback peer.
  const h = await harness({ list: [] })
  const client = pgClient(h.port, '127.0.0.1')
  try {
    await client.connect()
    await client.query('SELECT 1 AS one')
    assert.deepEqual(h.refusals, [])
  } finally {
    await client.end().catch(() => {})
    await h.close()
  }
})

test('an empty allowlist refuses every address that is not the box', async () => {
  const h = await harness({ list: [], sameBox: false })
  try {
    assert.equal(sqlState(await rawStartup(h.port)), '28000')
  } finally {
    await h.close()
  }
})

test('an allowlist lookup that throws refuses rather than letting the connection through', async () => {
  const h = await harness({ list: null, sameBox: false })
  try {
    // Replace the lookup by making the list getter throw.
    Object.defineProperty(h.list, 'value', {
      get() {
        throw new Error('store unreadable')
      },
    })
    assert.equal(sqlState(await rawStartup(h.port)), '28000')
    assert.deepEqual(h.resolves, [])
  } finally {
    await h.close()
  }
})

// The TLS terminator relays from 127.0.0.1 to an inner server, so without
// the carried client record every TLS client would be judged as 127.0.0.1.
// The client here is ::1: allowed only by an entry for ::1, refused by one
// for 127.0.0.1.
test('over TLS the real client address is judged, not the terminator relay', async (t) => {
  if (!(await ipv6LoopbackWorks())) {
    t.skip('no IPv6 loopback on this machine')
    return
  }
  const h = await harness({ list: ['::1'], host: '::1', sameBox: false, tls: true })
  try {
    const allowed = pgClient(h.port, '::1', true)
    await allowed.connect()
    await allowed.query('SELECT 1 AS one')
    await allowed.end()

    h.list.value = ['127.0.0.1']
    const refused = pgClient(h.port, '::1', true)
    await assert.rejects(refused.connect(), (err: Error & { code?: string }) => {
      assert.equal(err.code, '28000')
      assert.match(err.message, /from ::1/)
      return true
    })
    await refused.end().catch(() => {})
    assert.deepEqual(h.refusals, [{ project: 'blog', address: '::1', via: 'startup' }])
  } finally {
    await h.close()
  }
})

async function ipv6LoopbackWorks(): Promise<boolean> {
  return await new Promise((resolve) => {
    const server = net.createServer()
    server.once('error', () => resolve(false))
    server.listen(0, '::1', () => server.close(() => resolve(true)))
  })
}

test('a CancelRequest from an address the project now refuses is not delivered', async () => {
  const h = await harness({ list: null, sameBox: false })
  const client = pgClient(h.port, '127.0.0.1')
  try {
    await client.connect()
    const c = client as pg.Client & { processID: number; secretKey: number }
    const key = { processId: c.processID, secretKey: c.secretKey }

    h.list.value = ['10.0.0.0/8']
    await sendCancel(h.port, key)
    await new Promise((r) => setTimeout(r, 100))
    assert.equal(h.pg.cancels, 0)
    assert.deepEqual(h.refusals, [{ project: 'blog', address: '127.0.0.1', via: 'cancel' }])

    h.list.value = ['127.0.0.1']
    await sendCancel(h.port, key)
    for (let i = 0; i < 50 && h.pg.cancels === 0; i++) await new Promise((r) => setTimeout(r, 10))
    assert.equal(h.pg.cancels, 1)
  } finally {
    await client.end().catch(() => {})
    await h.close()
  }
})

function sendCancel(port: number, key: { processId: number; secretKey: number }): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: '127.0.0.1', port })
    socket.once('connect', () => socket.write(buildCancelRequest(key)))
    socket.on('data', () => {})
    socket.on('close', () => resolve())
    socket.on('error', reject)
  })
}

function useLocal(): void {
  neonConfig.fetchEndpoint = (host, port) => `http://${host}:${port || 5432}/sql`
  neonConfig.wsProxy = (host, port) => `${host}:${port}/v2`
  neonConfig.useSecureWebSocket = false
  neonConfig.pipelineConnect = 'password'
  neonConfig.poolQueryViaFetch = false
}

const url = (port: number): string => `postgresql://app:${encodeURIComponent(PASSWORD)}@127.0.0.1:${port}/blog`

// The serverless paths hand the proxy an in-memory connection with no
// address of its own. An entry for 127.0.0.1 admitting the request is what
// shows the client's address was carried through: a lost address matches
// nothing and would be refused.
test('/sql: refused with 403 JSON before any wake, admitted when the address is listed', async () => {
  const h = await harness({ list: ['10.0.0.0/8'], state: 'sleeping', sameBox: false })
  try {
    const res = await fetch(`http://127.0.0.1:${h.port}/sql`, {
      method: 'POST',
      headers: { 'Neon-Connection-String': url(h.port), 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: 'SELECT 1 AS one', params: [] }),
    })
    assert.equal(res.status, 403)
    assert.match(res.headers.get('content-type') ?? '', /application\/json/)
    const body = (await res.json()) as { code: string; message: string }
    assert.equal(body.code, '28000')
    assert.match(body.message, /project blog does not accept connections from 127\.0\.0\.1/)
    assert.deepEqual(h.wakes, [])
    assert.equal(h.activity.idleSeconds('res-blog'), null)

    h.list.value = ['127.0.0.1']
    useLocal()
    const sql = neon(url(h.port))
    const rows = await sql`SELECT 1 AS one`
    assert.deepEqual(rows, [{ one: 1 }])
  } finally {
    await h.close()
  }
})

test('WebSocket: a refused address gets the FATAL inside the session, a listed one is served', async () => {
  const h = await harness({ list: ['10.0.0.0/8'], state: 'sleeping', sameBox: false })
  useLocal()
  try {
    const refused = new Pool({ connectionString: url(h.port) })
    refused.on('error', () => {})
    await assert.rejects(refused.query('SELECT 1 AS one'), (err: Error & { code?: string }) => {
      assert.equal(err.code, '28000')
      return true
    })
    await refused.end().catch(() => {})
    assert.deepEqual(h.wakes, [])

    h.list.value = ['127.0.0.1']
    const allowed = new Pool({ connectionString: url(h.port) })
    const { rows } = await allowed.query('SELECT 1 AS one')
    assert.deepEqual(rows, [{ one: 1 }])
    await allowed.end()
  } finally {
    await h.close()
  }
})

test('RefusalLimiter logs the first refusal per address per window and counts the rest', () => {
  let now = 0
  const limiter = new RefusalLimiter({ windowMs: 60_000, maxTracked: 2, now: () => now })
  assert.deepEqual(limiter.admit('a'), { log: true, suppressed: 0, key: 'a' })
  for (let i = 0; i < 999; i++) assert.equal(limiter.admit('a').log, false)
  now = 60_000
  assert.deepEqual(limiter.admit('a'), { log: true, suppressed: 999, key: 'a' })
  // Past the cap, new addresses share one bucket instead of growing the map.
  assert.equal(limiter.admit('b').log, true)
  assert.deepEqual(limiter.admit('c'), { log: true, suppressed: 0, key: '(other addresses)' })
  assert.equal(limiter.admit('d').log, false)
  // Once the window passes, stale entries are pruned and tracking resumes.
  now = 200_000
  assert.deepEqual(limiter.admit('e'), { log: true, suppressed: 0, key: 'e' })
})

test('refusalLogLine names the project and address and never more', () => {
  const line = refusalLogLine({ project: 'blog', address: '::ffff:203.0.113.9', via: 'startup' }, '::ffff:203.0.113.9', 3)
  assert.equal(line, 'proxy: refused a connection to project blog from 203.0.113.9, not on its allowlist; 3 more refused from it since the last line about it')
})
