// The listener a worker's container POSTs to when user code calls
// env.MY_QUEUE.send() / .sendBatch(). ADR 0013 accepted that this is the
// first listener in the project to leave 127.0.0.1
// (docs/decisions/0013-queues-and-the-broker-outside-the-runtime.md,
// "Consequences accepted"): on Linux, host.docker.internal resolves to the
// bridge gateway address, not loopback, and a socket bound only to
// 127.0.0.1 never sees that traffic
// (docs/queues/research/2026-08-13-miniflare-queues-are-in-memory.md,
// section 3, the transport probes). Which addresses to bind is a platform
// fact the daemon knows and this file deliberately does not: opts.hosts is
// how that fact arrives, so a test can drive it with plain loopback and
// nothing in here has to guess an operating system.
//
// One route, POST /enqueue, and nothing else. This endpoint is a security
// boundary: ADR 0013 says plainly that "a compromised container should be
// able to add a message to a queue it was granted, not read the store or
// destroy a project." So this file deliberately does not import or mount
// the daemon's main router (routes.ts). A container that reaches this port
// at all can only ever do the one thing this file lets it do.
//
// Not wired into startDaemon here. That wiring, and the platform detection
// that decides opts.hosts for real, is Task 15's: see this task's own
// report for why.

import { createHash, timingSafeEqual as cryptoTimingSafeEqual } from 'node:crypto'
import http, { type IncomingMessage, type ServerResponse } from 'node:http'
import { HobbyError, type Resource } from '@hobby.sh/core'
import { enqueue, openQueueDb, queueDbPath, type ContentType, type EnqueueInput } from '@hobby.sh/queue'
import type { DaemonContext } from './context.js'

const ROUTE = '/enqueue'

// Defense in depth, not the source of truth for any queue semantic:
// @hobby.sh/queue's own enqueue() (packages/queue/src/broker.ts) already
// enforces MAX_MESSAGE_BYTES (128000) per message and MAX_BATCH_BYTES
// (288000) per batch, and its HobbyError is what turns into the 400 below.
// This cap exists only so a request nobody has validated yet cannot be used
// to run the daemon out of memory. Worst case: 100 messages (MAX_BATCH_COUNT)
// each JSON-escaped so every raw byte becomes a 6-byte \uXXXX sequence, on
// top of MAX_BATCH_BYTES's 288000-byte ceiling on raw content, is roughly
// 1.7 MiB; 2 MiB leaves headroom over that without meaningfully raising the
// memory an attacker who never intends to send a valid batch can force.
const MAX_REQUEST_BODY_BYTES = 2 * 1024 * 1024

const VALID_CONTENT_TYPES: ReadonlySet<string> = new Set<ContentType>(['json', 'text', 'bytes', 'v8'])

export interface QueueEndpointOptions {
  port: number
  // Every address to bind, verbatim: loopback for macOS/OrbStack, plus the
  // project network's bridge gateway on Linux. See this file's header
  // comment and ADR 0013 for why detecting the platform does not belong
  // here. Must hold at least one address.
  hosts: string[]
  // token -> resourceId, or null for an unknown token. A fast index the
  // daemon maintains; it is deliberately NOT this file's only line of
  // defense. See authenticate() below for why the pass/fail decision does
  // not simply trust this function's answer.
  tokenFor: (token: string) => string | null
}

export interface QueueEndpointHandle {
  port: number
  // Returns true if this call bound the address, false if it was already
  // bound or could not be. See the implementation for why a failure here is
  // logged rather than thrown.
  addHost(host: string): Promise<boolean>
  stop(): Promise<void>
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(body)
}

// Both use fixed, generic bodies. Neither ever carries the presented token
// or anything else about the store: "the response and any error must never
// echo the token back" is a requirement on the whole file, and the surest
// way to keep it true is for these two shapes to never be given anything to
// echo in the first place.
function send401(res: ServerResponse): void {
  sendJson(res, 401, { error: { code: 'unauthorized', message: 'unauthorized' } })
}

function send404(res: ServerResponse): void {
  sendJson(res, 404, { error: { code: 'not_found', message: 'not found' } })
}

// Compares two strings without leaking their content, or even their
// relative length, through timing. Hashing first fixes the buffers
// crypto.timingSafeEqual actually compares at 32 bytes regardless of each
// input's own length: comparing raw, unequal-length buffers would either
// throw (node:crypto requires equal-length inputs) or have to be
// special-cased in a way that itself leaks the length mismatch instantly,
// before a single byte of content is compared.
function timingSafeEqual(a: string, b: string): boolean {
  const digestA = createHash('sha256').update(a, 'utf8').digest()
  const digestB = createHash('sha256').update(b, 'utf8').digest()
  return cryptoTimingSafeEqual(digestA, digestB)
}

function extractBearerToken(header: string | string[] | undefined): string | null {
  if (typeof header !== 'string') {
    return null
  }
  const prefix = 'Bearer '
  if (!header.startsWith(prefix)) {
    return null
  }
  const token = header.slice(prefix.length)
  return token.length === 0 ? null : token
}

// Resolves the presented bearer token to the worker resource it
// authenticates, or null on any failure. opts.tokenFor is a fast index
// (token -> resourceId) the daemon maintains for lookup speed; it is
// deliberately not the last word. The actual pass/fail decision compares
// the presented token against ctx.store's own record of that resource's
// WorkerConfig.queueToken (core/src/types.ts), using timingSafeEqual above,
// so this endpoint's security does not depend on opts.tokenFor's own
// implementation having been written carefully: even a tokenFor backed by a
// naive linear scan cannot turn into a wrong resource being authenticated,
// only, at worst, into its own timing leak about the index, which this
// file's own comparison cannot fix from outside that closure.
function authenticate(
  ctx: DaemonContext,
  opts: QueueEndpointOptions,
  header: string | string[] | undefined
): Resource | null {
  const presented = extractBearerToken(header)
  if (presented === null) {
    return null
  }
  const resourceId = opts.tokenFor(presented)
  if (resourceId === null) {
    return null
  }
  const resource = ctx.store.getResource(resourceId)
  if (resource === null || resource.kind !== 'worker') {
    return null
  }
  if (!timingSafeEqual(resource.config.queueToken, presented)) {
    return null
  }
  return resource
}

// Same shape as routes.ts's own readJsonBody, with its own size ceiling:
// routes.ts's 64 KiB limit is sized for control-plane bodies (names,
// config), not a queue batch that can legitimately carry close to 288000
// bytes of message content. Kept as a private copy rather than imported,
// since this file must not depend on routes.ts (see the header comment).
function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    let settled = false

    const fail = (err: Error): void => {
      if (settled) return
      settled = true
      reject(err)
    }

    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_REQUEST_BODY_BYTES) {
        fail(new HobbyError('usage', `request body exceeds ${MAX_REQUEST_BODY_BYTES} bytes`))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })

    req.on('end', () => {
      if (settled) return
      if (chunks.length === 0) {
        settled = true
        resolve({})
        return
      }
      try {
        const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        settled = true
        resolve(parsed)
      } catch {
        fail(new HobbyError('usage', 'invalid JSON body'))
      }
    })

    req.on('error', fail)
  })
}

interface EnqueueRequestBody {
  queue: string
  messages: EnqueueInput[]
}

// Structural validation only: whether a batch is too big, a message too
// long, or a delay out of range is @hobby.sh/queue's own enqueue() to
// decide (packages/queue/src/broker.ts), and its HobbyError is what the
// caller of this function turns into the 400 response. What belongs here is
// purely "is this JSON shaped like an enqueue request at all," so a
// malformed body becomes a 400 with a plain message rather than a
// TypeError reaching the top-level catch as an unexplained 500.
function parseEnqueueRequest(raw: unknown): EnqueueRequestBody {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new HobbyError('usage', 'request body must be a JSON object')
  }
  const record = raw as Record<string, unknown>

  const queue = record['queue']
  if (typeof queue !== 'string' || queue.length === 0) {
    throw new HobbyError('usage', 'queue is required and must be a non-empty string')
  }

  const rawMessages = record['messages']
  if (!Array.isArray(rawMessages)) {
    throw new HobbyError('usage', 'messages must be an array')
  }

  const messages: EnqueueInput[] = rawMessages.map((entry, index) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new HobbyError('usage', `messages[${index}] must be an object`)
    }
    const message = entry as Record<string, unknown>

    const body = message['body']
    if (typeof body !== 'string') {
      throw new HobbyError('usage', `messages[${index}].body must be a string`)
    }

    const contentType = message['contentType']
    if (typeof contentType !== 'string' || !VALID_CONTENT_TYPES.has(contentType)) {
      throw new HobbyError('usage', `messages[${index}].contentType must be one of json, text, bytes, v8`)
    }

    const delaySeconds = message['delaySeconds']
    if (delaySeconds === undefined) {
      return { body, contentType: contentType as ContentType }
    }
    if (typeof delaySeconds !== 'number') {
      throw new HobbyError('usage', `messages[${index}].delaySeconds must be a number`)
    }
    return { body, contentType: contentType as ContentType, delaySeconds }
  })

  return { queue, messages }
}

// Steps 1 through 3 of the task's order of operations. Never catches: the
// dispatcher built in createHandler is the single place a throw becomes a
// wire-shaped response, exactly the split routes.ts uses between dispatch
// and handleRequest.
async function handleEnqueue(
  ctx: DaemonContext,
  opts: QueueEndpointOptions,
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  // Step 1: authenticate. A resource id resolved by opts.tokenFor is not
  // enough on its own; see authenticate()'s own comment for why the
  // constant-time compare against ctx.store happens regardless.
  const resource = authenticate(ctx, opts, req.headers.authorization)
  if (resource === null) {
    send401(res)
    return
  }

  const body = parseEnqueueRequest(await readJsonBody(req))

  // Step 2: resolve the named queue inside the AUTHENTICATED resource's own
  // project, never a project named by the request body (there is none) or
  // guessed any other way. This is the cross-project isolation guarantee
  // ADR 0013 requires: which project a token can name a queue in is fixed
  // by which worker the token belongs to, not by anything the caller sends.
  const queueResource = ctx.store.getResourceByName(resource.projectId, body.queue)
  if (queueResource === null || queueResource.kind !== 'queue') {
    send404(res)
    return
  }

  const project = ctx.store.getProject(resource.projectId)
  if (project === null) {
    // The resource we just authenticated against names a project that no
    // longer exists: an invariant violation, not a request the caller can
    // fix by sending something different, so it falls through to the
    // dispatcher's generic 500 like any other unexpected throw. Same
    // reasoning @hobby.sh/queue's own kind.ts pathFor uses for this exact
    // case.
    throw new Error(`resource ${resource.id} names project ${resource.projectId}, which does not exist`)
  }

  // Step 3: open the queue db, call enqueue, reply. A HobbyError from
  // enqueue (the byte, count and delaySeconds limits) is left to propagate;
  // the dispatcher turns it into a 400 with its message, per step 4.
  const db = openQueueDb(queueDbPath(ctx.paths, project.name, queueResource.name))
  try {
    const ids = enqueue(db, body.messages, Date.now())
    sendJson(res, 200, { ids })
  } finally {
    db.close()
  }
}

// The one dispatcher, shared by every bound host. Everything other than
// POST /enqueue is 404, checked before anything else runs: no auth check,
// no body read, nothing that could give a stranger probing this port any
// signal beyond "not found."
function createHandler(ctx: DaemonContext, opts: QueueEndpointOptions): (req: IncomingMessage, res: ServerResponse) => void {
  return (req, res) => {
    const path = (req.url ?? '').split('?')[0]
    if (req.method !== 'POST' || path !== ROUTE) {
      send404(res)
      return
    }

    handleEnqueue(ctx, opts, req, res).catch((err: unknown) => {
      if (res.headersSent || res.writableEnded) {
        return
      }
      if (err instanceof HobbyError) {
        sendJson(res, err.httpStatus, err.toWire())
        return
      }
      // Step 4: any other throw is a 500 that does not leak internals. The
      // detail is logged for whoever runs the daemon and never repeated to
      // the caller, the same split routes.ts's own toHobbyError uses.
      console.error(`queue endpoint: unexpected error handling POST ${ROUTE}: ${errorMessage(err)}`)
      sendJson(res, 500, { error: { code: 'internal', message: 'internal error' } })
    })
  }
}

function listen(server: http.Server, host: string, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, () => {
      server.off('error', reject)
      resolve()
    })
  })
}

function resolvedPort(server: http.Server, fallback: number): number {
  const address = server.address()
  return typeof address === 'object' && address !== null ? address.port : fallback
}

function closeServer(server: http.Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.closeAllConnections?.()
    server.close((err) => (err ? reject(err) : resolve()))
  })
}

// Binds one http.Server per opts.hosts entry, all serving the same handler
// on the same port. The first bind decides the real port when opts.port is
// 0 (a test asking the OS for a free one, or an ephemeral default); every
// other host then binds that SAME resolved port rather than another 0,
// because a container reaching this endpoint on a second interface (the
// Linux bridge gateway, see this file's header comment) has to find it on
// the one port it was told to expect.
export async function startQueueEndpoint(ctx: DaemonContext, opts: QueueEndpointOptions): Promise<QueueEndpointHandle> {
  const firstHost = opts.hosts[0]
  if (firstHost === undefined) {
    throw new Error('startQueueEndpoint requires opts.hosts to name at least one address')
  }

  const handler = createHandler(ctx, opts)
  const servers: http.Server[] = []
  let port = opts.port

  // A later host failing to bind (a Linux gateway address that turns out
  // not to exist on this box, e.g.) must not leak the sockets already
  // opened for earlier hosts: without the catch below, a rejected promise
  // here would abandon `servers` with no reference left to close them,
  // and an open listener keeps the daemon's event loop, or a test runner's
  // process, from ever going idle.
  try {
    const first = http.createServer(handler)
    await listen(first, firstHost, opts.port)
    servers.push(first)
    port = resolvedPort(first, opts.port)

    for (const host of opts.hosts.slice(1)) {
      const server = http.createServer(handler)
      await listen(server, host, port)
      servers.push(server)
    }
  } catch (err) {
    await Promise.all(servers.map((server) => closeServer(server).catch(() => undefined)))
    throw err
  }

  const bound = new Set(opts.hosts)

  return {
    port,
    // Binds one more address after startup (ADR 0013's Linux gap, measured in
    // docs/queues/research/2026-08-22-the-producer-path-on-real-linux.md).
    //
    // The host set used to be a snapshot taken once, over the projects that
    // existed at that moment, which meant the ordinary sequence of install,
    // start the daemon, then create a project left every project's bridge
    // gateway unbound until the next restart. A producer resolving
    // host.docker.internal to that gateway reached nothing.
    //
    // Idempotent, and deliberately forgiving: a gateway that cannot be bound
    // is logged and skipped rather than thrown, because failing to add one
    // address must not take down an endpoint that is already serving others.
    async addHost(host: string): Promise<boolean> {
      if (bound.has(host)) {
        return false
      }
      const server = http.createServer(handler)
      try {
        await listen(server, host, port)
      } catch (err) {
        await closeServer(server).catch(() => undefined)
        console.error(`queue endpoint: could not also listen on ${host}: ${err instanceof Error ? err.message : String(err)}`)
        return false
      }
      servers.push(server)
      bound.add(host)
      return true
    },
    async stop(): Promise<void> {
      await Promise.all(servers.map(closeServer))
    },
  }
}
