// The serverless driver endpoints (issue #155), driven by the real
// @neondatabase/serverless client (pinned in this package's devDependencies)
// through the real proxy, against a fake Postgres that speaks SCRAM and the
// query protocols (fixtures/fake-postgres.ts). No Docker.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import https from 'node:https'
import net from 'node:net'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { neon, neonConfig, Pool, Client } from '@neondatabase/serverless'
import { ActivityTracker, SERVERLESS_APPLICATION_NAME, startPgProxy, type ProxyDeps, type ProxyTarget } from '../src/index.js'
import { FakePgError, startFakePostgres, type FakePostgres, type FakeResult } from './fixtures/fake-postgres.js'

const FIXTURES = fileURLToPath(new URL('../../test/fixtures/', import.meta.url))
const PASSWORD = 'local-test-password'

// Answers the handful of statements these tests send.
function handler(sql: string, params: Array<string | null>): FakeResult {
  const s = sql.trim()
  if (/^SELECT \$1(::int)? AS n$/i.test(s)) return { fields: [{ name: 'n', typeId: 23 }], rows: [[params[0] ?? null]], command: 'SELECT' }
  if (s === 'SELECT 1 AS one') return { fields: [{ name: 'one', typeId: 23 }], rows: [['1']], command: 'SELECT' }
  if (s === 'SELECT 2 AS two') return { fields: [{ name: 'two', typeId: 23 }], rows: [['2']], command: 'SELECT' }
  if (s === 'SELECT typed') {
    return {
      fields: [
        { name: 'i', typeId: 23 },
        { name: 'b', typeId: 16 },
        { name: 'arr', typeId: 1007 },
        { name: 'j', typeId: 3802 },
        { name: 't', typeId: 25 },
        { name: 'nothing', typeId: 25 },
      ],
      rows: [['7', 't', '{1,NULL,3}', '{"a":[1,2]}', 'hi', null]],
      command: 'SELECT',
    }
  }
  if (s === 'SELECT many') {
    return { fields: [{ name: 'x', typeId: 25 }], rows: Array.from({ length: 200 }, () => ['x'.repeat(100)]), command: 'SELECT' }
  }
  if (s === 'CREATE TABLE t ()') return { fields: [], rows: [], command: 'CREATE TABLE' }
  if (s === 'SELECT * FROM missing') {
    throw new FakePgError('42P01', 'relation "missing" does not exist', { P: '15' })
  }
  throw new FakePgError('42601', `fake postgres does not know: ${s}`)
}

interface Harness {
  pg: FakePostgres
  port: number
  wakes: string[]
  state: { value: string }
  activity: ActivityTracker
  close(): Promise<void>
}

async function harness(
  opts: { state?: string; plaintextAllowed?: (a: string | undefined) => boolean; tls?: boolean; maxResponseBytes?: number } = {}
): Promise<Harness> {
  const pg = await startFakePostgres({ password: PASSWORD, handler })
  const state = { value: opts.state ?? 'running' }
  const wakes: string[] = []
  const activity = new ActivityTracker()
  const target = (): ProxyTarget => ({
    resourceId: 'res-blog',
    label: 'blog/primary',
    host: '127.0.0.1',
    port: pg.port,
    state: state.value,
    database: 'blog',
  })
  const deps: ProxyDeps = {
    resolve: async (project) => (project === 'blog' ? target() : null),
    wake: async (id) => {
      wakes.push(id)
      state.value = 'running'
    },
    activity,
  }
  const proxy = await startPgProxy({
    port: 0,
    host: '127.0.0.1',
    deps,
    wakeTimeoutMs: 3000,
    ...(opts.plaintextAllowed === undefined ? {} : { plaintextAllowed: opts.plaintextAllowed }),
    ...(opts.tls === true ? { tls: { certFile: `${FIXTURES}first.crt`, keyFile: `${FIXTURES}first.key` } } : {}),
    ...(opts.maxResponseBytes === undefined ? {} : { serverlessLimits: { maxResponseBytes: opts.maxResponseBytes } }),
  })
  return {
    pg,
    port: proxy.port,
    wakes,
    state,
    activity,
    close: async () => {
      await proxy.close()
      await pg.close()
    },
  }
}

// How a local developer points the driver at Hobbyist on loopback: plain
// http and ws on the proxy port. The site guide shows the same settings.
function useLocal(): void {
  neonConfig.fetchEndpoint = (host, port) => `http://${host}:${port || 5432}/sql`
  neonConfig.wsProxy = (host, port) => `${host}:${port}/v2`
  neonConfig.useSecureWebSocket = false
  neonConfig.pipelineConnect = 'password'
  neonConfig.poolQueryViaFetch = false
}

function url(port: number, password = PASSWORD, extra = ''): string {
  return `postgresql://app:${encodeURIComponent(password)}@127.0.0.1:${port}/blog${extra}`
}

async function postSql(port: number, body: unknown, headers: Record<string, string>): Promise<{ status: number; json: any }> {
  const res = await fetch(`http://127.0.0.1:${port}/sql`, { method: 'POST', headers, body: JSON.stringify(body) })
  const text = await res.text()
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    json = text
  }
  return { status: res.status, json }
}

test('neon() over HTTP runs a parameterised query and the driver parses the result', async () => {
  const h = await harness()
  try {
    useLocal()
    const sql = neon(url(h.port))
    const rows = await sql`SELECT ${5} AS n`
    assert.deepEqual(rows, [{ n: 5 }])
    assert.deepEqual(h.pg.queries.at(-1), { sql: 'SELECT $1 AS n', params: ['5'] })
    // The driver names itself; the session carries that name, never 'hobby'.
    assert.match(h.pg.sessions.at(-1)?.['application_name'] ?? '', /neondatabase\/serverless/)
  } finally {
    await h.close()
  }
})

test('a request to a sleeping database wakes it, and counts as activity', async () => {
  const h = await harness({ state: 'sleeping' })
  try {
    useLocal()
    const rows = await neon(url(h.port))`SELECT 1 AS one`
    assert.deepEqual(rows, [{ one: 1 }])
    assert.deepEqual(h.wakes, ['res-blog'])
    // The request was a proxied connection: the tracker knows the resource,
    // has nothing open once the request's connection has closed (just after
    // the response is sent), and has an idle clock that started just now.
    for (let i = 0; i < 50 && h.activity.count('res-blog') > 0; i++) await new Promise((r) => setTimeout(r, 10))
    assert.equal(h.activity.count('res-blog'), 0)
    const idle = h.activity.idleSeconds('res-blog')
    assert.ok(idle !== null && idle < 5, `idle clock should be running, got ${idle}`)
  } finally {
    await h.close()
  }
})

test('transaction() runs the batch inside BEGIN with the requested options', async () => {
  const h = await harness()
  try {
    useLocal()
    const sql = neon(url(h.port))
    const [a, b] = await sql.transaction([sql`SELECT 1 AS one`, sql`SELECT 2 AS two`], {
      isolationLevel: 'Serializable',
      readOnly: true,
      deferrable: true,
    })
    assert.deepEqual(a, [{ one: 1 }])
    assert.deepEqual(b, [{ two: 2 }])
    const statements = h.pg.queries.map((q) => q.sql)
    assert.deepEqual(statements, ['BEGIN ISOLATION LEVEL SERIALIZABLE READ ONLY DEFERRABLE', 'SELECT 1 AS one', 'SELECT 2 AS two', 'COMMIT'])
  } finally {
    await h.close()
  }
})

test('a Postgres error reaches the driver as a NeonDbError with its fields', async () => {
  const h = await harness()
  try {
    useLocal()
    await assert.rejects(neon(url(h.port))`SELECT * FROM missing`, (err: any) => {
      assert.equal(err.name, 'NeonDbError')
      assert.equal(err.code, '42P01')
      assert.equal(err.position, '15')
      assert.match(err.message, /does not exist/)
      return true
    })
  } finally {
    await h.close()
  }
})

test('a wrong password is a 28P01 from Postgres, not something the endpoint decides', async () => {
  const h = await harness()
  try {
    useLocal()
    await assert.rejects(neon(url(h.port, 'wrong'))`SELECT 1 AS one`, (err: any) => err.code === '28P01')
  } finally {
    await h.close()
  }
})

test('/sql without raw text output converts values to JSON, as Neon does', async () => {
  const h = await harness()
  try {
    const { status, json } = await postSql(h.port, { query: 'SELECT typed' }, { 'Neon-Connection-String': url(h.port) })
    assert.equal(status, 200)
    assert.deepEqual(json.rows, [{ i: 7, b: true, arr: [1, null, 3], j: { a: [1, 2] }, t: 'hi', nothing: null }])
    assert.equal(json.command, 'SELECT')
    assert.equal(json.rowCount, 1)
    assert.equal(json.rowAsArray, false)
    assert.deepEqual(Object.keys(json.fields[0]).sort(), ['columnID', 'dataTypeID', 'dataTypeModifier', 'dataTypeSize', 'format', 'name', 'tableID'])

    const raw = await postSql(h.port, { query: 'SELECT typed' }, {
      'Neon-Connection-String': url(h.port),
      'Neon-Raw-Text-Output': 'true',
      'Neon-Array-Mode': 'true',
    })
    assert.deepEqual(raw.json.rows, [['7', 't', '{1,NULL,3}', '{"a":[1,2]}', 'hi', null]])
    assert.equal(raw.json.rowAsArray, true)

    const ddl = await postSql(h.port, { query: 'CREATE TABLE t ()' }, { 'Neon-Connection-String': url(h.port) })
    assert.equal(ddl.json.command, 'CREATE')
    assert.equal(ddl.json.rowCount, null)
  } finally {
    await h.close()
  }
})

test("an application_name of 'hobby' is replaced, so the activity guard never ignores driver traffic", async () => {
  const h = await harness()
  try {
    const { status } = await postSql(h.port, { query: 'SELECT 1 AS one' }, { 'Neon-Connection-String': url(h.port, PASSWORD, '?application_name=hobby') })
    assert.equal(status, 200)
    assert.equal(h.pg.sessions.at(-1)?.['application_name'], SERVERLESS_APPLICATION_NAME)
  } finally {
    await h.close()
  }
})

test('bad requests get 400s with a message; preflight and unknown paths are answered', async () => {
  const h = await harness()
  try {
    const noConn = await postSql(h.port, { query: 'SELECT 1' }, {})
    assert.equal(noConn.status, 400)
    assert.match(noConn.json.message, /Neon-Connection-String/)
    const jwt = await postSql(h.port, { query: 'SELECT 1' }, { 'Neon-Connection-String': url(h.port), Authorization: 'Bearer x' })
    assert.equal(jwt.status, 400)
    const iso = await postSql(h.port, { queries: [] }, { 'Neon-Connection-String': url(h.port), 'Neon-Batch-Isolation-Level': 'Nope' })
    assert.equal(iso.json.message, 'invalid isolation level')
    const unknown = await postSql(h.port, { query: 'SELECT 1' }, { 'Neon-Connection-String': url(h.port).replace('/blog', '/nope') })
    assert.equal(unknown.status, 400)
    assert.equal(unknown.json.code, '3D000')

    const pre = await fetch(`http://127.0.0.1:${h.port}/sql`, { method: 'OPTIONS' })
    assert.equal(pre.status, 200)
    assert.equal(pre.headers.get('access-control-allow-origin'), '*')
    assert.match(pre.headers.get('access-control-allow-headers') ?? '', /Neon-Connection-String/)
    const other = await fetch(`http://127.0.0.1:${h.port}/`)
    assert.equal(other.status, 404)
    await other.text()
  } finally {
    await h.close()
  }
})

test('a response over the cap is a 507', async () => {
  const h = await harness({ maxResponseBytes: 2000 })
  try {
    const { status, json } = await postSql(h.port, { query: 'SELECT many' }, { 'Neon-Connection-String': url(h.port) })
    assert.equal(status, 507)
    assert.match(json.message, /too large/)
  } finally {
    await h.close()
  }
})

test('Pool over a WebSocket works with the default pipelined password against SCRAM', async () => {
  const h = await harness({ state: 'sleeping' })
  try {
    useLocal()
    const pool = new Pool({ connectionString: url(h.port) })
    try {
      const { rows } = await pool.query('SELECT $1::int AS n', [42])
      assert.deepEqual(rows, [{ n: 42 }])
      // A second query on the same pooled session.
      const again = await pool.query('SELECT 1 AS one')
      assert.deepEqual(again.rows, [{ one: 1 }])
      assert.deepEqual(h.wakes, ['res-blog'])
      assert.equal(h.activity.count('res-blog'), 1, 'the pooled WebSocket session is a live proxied connection')
    } finally {
      await pool.end()
    }
  } finally {
    await h.close()
  }
})

test('Client over a WebSocket with pipelineConnect off does SCRAM itself, end to end', async () => {
  const h = await harness()
  try {
    useLocal()
    neonConfig.pipelineConnect = false
    const client = new Client(url(h.port))
    await client.connect()
    try {
      const { rows } = await client.query('SELECT $1::int AS n', [9])
      assert.deepEqual(rows, [{ n: 9 }])
    } finally {
      await client.end()
    }
  } finally {
    await h.close()
  }
})

test('Pool with a wrong password fails with 28P01', async () => {
  const h = await harness()
  try {
    useLocal()
    const pool = new Pool({ connectionString: url(h.port, 'wrong') })
    pool.on('error', () => {})
    try {
      await assert.rejects(pool.query('SELECT 1 AS one'), (err: any) => err.code === '28P01')
    } finally {
      await pool.end().catch(() => {})
    }
  } finally {
    await h.close()
  }
})

test('Pool.query with poolQueryViaFetch goes over /sql', async () => {
  const h = await harness()
  try {
    useLocal()
    neonConfig.poolQueryViaFetch = true
    // The driver builds this request's URL without the port (Pool.query in
    // @neondatabase/serverless 1.2.0), so fetchEndpoint must supply it.
    neonConfig.fetchEndpoint = (host) => `http://${host}:${h.port}/sql`
    const pool = new Pool({ connectionString: url(h.port) })
    const { rows } = await pool.query('SELECT $1::int AS n', [3])
    assert.deepEqual(rows, [{ n: 3 }])
    await pool.end()
  } finally {
    neonConfig.poolQueryViaFetch = false
    await h.close()
  }
})

test('plaintext from another machine is refused for /sql and for WebSockets', async () => {
  // plaintextAllowed false plays a peer that is not on loopback.
  const h = await harness({ plaintextAllowed: () => false })
  try {
    const { status, json } = await postSql(h.port, { query: 'SELECT 1 AS one' }, { 'Neon-Connection-String': url(h.port) })
    assert.equal(status, 403)
    assert.match(json.message, /requires TLS/)
    assert.match(json.message, /proxyTls/)
    assert.equal(h.pg.sessions.length, 0, 'no session was opened')

    const raw = await new Promise<string>((resolve, reject) => {
      const s = net.connect(h.port, '127.0.0.1', () => {
        s.write(
          'GET /v2 HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n'
        )
      })
      let got = ''
      s.on('data', (d) => (got += d))
      s.on('close', () => resolve(got))
      s.on('error', reject)
    })
    assert.match(raw, /^HTTP\/1\.1 403 /)
  } finally {
    await h.close()
  }
})

test('https:// on the same port, with the proxy certificate, is allowed from another machine', async () => {
  const h = await harness({ tls: true, plaintextAllowed: () => false })
  try {
    const body = JSON.stringify({ query: 'SELECT 1 AS one' })
    const result = await new Promise<{ status: number; text: string }>((resolve, reject) => {
      const req = https.request(
        {
          host: '127.0.0.1',
          port: h.port,
          path: '/sql',
          method: 'POST',
          servername: 'first.test',
          ca: readFileSync(`${FIXTURES}first.crt`),
          // The chain is still checked against the fixture certificate. The
          // name check is skipped because Bun 1.3.5's https.request checks
          // the IP, not `servername`, against the certificate's names.
          checkServerIdentity: () => undefined,
          headers: { 'Neon-Connection-String': url(h.port), 'Neon-Raw-Text-Output': 'true', 'Content-Type': 'application/json' },
        },
        (res) => {
          let text = ''
          res.on('data', (d) => (text += d))
          res.on('end', () => resolve({ status: res.statusCode ?? 0, text }))
        }
      )
      req.on('error', reject)
      req.end(body)
    })
    assert.equal(result.status, 200, result.text)
    assert.deepEqual(JSON.parse(result.text).rows, [{ one: '1' }])

    // Plaintext to the same TLS-enabled port from "another machine" is still refused.
    const plain = await postSql(h.port, { query: 'SELECT 1 AS one' }, { 'Neon-Connection-String': url(h.port) })
    assert.equal(plain.status, 403)
    assert.match(plain.json.message, /https:\/\//)
  } finally {
    await h.close()
  }
})

test('an ordinary Postgres client on the same port is unaffected', async () => {
  const h = await harness({ state: 'sleeping' })
  try {
    // node-postgres over plain TCP, as before this change.
    const pg = (await import('pg')).default
    const client = new pg.Client({ host: '127.0.0.1', port: h.port, user: 'app', password: PASSWORD, database: 'blog' })
    await client.connect()
    const { rows } = await client.query('SELECT 1 AS one')
    assert.deepEqual(rows, [{ one: 1 }])
    await client.end()
    assert.deepEqual(h.wakes, ['res-blog'])
  } finally {
    await h.close()
  }
})

test('a WebSocket upgrade on a connection that already carried a /sql request is answered', async () => {
  // Node's fetch and WebSocket share undici's pool and do reuse a kept-alive
  // /sql connection for the upgrade; this plays that on one raw socket.
  const h = await harness()
  try {
    const socket = net.connect(h.port, '127.0.0.1')
    await new Promise((r) => socket.once('connect', r))
    let received = Buffer.alloc(0)
    socket.on('data', (d: Buffer) => (received = Buffer.concat([received, d])))
    const waitFor = async (pattern: RegExp): Promise<void> => {
      for (let i = 0; i < 200 && !pattern.test(received.toString('latin1')); i++) await new Promise((r) => setTimeout(r, 10))
      assert.match(received.toString('latin1'), pattern)
    }
    const body = JSON.stringify({ query: 'SELECT 1 AS one' })
    socket.write(
      `POST /sql HTTP/1.1\r\nHost: x\r\nConnection: keep-alive\r\nNeon-Connection-String: ${url(h.port)}\r\nContent-Length: ${body.length}\r\n\r\n${body}`
    )
    await waitFor(/"rows":\[\{"one":1\}\]/)
    received = Buffer.alloc(0)
    socket.write(
      'GET /v2 HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n'
    )
    await waitFor(/^HTTP\/1\.1 101 /)
    // A startup packet in a masked binary frame reaches Postgres, which asks
    // for SCRAM: the session is live.
    const params = Buffer.from('user\0app\0database\0blog\0\0')
    const startupPacket = Buffer.alloc(8)
    startupPacket.writeInt32BE(8 + params.length, 0)
    startupPacket.writeInt32BE(196608, 4)
    const payload = Buffer.concat([startupPacket, params])
    const mask = Buffer.from([9, 8, 7, 6])
    socket.write(Buffer.concat([Buffer.from([0x82, 0x80 | payload.length]), mask, Buffer.from(payload.map((b, i) => b ^ mask[i & 3]!))]))
    await waitFor(/SCRAM-SHA-256/)
    socket.destroy()
  } finally {
    await h.close()
  }
})

// Phase A3 (2026-11-18): the daemon holds a wake for as long as it is
// restarting a database on purpose (a settings change, a branch's quiesce;
// buildWake's fence in packages/cli/src/daemon/context.ts). From the proxy's
// side that is a wake() that does not settle until the restart is done, and
// the restarted container may be on a new port. These pin that the
// serverless path rides the same hold as a plain Postgres client: /sql
// waits and is served, and a restart that fails is the request's error.
async function restartHarness(initialState: string): Promise<{
  port: number
  wakes: string[]
  beginRestart: () => Promise<void>
  finishRestart: () => Promise<void>
  failRestart: (message: string) => void
  close: () => Promise<void>
}> {
  let pg: FakePostgres | null = await startFakePostgres({ password: PASSWORD, handler })
  let pgPort = pg.port
  const state = { value: 'running' }
  const wakes: string[] = []
  let settle: { resolve: () => void; reject: (err: Error) => void } | null = null
  const restart = new Promise<void>((resolve, reject) => (settle = { resolve, reject }))
  restart.catch(() => {})
  const deps: ProxyDeps = {
    resolve: async (project) =>
      project === 'blog'
        ? { resourceId: 'res-blog', label: 'blog/primary', host: '127.0.0.1', port: pgPort, state: state.value, database: 'blog' }
        : null,
    wake: async (id) => {
      wakes.push(id)
      await restart
    },
    activity: new ActivityTracker(),
  }
  const proxy = await startPgProxy({ port: 0, host: '127.0.0.1', deps, wakeTimeoutMs: 3000 })
  return {
    port: proxy.port,
    wakes,
    beginRestart: async () => {
      await pg?.close()
      pg = null
      state.value = initialState
    },
    finishRestart: async () => {
      pg = await startFakePostgres({ password: PASSWORD, handler })
      pgPort = pg.port
      state.value = 'running'
      settle?.resolve()
    },
    failRestart: (message) => {
      state.value = 'failed'
      settle?.reject(new Error(message))
    },
    close: async () => {
      await proxy.close()
      await pg?.close()
    },
  }
}

for (const initialState of ['stopping', 'running']) {
  test(`a /sql request during a restart (store says ${initialState}) waits, and is served by the restarted database`, async () => {
    const h = await restartHarness(initialState)
    try {
      useLocal()
      await h.beginRestart()
      let settled = false
      const query = Promise.resolve(neon(url(h.port))`SELECT 1 AS one`).then((rows) => {
        settled = true
        return rows
      })
      await new Promise((resolve) => setTimeout(resolve, 150))
      assert.equal(settled, false, 'held, not refused')
      await h.finishRestart()
      assert.deepEqual(await query, [{ one: 1 }])
      assert.deepEqual(h.wakes, ['res-blog'])
    } finally {
      await h.close()
    }
  })
}

test('a /sql request waiting on a restart that fails gets that failure as its error', async () => {
  const h = await restartHarness('stopping')
  try {
    useLocal()
    await h.beginRestart()
    const query = Promise.resolve(neon(url(h.port))`SELECT 1 AS one`)
    await new Promise((resolve) => setTimeout(resolve, 100))
    const started = Date.now()
    h.failRestart('blog/primary was restarted by a settings change, and did not come back: container exited immediately')
    await assert.rejects(query, /was restarted by a settings change, and did not come back/)
    assert.ok(Date.now() - started < 1500, 'answered when the restart failed, not at the wake timeout')
  } finally {
    await h.close()
  }
})
