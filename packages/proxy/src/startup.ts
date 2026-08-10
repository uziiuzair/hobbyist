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
//
// The backend to client half of the same phase is a different frame: every
// message carries a type byte first, then a length that counts itself but
// not the type byte.
//
//   BackendKeyData:  Byte1('K') Int32(12) Int32(processId) Int32(secretKey)
//   ReadyForQuery:   Byte1('Z') Int32(5)  Byte1(status)
//   ErrorResponse:   Byte1('E') Int32(length) { Byte1(field) CString }* Byte1(0)
//
// Only two of those are read here. BackendKeyData is the pair a client must
// present to cancel, and ReadyForQuery is the marker that the startup phase
// is over and there is nothing left to look at.

export const PROTOCOL_3_0 = 196608
export const SSL_REQUEST_CODE = 80877103
export const GSS_ENC_REQUEST_CODE = 80877104
export const CANCEL_REQUEST_CODE = 80877102

// Backend message type bytes, as ASCII codes.
const BACKEND_KEY_DATA = 0x4b // 'K'
const READY_FOR_QUERY = 0x5a // 'Z'

// BackendKeyData's length field, which is fixed: 4 for the length itself
// plus two Int32s. Checked rather than assumed, so a message that merely
// happens to start with 'K' is not read as one.
const BACKEND_KEY_DATA_LENGTH = 12

// Nothing the backend sends between the startup packet and ReadyForQuery is
// large: authentication challenges, ParameterStatus pairs, BackendKeyData.
// A length above this means the scan has lost sync with the message
// boundaries, and the right response is to stop scanning rather than to
// buffer toward a length that may never arrive. See scanBackendStartup.
const MAX_BACKEND_STARTUP_MESSAGE = 65536

// The pair Postgres hands a client in BackendKeyData, and the pair a client
// sends back in a CancelRequest. It identifies a connection well enough to
// cancel its running query, and it is unauthenticated, which is why the
// proxy mints its own rather than passing the backend's through: see
// cancel.ts.
export interface CancelKey {
  processId: number
  secretKey: number
}

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

// The inverse of the 'cancel_request' branch of parseStartup. The proxy
// builds one of these to forward a client's cancel to the backend that is
// actually running the query, carrying the backend's own key rather than
// the one the client presented. See cancel.ts for why those differ.
export function buildCancelRequest(key: CancelKey): Buffer {
  const buf = Buffer.alloc(16)
  buf.writeInt32BE(16, 0)
  buf.writeInt32BE(CANCEL_REQUEST_CODE, 4)
  buf.writeInt32BE(key.processId, 8)
  buf.writeInt32BE(key.secretKey, 12)
  return buf
}

export interface BackendStartupScan {
  // The bytes to forward to the client: the first `consumed` bytes of the
  // input, with BackendKeyData's payload replaced if it appeared among them.
  forward: Buffer
  // How much of the input was whole messages. Anything past this is a
  // partial message and belongs at the front of the next call's input.
  consumed: number
  // The backend's own key, if BackendKeyData was among the messages read.
  backendKey: CancelKey | null
  // Stop scanning. Either ReadyForQuery arrived, meaning the startup phase
  // is over and everything after it is query traffic that must be spliced
  // untouched, or the framing stopped making sense and continuing to read
  // it would be guessing.
  done: boolean
}

// Reads the backend's side of the startup phase, message by message, and
// swaps the key it hands the client for one of ours.
//
// Why swap it at all: a client cancels by opening a second, separate,
// unauthenticated connection carrying only the (processId, secretKey) pair
// it was given. If that pair is the backend's own, the proxy receives a
// cancel bearing a key it has no map for and can only drop it, which is
// exactly the gap this exists to close. Minting our own makes the key
// something the proxy can look up. Minting rather than merely recording the
// backend's also removes a collision: two containers can each hand out
// process id 42, and a cancel is then ambiguous between them.
//
// `buf` is whatever has arrived so far, starting at a message boundary.
// Incomplete trailing bytes are left for the caller to re-present with more
// data appended; nothing is buffered here, which is what keeps this pure.
//
// A message that does not parse sets `done` without throwing. The bytes
// still forward untouched: losing the ability to route this connection's
// cancels is a small loss, and killing a working database connection over
// a message this function did not expect is a large one.
export function scanBackendStartup(buf: Buffer, replacement: CancelKey): BackendStartupScan {
  let offset = 0
  let backendKey: CancelKey | null = null
  let done = false
  // Copied only if there is something to rewrite, which is at most once per
  // connection. Every other byte forwards as a view on the caller's buffer.
  let rewritten: Buffer | null = null

  // 5 is the smallest readable header: the type byte plus its Int32 length.
  while (offset + 5 <= buf.length) {
    const type = buf[offset]
    const length = buf.readInt32BE(offset + 1)

    if (length < 4 || length > MAX_BACKEND_STARTUP_MESSAGE) {
      done = true
      break
    }

    const total = 1 + length
    if (offset + total > buf.length) {
      break
    }

    if (type === BACKEND_KEY_DATA && length === BACKEND_KEY_DATA_LENGTH) {
      backendKey = {
        processId: buf.readInt32BE(offset + 5),
        secretKey: buf.readInt32BE(offset + 9),
      }
      rewritten ??= Buffer.from(buf)
      rewritten.writeInt32BE(replacement.processId, offset + 5)
      rewritten.writeInt32BE(replacement.secretKey, offset + 9)
    }

    offset += total

    // Forwarded first, then scanning stops: ReadyForQuery is itself part of
    // the startup phase and the client is waiting for it.
    if (type === READY_FOR_QUERY) {
      done = true
      break
    }
  }

  return {
    forward: (rewritten ?? buf).subarray(0, offset),
    consumed: offset,
    backendKey,
    done,
  }
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
