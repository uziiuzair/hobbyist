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
