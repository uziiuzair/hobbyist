// The serverless driver's pipelined password, made to work against a
// Postgres that asks for SCRAM.
//
// `@neondatabase/serverless` defaults `neonConfig.pipelineConnect` to
// "password": over a WebSocket, its Client sends the startup packet and a
// cleartext PasswordMessage together, before the server has asked for
// anything, and goes straight on to its first query. That saves round trips
// against Neon, whose proxy always answers a WebSocket client with
// AuthenticationCleartextPassword and then authenticates to the database
// itself. Hobbyist's Postgres is stock (docs/engine/CLAUDE.md) and asks for
// SCRAM-SHA-256, so the early 'p' message would reach it as a malformed
// SASLInitialResponse and the connection would fail.
//
// So this bridge does what Neon's proxy does, only when the client actually
// pipelined: it holds the early password, answers the server's challenge on
// the client's behalf (SCRAM-SHA-256, MD5 or cleartext, whichever the
// server asks for), swallows the exchange, and lets the client see the
// AuthenticationOk it is expecting. A client that does not pipeline
// (`pipelineConnect: false`) sends nothing after its startup packet until
// the server asks, and is passed through untouched, so its own SCRAM runs
// end to end with Postgres as over TCP.
//
// This means the bridge sees the password, which the TCP proxy never does
// (docs/proxy/CLAUDE.md, "Auth passes through"). It is only ever reached
// over TLS or from this machine (serverless.ts enforces that), is held in
// memory for the one handshake, and is never logged. The /sql endpoint
// necessarily sees the password too, since the driver puts it in a header.
//
// The state machine is pure: bytes in, bytes out, no sockets, so it is
// tested against a scripted server (packages/proxy/test/pipelined-auth.test.ts)
// without a Postgres.

import { createHash, createHmac, pbkdf2Sync, randomBytes, timingSafeEqual } from 'node:crypto'
import type { Duplex } from 'node:stream'
import { errorResponse, parseStartup } from './startup.js'

const AUTH_OK = 0
const AUTH_CLEARTEXT = 3
const AUTH_MD5 = 5
const AUTH_SASL = 10
const AUTH_SASL_CONTINUE = 11
const AUTH_SASL_FINAL = 12

export interface ShimOutput {
  toBackend: Buffer[]
  toClient: Buffer[]
  // Set when the handshake cannot be completed on the client's behalf; the
  // caller sends the client an ErrorResponse with this text and closes.
  fail?: string
}

type State = 'startup' | 'watch' | 'pipelined' | 'done'

interface TypedMessage {
  type: string
  body: Buffer
  raw: Buffer
}

// Splits complete typed messages (one type byte, an int32 length that
// counts itself) off the front of `buf`.
function takeMessages(buf: Buffer): { messages: TypedMessage[]; rest: Buffer } {
  const messages: TypedMessage[] = []
  let offset = 0
  while (buf.length - offset >= 5) {
    const length = buf.readInt32BE(offset + 1)
    if (length < 4) throw new Error('malformed message length')
    if (buf.length - offset < 1 + length) break
    const raw = buf.subarray(offset, offset + 1 + length)
    messages.push({ type: String.fromCharCode(raw[0]!), body: raw.subarray(5), raw })
    offset += 1 + length
  }
  return { messages, rest: buf.subarray(offset) }
}

function typedMessage(type: string, body: Buffer): Buffer {
  const header = Buffer.alloc(5)
  header.write(type, 0, 'latin1')
  header.writeInt32BE(body.length + 4, 1)
  return Buffer.concat([header, body])
}

function cstring(value: string): Buffer {
  return Buffer.concat([Buffer.from(value, 'utf8'), Buffer.from([0])])
}

const hmac = (key: Buffer, data: string): Buffer => createHmac('sha256', key).update(data).digest()

interface ScramSession {
  clientNonce: string
  clientFirstBare: string
  expectedServerSignature?: Buffer
}

export class PipelinedPasswordShim {
  private state: State = 'startup'
  private clientBuffer: Buffer = Buffer.alloc(0)
  private backendBuffer: Buffer = Buffer.alloc(0)
  // Everything the client sent after its pipelined password, held until the
  // server has accepted the login, then sent in order.
  private held: Buffer[] = []
  private user = ''
  private password: string | null = null
  private scram: ScramSession | null = null

  get done(): boolean {
    return this.state === 'done'
  }

  fromClient(chunk: Buffer): ShimOutput {
    const out: ShimOutput = { toBackend: [], toClient: [] }
    if (this.state === 'done') {
      out.toBackend.push(chunk)
      return out
    }
    if (this.state === 'pipelined') {
      this.held.push(chunk)
      return out
    }
    this.clientBuffer = this.clientBuffer.length === 0 ? chunk : Buffer.concat([this.clientBuffer, chunk])

    if (this.state === 'startup') {
      let parsed: ReturnType<typeof parseStartup>
      try {
        parsed = parseStartup(this.clientBuffer)
      } catch {
        // Not a startup packet this file understands. The proxy behind it
        // will answer with its own error; stay out of the way.
        return this.giveUp(out)
      }
      if (parsed === null) return out
      if (parsed.message.type !== 'startup') return this.giveUp(out)
      this.user = parsed.message.params['user'] ?? ''
      out.toBackend.push(this.clientBuffer.subarray(0, parsed.consumed))
      this.clientBuffer = this.clientBuffer.subarray(parsed.consumed)
      this.state = 'watch'
    }

    // 'watch': the startup packet has gone to the server and nothing the
    // server asked has reached the client. A client that sends a 'p' now
    // has pipelined its password; anything else is not ours to interpret.
    if (this.clientBuffer.length < 5) return out
    if (this.clientBuffer[0] !== 0x70 /* 'p' */) return this.giveUp(out)
    let taken: ReturnType<typeof takeMessages>
    try {
      taken = takeMessages(this.clientBuffer)
    } catch {
      return this.giveUp(out)
    }
    const first = taken.messages[0]
    if (first === undefined) return out
    const end = first.body.indexOf(0)
    this.password = first.body.toString('utf8', 0, end === -1 ? first.body.length : end)
    const rest = this.clientBuffer.subarray(first.raw.length)
    if (rest.length > 0) this.held.push(Buffer.from(rest))
    this.clientBuffer = Buffer.alloc(0)
    this.state = 'pipelined'
    // The server may already have asked, while the password was in flight.
    if (this.backendBuffer.length > 0) {
      const pending = this.backendBuffer
      this.backendBuffer = Buffer.alloc(0)
      const more = this.fromBackend(pending)
      out.toBackend.push(...more.toBackend)
      out.toClient.push(...more.toClient)
      if (more.fail !== undefined) out.fail = more.fail
    }
    return out
  }

  fromBackend(chunk: Buffer): ShimOutput {
    const out: ShimOutput = { toBackend: [], toClient: [] }
    if (this.state === 'done' || this.state === 'startup') {
      out.toClient.push(chunk)
      return out
    }
    this.backendBuffer = this.backendBuffer.length === 0 ? chunk : Buffer.concat([this.backendBuffer, chunk])
    // A pipelined password that has only partly arrived: the server's
    // challenge waits here until fromClient has the whole of it.
    if (this.state === 'watch' && this.clientBuffer.length > 0 && this.clientBuffer[0] === 0x70) return out
    let taken: ReturnType<typeof takeMessages>
    try {
      taken = takeMessages(this.backendBuffer)
    } catch {
      return this.giveUp(out)
    }
    this.backendBuffer = Buffer.from(taken.rest)

    for (let i = 0; i < taken.messages.length; i++) {
      const message = taken.messages[i]!
      if (this.state === 'done') {
        out.toClient.push(message.raw)
        continue
      }
      if (message.type !== 'R') {
        // An ErrorResponse (a wrong password, an unknown database, the
        // proxy's own wake failure) or a notice: the client gets it as is.
        // An error ends the session, so nothing held is worth sending.
        out.toClient.push(message.raw)
        if (message.type === 'E') {
          this.held = []
          this.state = 'done'
        }
        continue
      }
      const code = message.body.readInt32BE(0)
      if (this.state === 'watch') {
        // The server asked (or let the client in) before any password
        // arrived: a client that does not pipeline, which answers for
        // itself. Everything from here on passes through.
        this.state = 'done'
        out.toClient.push(message.raw)
        if (this.clientBuffer.length > 0) out.toBackend.push(this.clientBuffer)
        this.clientBuffer = Buffer.alloc(0)
        continue
      }
      const step = this.answer(code, message.body.subarray(4))
      if ('fail' in step) {
        out.fail = step.fail
        this.state = 'done'
        return out
      }
      if (step.reply !== null) out.toBackend.push(step.reply)
      if (code === AUTH_OK) {
        out.toClient.push(message.raw)
        out.toBackend.push(...this.held)
        this.held = []
        this.password = null
        this.state = 'done'
      }
    }
    if (this.state === 'done' && this.backendBuffer.length > 0) {
      out.toClient.push(this.backendBuffer)
      this.backendBuffer = Buffer.alloc(0)
    }
    return out
  }

  // The reply to one authentication request, made with the held password.
  private answer(code: number, data: Buffer): { reply: Buffer | null } | { fail: string } {
    const password = this.password
    if (code === AUTH_OK) return { reply: null }
    if (password === null) return { fail: 'the server asked for a password before the client sent one' }
    switch (code) {
      case AUTH_CLEARTEXT:
        return { reply: typedMessage('p', cstring(password)) }
      case AUTH_MD5: {
        const inner = createHash('md5').update(password + this.user).digest('hex')
        const outer = createHash('md5')
          .update(Buffer.concat([Buffer.from(inner), data.subarray(0, 4)]))
          .digest('hex')
        return { reply: typedMessage('p', cstring('md5' + outer)) }
      }
      case AUTH_SASL: {
        const mechanisms = data.toString('utf8').split('\0').filter((m) => m.length > 0)
        if (!mechanisms.includes('SCRAM-SHA-256')) {
          return { fail: `the server offers no SASL mechanism this proxy can answer for (${mechanisms.join(', ')})` }
        }
        const clientNonce = randomBytes(18).toString('base64')
        // n=* : Postgres takes the user from the startup packet and ignores
        // this one, as libpq and node-postgres both send it.
        const clientFirstBare = `n=*,r=${clientNonce}`
        this.scram = { clientNonce, clientFirstBare }
        const first = Buffer.from('n,,' + clientFirstBare, 'utf8')
        const length = Buffer.alloc(4)
        length.writeInt32BE(first.length, 0)
        return { reply: typedMessage('p', Buffer.concat([cstring('SCRAM-SHA-256'), length, first])) }
      }
      case AUTH_SASL_CONTINUE: {
        const session = this.scram
        if (session === null) return { fail: 'SASL continue without a SASL start' }
        const serverFirst = data.toString('utf8')
        const attrs = new Map(serverFirst.split(',').map((pair) => [pair.slice(0, 1), pair.slice(2)] as const))
        const nonce = attrs.get('r')
        const salt = attrs.get('s')
        const iterations = Number(attrs.get('i'))
        if (nonce === undefined || !nonce.startsWith(session.clientNonce) || nonce.length === session.clientNonce.length) {
          return { fail: 'SCRAM: the server nonce does not extend the client nonce' }
        }
        if (salt === undefined || !Number.isInteger(iterations) || iterations < 1) {
          return { fail: 'SCRAM: the server-first message is malformed' }
        }
        const salted = pbkdf2Sync(password, Buffer.from(salt, 'base64'), iterations, 32, 'sha256')
        const clientKey = hmac(salted, 'Client Key')
        const storedKey = createHash('sha256').update(clientKey).digest()
        const finalWithoutProof = `c=biws,r=${nonce}`
        const authMessage = `${session.clientFirstBare},${serverFirst},${finalWithoutProof}`
        const signature = hmac(storedKey, authMessage)
        const proof = Buffer.alloc(clientKey.length)
        for (let i = 0; i < proof.length; i++) proof[i] = clientKey[i]! ^ signature[i]!
        session.expectedServerSignature = hmac(hmac(salted, 'Server Key'), authMessage)
        return { reply: typedMessage('p', Buffer.from(`${finalWithoutProof},p=${proof.toString('base64')}`, 'utf8')) }
      }
      case AUTH_SASL_FINAL: {
        const expected = this.scram?.expectedServerSignature
        const verifier = /(?:^|,)v=([^,]+)/.exec(data.toString('utf8'))?.[1]
        const got = verifier === undefined ? Buffer.alloc(0) : Buffer.from(verifier, 'base64')
        if (expected === undefined || got.length !== expected.length || !timingSafeEqual(got, expected)) {
          return { fail: 'SCRAM: the server signature does not verify' }
        }
        return { reply: null }
      }
      default:
        return { fail: `the server asked for an authentication method this proxy cannot answer for (code ${code})` }
    }
  }

  private giveUp(out: ShimOutput): ShimOutput {
    this.state = 'done'
    if (this.clientBuffer.length > 0) out.toBackend.push(this.clientBuffer)
    this.clientBuffer = Buffer.alloc(0)
    if (this.backendBuffer.length > 0) out.toClient.push(this.backendBuffer)
    this.backendBuffer = Buffer.alloc(0)
    for (const held of this.held) out.toBackend.push(held)
    this.held = []
    return out
  }
}

// Joins a client stream (the WebSocket) to a backend stream (one side of a
// socket pair whose other side is the proxy's connection handler) through
// the shim, and hands over to plain pipes the moment the login is settled,
// so the session itself pays nothing for this.
export function bridgeWithPipelinedPassword(client: Duplex, backend: Duplex): void {
  const shim = new PipelinedPasswordShim()
  let piped = false

  const teardown = (): void => {
    if (!client.destroyed) client.destroy()
    if (!backend.destroyed) backend.destroy()
  }
  client.on('close', teardown)
  backend.on('close', teardown)
  client.on('error', teardown)
  backend.on('error', teardown)

  const apply = (out: ShimOutput): void => {
    for (const buf of out.toBackend) backend.write(buf)
    for (const buf of out.toClient) client.write(buf)
    if (out.fail !== undefined) {
      client.end(errorResponse('FATAL', '28000', out.fail))
      backend.destroy()
      return
    }
    if (shim.done && !piped) {
      piped = true
      client.off('data', onClient)
      backend.off('data', onBackend)
      client.pipe(backend)
      backend.pipe(client)
    }
  }
  const onClient = (chunk: Buffer): void => apply(shim.fromClient(chunk))
  const onBackend = (chunk: Buffer): void => apply(shim.fromBackend(chunk))
  client.on('data', onClient)
  backend.on('data', onBackend)
}
