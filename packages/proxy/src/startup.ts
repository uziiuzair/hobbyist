// The Postgres wire protocol, startup phase only. Everything here is pure:
// no sockets, no I/O, just bytes in and bytes out. proxy.ts is the only file
// that touches a net.Socket; this file is what makes that file testable
// without one.
//
// Wire shapes, all big-endian:
//
//   SSLRequest:      Int32(8)  Int32(80877103)
//   GSSENCRequest:   Int32(8)  Int32(80877104)
//   CancelRequest:   Int32(16) Int32(80877102) Int32(processId) Int32(secretKey)
//   StartupMessage:  Int32(length) Int32(version)
//                    { CString(key) CString(value) }*  Byte1(0)
//
// The four share a length-prefixed frame, which is why parseStartup reads
// the length first and dispatches on it rather than parsing four formats
// independently.

export const PROTOCOL_3_0 = 196608
export const SSL_REQUEST_CODE = 80877103
export const GSS_ENC_REQUEST_CODE = 80877104
export const CANCEL_REQUEST_CODE = 80877102

// An implausible length is any length that could not be a real startup
// packet on this project: no client sends 10000 bytes of startup
// parameters, and a number this large arriving as the very first four bytes
// on the wire is far more likely to be garbage, a non-Postgres client, or an
// attempt to make the proxy buffer unboundedly while waiting for a length
// that will never be satisfied. Rejecting it early is what turns that case
// into a fast ErrorResponse instead of a proxy that hangs holding a growing
// buffer forever.
const MAX_PLAUSIBLE_LENGTH = 10000

// The shortest possible frame on the wire is SSLRequest/GSSENCRequest at 8
// bytes (Int32 length + Int32 code), not CancelRequest's 16 or a
// zero-param StartupMessage's 9. Anything shorter than 8 cannot be any of
// the four shapes. Getting this floor wrong is not academic: a floor of 9
// rejects every SSLRequest outright, and SSLRequest is exactly what a
// default `psql` (sslmode=prefer) sends first on every single connection.
const MIN_PLAUSIBLE_LENGTH = 8

export type StartupMessage =
  | { type: 'ssl_request' }
  | { type: 'gss_enc_request' }
  | { type: 'cancel_request'; processId: number; secretKey: number }
  | { type: 'startup'; version: number; params: Record<string, string> }

// Returns null when `buf` does not yet hold a complete message: the caller
// owns buffering across socket 'data' events and should call again once
// more bytes have arrived. Throws when what has arrived so far can never
// become a valid message (an implausible length, or a key/value that runs
// past the frame without a terminating zero byte); the caller should end
// the connection with a real ErrorResponse rather than keep waiting.
export function parseStartup(buf: Buffer): { message: StartupMessage; consumed: number } | null {
  if (buf.length < 4) {
    return null
  }

  const length = buf.readInt32BE(0)

  if (length < MIN_PLAUSIBLE_LENGTH) {
    throw new Error(`implausible startup packet length: ${length}`)
  }
  if (length > MAX_PLAUSIBLE_LENGTH) {
    throw new Error(`implausible startup packet length: ${length} exceeds ${MAX_PLAUSIBLE_LENGTH}`)
  }
  if (buf.length < length) {
    return null
  }

  if (length === 8) {
    const code = buf.readInt32BE(4)
    if (code === SSL_REQUEST_CODE) {
      return { message: { type: 'ssl_request' }, consumed: 8 }
    }
    if (code === GSS_ENC_REQUEST_CODE) {
      return { message: { type: 'gss_enc_request' }, consumed: 8 }
    }
    throw new Error(`unrecognized 8-byte startup frame with code ${code}`)
  }

  if (length === 16) {
    const code = buf.readInt32BE(4)
    if (code === CANCEL_REQUEST_CODE) {
      return {
        message: {
          type: 'cancel_request',
          processId: buf.readInt32BE(8),
          secretKey: buf.readInt32BE(12),
        },
        consumed: 16,
      }
    }
    // Falls through: length 16 is also a legal StartupMessage frame (a
    // version plus a handful of tiny params), so only bail out here if the
    // code truly does not parse as one below. Nothing further to do in this
    // branch, the general parse below handles it.
  }

  const version = buf.readInt32BE(4)
  const params: Record<string, string> = {}
  let offset = 8

  for (;;) {
    if (offset >= length) {
      throw new Error('startup packet params ran past its declared length without a terminator')
    }
    if (buf[offset] === 0) {
      offset += 1
      break
    }

    const keyEnd = buf.indexOf(0, offset)
    if (keyEnd === -1 || keyEnd >= length) {
      throw new Error('unterminated key in startup packet params')
    }
    const key = buf.toString('utf8', offset, keyEnd)
    offset = keyEnd + 1

    if (offset >= length) {
      throw new Error('unterminated value in startup packet params')
    }
    const valueEnd = buf.indexOf(0, offset)
    if (valueEnd === -1 || valueEnd >= length) {
      throw new Error('unterminated value in startup packet params')
    }
    const value = buf.toString('utf8', offset, valueEnd)
    offset = valueEnd + 1

    params[key] = value
  }

  if (offset !== length) {
    throw new Error('trailing bytes after startup packet terminator')
  }

  return { message: { type: 'startup', version, params }, consumed: length }
}

// The inverse of the 'startup' branch of parseStartup. Used by tests to
// round-trip the parser, and by proxy.ts for exactly one purpose: rebuilding
// the startup packet with the `database` parameter substituted for dotted
// routing (`project.database`), everything else, and its order, carried
// over unchanged from the parsed params. That is a targeted edit of one
// already-parsed value, not a reconstruction from scratch: nothing
// parseStartup captured is dropped, because every key parseStartup saw is
// still in `params`. `version` defaults to PROTOCOL_3_0 but accepts the
// client's actual version so a rebuild never silently changes it.
export function buildStartupPacket(params: Record<string, string>, version: number = PROTOCOL_3_0): Buffer {
  const parts: Buffer[] = []
  for (const [key, value] of Object.entries(params)) {
    parts.push(Buffer.from(key, 'utf8'), Buffer.from([0]), Buffer.from(value, 'utf8'), Buffer.from([0]))
  }
  const paramsBuf = Buffer.concat(parts)
  const length = 4 + 4 + paramsBuf.length + 1

  const header = Buffer.alloc(8)
  header.writeInt32BE(length, 0)
  header.writeInt32BE(version, 4)

  return Buffer.concat([header, paramsBuf, Buffer.from([0])])
}

// Builds a wire-format ErrorResponse ('E'): Byte1('E'), then Int32(length)
// covering itself and everything that follows, then a run of fields (each a
// Byte1 field-type code followed by a null-terminated string), then a
// closing zero byte. 'S' and 'M' are the fields every client actually reads
// (severity, message); 'C' carries the SQLSTATE. 'V' duplicates 'S' as the
// non-localized severity code, a field real Postgres (9.6+) always sends
// alongside 'S' and that some clients (including libpq) prefer when it is
// present. Included here so the bytes this proxy emits are indistinguishable
// from a real backend's ErrorResponse, not merely readable by a generous
// client.
export function errorResponse(severity: string, code: string, message: string): Buffer {
  const fields: Array<[string, string]> = [
    ['S', severity],
    ['V', severity],
    ['C', code],
    ['M', message],
  ]

  const fieldBufs = fields.map(([fieldType, value]) =>
    Buffer.concat([Buffer.from(fieldType, 'ascii'), Buffer.from(value, 'utf8'), Buffer.from([0])])
  )
  const body = Buffer.concat([...fieldBufs, Buffer.from([0])])
  const length = 4 + body.length

  const header = Buffer.alloc(5)
  header.write('E', 0, 'ascii')
  header.writeInt32BE(length, 1)

  return Buffer.concat([header, body])
}
