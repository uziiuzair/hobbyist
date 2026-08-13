// deliverBatch against real sockets, no fakes: the whole point of this file
// is the transport, so a mocked fetch would hide exactly the bugs worth
// finding here (the same reasoning worker.test.ts's realHttpServer comment
// gives for using real sockets over a probe mock).

import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { after, test } from 'node:test'
import type { LeasedBatch } from '../src/broker.js'
import { deliverBatch } from '../src/deliver.js'

const servers: Server[] = []
after(async () => {
  await Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))))
})

function listen(server: Server): Promise<number> {
  servers.push(server)
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      resolve(typeof address === 'object' && address !== null ? address.port : 0)
    })
  })
}

const BATCH: LeasedBatch = {
  leaseId: 'lease-1',
  messages: [{ id: 'msg-1', body: '{"a":1}', contentType: 'json', timestampMs: 1_786_375_171_389, attempts: 1 }],
  backlogCount: 0,
  backlogBytes: 0,
  oldestMessageTimestampMs: null,
}

test('a real QueueResponse round-trips: outcome, retryBatch and retryMessages all pass through', async () => {
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { queue: string }
      assert.equal(parsed.queue, 'jobs')
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          outcome: 'ok',
          ackAll: false,
          retryBatch: { retry: false },
          explicitAcks: [],
          retryMessages: [],
        })
      )
    })
  })
  const port = await listen(server)

  const result = await deliverBatch(port, BATCH, 'jobs')
  assert.deepEqual(result, { outcome: 'ok', retryBatch: { retry: false }, retryMessages: [] })
})

test('a non-2xx status becomes an exception result rather than throwing', async () => {
  const server = createServer((_req, res) => {
    res.writeHead(500, { 'content-type': 'application/json' })
    res.end('{"error":"boom"}')
  })
  const port = await listen(server)

  const result = await deliverBatch(port, BATCH, 'jobs')
  assert.equal(result.outcome, 'exception')
  assert.equal(result.retryBatch.retry, false)
  assert.deepEqual(result.retryMessages, [])
})

test('a body that is not a QueueResponse becomes an exception result', async () => {
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end('{"not":"a queue response"}')
  })
  const port = await listen(server)

  const result = await deliverBatch(port, BATCH, 'jobs')
  assert.equal(result.outcome, 'exception')
})

test('nothing listening on the port becomes an exception result, not a throw', async () => {
  // A real server, closed immediately, so the port is refused rather than
  // merely unlikely to be in use.
  const server = createServer(() => {})
  const port = await listen(server)
  await new Promise<void>((resolve) => server.close(() => resolve()))

  const result = await deliverBatch(port, BATCH, 'jobs')
  assert.equal(result.outcome, 'exception')
})

// The regression this task's review caught: a consumer that accepts the
// connection and never answers (hung user code, a deadlocked container) must
// not leave this function's promise pending forever. timeoutMs is passed
// explicitly here, short, so this test proves the real AbortSignal.timeout
// mechanism against a real hung socket without waiting out
// DELIVERY_TIMEOUT_MS (LEASE_MS / 2, 30 real seconds) in the suite.
test('a consumer that never responds is aborted, and returns an exception result rather than hanging forever', async () => {
  const server = createServer(() => {
    // Deliberately never calls res.end() or res.writeHead(): the request
    // just sits open, exactly what a deadlocked queue() handler looks like
    // from the daemon's side of the socket.
  })
  const port = await listen(server)

  const started = Date.now()
  const result = await deliverBatch(port, BATCH, 'jobs', 50)
  const elapsedMs = Date.now() - started

  assert.deepEqual(result, { outcome: 'exception', retryBatch: { retry: false }, retryMessages: [] })
  // Bounded by the injected timeout, not by the test's own runner timeout:
  // proves the abort fired on schedule rather than the request eventually
  // failing for some unrelated reason.
  assert.ok(elapsedMs < 2000, `expected the abort well under 2s, took ${elapsedMs}ms`)
})
