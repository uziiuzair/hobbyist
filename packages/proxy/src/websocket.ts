// A small server-side WebSocket (RFC 6455), written here rather than taken
// from a library, for the serverless driver's Pool and Client (serverless.ts).
//
// Why hand-written. The obvious route is node:http's 'upgrade' event plus a
// framing library, and under Bun it does not work: the event fires, and every
// byte written to the upgraded socket is lost (measured on Bun 1.3.5 and
// 1.3.14, 2026-11-17, with a plain `socket.write` and with a pipe; Node
// delivers both). The daemon runs on Bun (ADR 0006). `ws` would not help,
// since it sits on the same event. So the handshake is read off the raw
// socket the proxy accepted, and the framing is what remains, which is small:
// the driver sends and expects binary messages only, and needs no
// extensions, no subprotocol and no compression. ADR 0006's question of a
// runtime dependency against a hand-written framer answers itself here.
//
// Scope, matching what Neon's proxy accepts (proxy/src/serverless/
// websocket.rs): binary and continuation frames carry the Postgres byte
// stream, a text frame is a protocol error, ping is answered with pong,
// close is echoed and ends the stream. Client frames must be masked
// (RFC 6455 section 5.1).

import { createHash } from 'node:crypto'
import { Duplex } from 'node:stream'

const WEBSOCKET_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

// A request head larger than this is refused. Browsers and fetch send well
// under 8 KiB; the cap only bounds what a client can make the proxy buffer
// before it has said anything useful.
export const MAX_HTTP_HEAD_BYTES = 16 * 1024

// The largest single frame accepted. The Postgres protocol allows messages
// far larger, and the driver sends each write as one message, so this is a
// cap on one query's text plus parameters. Generous for a real application,
// and it bounds memory for one connection.
export const MAX_FRAME_BYTES = 64 * 1024 * 1024

export const OPCODE_CONTINUATION = 0x0
export const OPCODE_TEXT = 0x1
export const OPCODE_BINARY = 0x2
export const OPCODE_CLOSE = 0x8
export const OPCODE_PING = 0x9
export const OPCODE_PONG = 0xa

export const CLOSE_NORMAL = 1000
export const CLOSE_PROTOCOL_ERROR = 1002
export const CLOSE_UNSUPPORTED_DATA = 1003
export const CLOSE_TOO_BIG = 1009

export function websocketAccept(key: string): string {
  return createHash('sha1')
    .update(key + WEBSOCKET_GUID)
    .digest('base64')
}

export interface HttpHead {
  method: string
  target: string
  version: string
  // Lowercased names. A repeated header keeps its last value, which is all
  // the handshake needs.
  headers: Map<string, string>
  // Bytes up to and including the blank line. Anything after it belongs to
  // the body or, after a handshake, to the WebSocket.
  length: number
}

// null while the blank line ending the head has not arrived yet. Throws on a
// head that is too large or not HTTP/1.x at all.
export function parseHttpHead(buffer: Buffer): HttpHead | null {
  const end = buffer.indexOf('\r\n\r\n')
  if (end === -1) {
    if (buffer.length > MAX_HTTP_HEAD_BYTES) throw new Error('request head too large')
    return null
  }
  if (end > MAX_HTTP_HEAD_BYTES) throw new Error('request head too large')
  const lines = buffer.toString('latin1', 0, end).split('\r\n')
  const requestLine = lines.shift() ?? ''
  const match = /^([A-Z]+) (\S+) (HTTP\/1\.[01])$/.exec(requestLine)
  if (match === null) throw new Error('malformed request line')
  const headers = new Map<string, string>()
  for (const line of lines) {
    const colon = line.indexOf(':')
    if (colon <= 0) throw new Error('malformed header line')
    headers.set(line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim())
  }
  return { method: match[1]!, target: match[2]!, version: match[3]!, headers, length: end + 4 }
}

function headerHasToken(value: string | undefined, token: string): boolean {
  if (value === undefined) return false
  return value
    .split(',')
    .map((part) => part.trim().toLowerCase())
    .includes(token)
}

// A WebSocket opening handshake per RFC 6455 section 4.2.1, or the reason it
// is not one. `null` means "not an upgrade request at all", which the caller
// treats as plain HTTP.
export function checkUpgrade(head: HttpHead): { key: string } | { error: string } | null {
  if (!headerHasToken(head.headers.get('upgrade'), 'websocket')) return null
  if (head.method !== 'GET') return { error: 'a WebSocket upgrade must be a GET' }
  if (!headerHasToken(head.headers.get('connection'), 'upgrade')) return { error: 'missing Connection: Upgrade' }
  if (head.headers.get('sec-websocket-version') !== '13') return { error: 'unsupported Sec-WebSocket-Version, expected 13' }
  const key = head.headers.get('sec-websocket-key')
  if (key === undefined || Buffer.from(key, 'base64').length !== 16) return { error: 'missing or invalid Sec-WebSocket-Key' }
  return { key }
}

export function handshakeResponse(key: string): string {
  return (
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${websocketAccept(key)}\r\n` +
    '\r\n'
  )
}

// A server frame: FIN set, never masked (RFC 6455 section 5.1).
export function encodeFrame(opcode: number, payload: Buffer): Buffer {
  const length = payload.length
  let header: Buffer
  if (length < 126) {
    header = Buffer.alloc(2)
    header[1] = length
  } else if (length < 65536) {
    header = Buffer.alloc(4)
    header[1] = 126
    header.writeUInt16BE(length, 2)
  } else {
    header = Buffer.alloc(10)
    header[1] = 127
    header.writeBigUInt64BE(BigInt(length), 2)
  }
  header[0] = 0x80 | opcode
  return Buffer.concat([header, payload])
}

export interface Frame {
  fin: boolean
  opcode: number
  payload: Buffer
}

export class FrameError extends Error {
  constructor(
    message: string,
    readonly closeCode: number
  ) {
    super(message)
  }
}

// Incremental decoder for client frames. push() appends bytes and returns
// every complete frame they finish, unmasked. Throws FrameError on a frame
// the server must refuse.
export class FrameDecoder {
  private buffer: Buffer = Buffer.alloc(0)

  push(chunk: Buffer): Frame[] {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk])
    const frames: Frame[] = []
    for (;;) {
      const frame = this.next()
      if (frame === null) return frames
      frames.push(frame)
    }
  }

  private next(): Frame | null {
    const buf = this.buffer
    if (buf.length < 2) return null
    const b0 = buf[0]!
    const b1 = buf[1]!
    if ((b0 & 0x70) !== 0) throw new FrameError('reserved bits set, and no extension was negotiated', CLOSE_PROTOCOL_ERROR)
    const fin = (b0 & 0x80) !== 0
    const opcode = b0 & 0x0f
    const masked = (b1 & 0x80) !== 0
    if (!masked) throw new FrameError('client frames must be masked', CLOSE_PROTOCOL_ERROR)
    let length = b1 & 0x7f
    let offset = 2
    if (length === 126) {
      if (buf.length < 4) return null
      length = buf.readUInt16BE(2)
      offset = 4
    } else if (length === 127) {
      if (buf.length < 10) return null
      const big = buf.readBigUInt64BE(2)
      if (big > BigInt(MAX_FRAME_BYTES)) throw new FrameError('frame too large', CLOSE_TOO_BIG)
      length = Number(big)
      offset = 10
    }
    if (length > MAX_FRAME_BYTES) throw new FrameError('frame too large', CLOSE_TOO_BIG)
    if (opcode >= 0x8 && (length > 125 || !fin)) {
      throw new FrameError('control frames must be short and unfragmented', CLOSE_PROTOCOL_ERROR)
    }
    if (buf.length < offset + 4 + length) return null
    const mask = buf.subarray(offset, offset + 4)
    const payload = Buffer.from(buf.subarray(offset + 4, offset + 4 + length))
    for (let i = 0; i < payload.length; i++) payload[i] = payload[i]! ^ mask[i & 3]!
    this.buffer = buf.subarray(offset + 4 + length)
    return { fin, opcode, payload }
  }
}

// The raw socket's surface this file needs. A net.Socket or a tls.TLSSocket
// in production; anything Duplex-shaped in a test.
type RawSocket = Duplex & { remoteAddress?: string | undefined }

// The Postgres byte stream inside a WebSocket, as a Duplex: what the client
// sends in binary messages is readable here, and what is written here goes
// to the client as binary messages. One write is one message, which is also
// what Neon's proxy does.
export class WebSocketStream extends Duplex {
  private readonly decoder = new FrameDecoder()
  private closeSent = false
  private readonly raw: RawSocket

  constructor(raw: RawSocket, early: Buffer) {
    super({ allowHalfOpen: false })
    this.raw = raw
    raw.on('data', (chunk: Buffer) => this.onRaw(chunk))
    raw.on('end', () => this.push(null))
    raw.on('close', () => {
      if (!this.destroyed) this.destroy()
    })
    raw.on('error', () => {
      if (!this.destroyed) this.destroy()
    })
    if (early.length > 0) this.onRaw(early)
  }

  get remoteAddress(): string | undefined {
    return this.raw.remoteAddress
  }

  private onRaw(chunk: Buffer): void {
    let frames: Frame[]
    try {
      frames = this.decoder.push(chunk)
    } catch (err) {
      const code = err instanceof FrameError ? err.closeCode : CLOSE_PROTOCOL_ERROR
      this.closeWith(code, err instanceof Error ? err.message : 'protocol error')
      return
    }
    for (const frame of frames) {
      switch (frame.opcode) {
        case OPCODE_BINARY:
        case OPCODE_CONTINUATION:
          if (frame.payload.length > 0 && !this.push(frame.payload)) this.raw.pause()
          break
        case OPCODE_TEXT:
          this.closeWith(CLOSE_UNSUPPORTED_DATA, 'expected binary messages only')
          return
        case OPCODE_PING:
          this.raw.write(encodeFrame(OPCODE_PONG, frame.payload))
          break
        case OPCODE_PONG:
          break
        case OPCODE_CLOSE:
          // Echo the close (RFC 6455 section 5.5.1), end the stream, and let
          // the client close the TCP connection; a forced destroy follows in
          // case it never does.
          if (!this.closeSent) {
            this.closeSent = true
            this.raw.write(encodeFrame(OPCODE_CLOSE, frame.payload.subarray(0, 2)))
          }
          this.push(null)
          this.raw.end()
          setTimeout(() => this.raw.destroy(), 1000).unref()
          return
        default:
          this.closeWith(CLOSE_PROTOCOL_ERROR, `unknown opcode ${frame.opcode}`)
          return
      }
    }
  }

  private closeWith(code: number, reason: string): void {
    if (!this.closeSent) {
      this.closeSent = true
      const payload = Buffer.alloc(2 + Buffer.byteLength(reason.slice(0, 120)))
      payload.writeUInt16BE(code, 0)
      payload.write(reason.slice(0, 120), 2)
      this.raw.write(encodeFrame(OPCODE_CLOSE, payload))
    }
    this.raw.end()
    setTimeout(() => this.raw.destroy(), 1000).unref()
    this.destroy()
  }

  override _read(): void {
    this.raw.resume()
  }

  override _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    if (this.closeSent || this.raw.destroyed) {
      callback()
      return
    }
    this.raw.write(encodeFrame(OPCODE_BINARY, chunk), (err) => callback(err ?? null))
  }

  override _final(callback: (error?: Error | null) => void): void {
    if (!this.closeSent && !this.raw.destroyed) {
      this.closeSent = true
      const payload = Buffer.alloc(2)
      payload.writeUInt16BE(CLOSE_NORMAL, 0)
      this.raw.write(encodeFrame(OPCODE_CLOSE, payload))
    }
    this.raw.end()
    setTimeout(() => this.raw.destroy(), 1000).unref()
    callback()
  }

  override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    if (!this.raw.destroyed) {
      if (!this.closeSent && this.raw.writable) {
        this.closeSent = true
        const payload = Buffer.alloc(2)
        payload.writeUInt16BE(CLOSE_NORMAL, 0)
        this.raw.end(encodeFrame(OPCODE_CLOSE, payload))
        setTimeout(() => this.raw.destroy(), 1000).unref()
      } else {
        this.raw.destroy()
      }
    }
    callback(error)
  }
}
