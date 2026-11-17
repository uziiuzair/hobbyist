import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import {
  checkUpgrade,
  encodeFrame,
  FrameDecoder,
  FrameError,
  OPCODE_BINARY,
  OPCODE_CONTINUATION,
  OPCODE_PING,
  OPCODE_TEXT,
  parseHttpHead,
  PipelinedPasswordShim,
  parsePgArray,
  jsonToPgText,
  websocketAccept,
} from '../src/index.js'

// A client frame: masked, as RFC 6455 requires of clients.
function clientFrame(opcode: number, payload: Buffer, fin = true): Buffer {
  const mask = Buffer.from([1, 2, 3, 4])
  const masked = Buffer.from(payload.map((b, i) => b ^ mask[i & 3]!))
  let header: Buffer
  if (payload.length < 126) header = Buffer.from([0, 0x80 | payload.length])
  else if (payload.length < 65536) {
    header = Buffer.alloc(4)
    header[1] = 0x80 | 126
    header.writeUInt16BE(payload.length, 2)
  } else {
    header = Buffer.alloc(10)
    header[1] = 0x80 | 127
    header.writeBigUInt64BE(BigInt(payload.length), 2)
  }
  header[0] = (fin ? 0x80 : 0) | opcode
  return Buffer.concat([header, mask, masked])
}

test('the accept key matches the RFC 6455 example', () => {
  assert.equal(websocketAccept('dGhlIHNhbXBsZSBub25jZQ=='), 's3pPLMBiTxaQ9kYGzzhZRbK+xOo=')
})

test('parseHttpHead waits for the blank line, then reads the request', () => {
  assert.equal(parseHttpHead(Buffer.from('GET /v2 HTTP/1.1\r\nHost: x\r\n')), null)
  const head = parseHttpHead(Buffer.from('GET /v2 HTTP/1.1\r\nHost: x\r\nUpgrade: WebSocket\r\n\r\nrest'))
  assert.ok(head)
  assert.equal(head.method, 'GET')
  assert.equal(head.target, '/v2')
  assert.equal(head.headers.get('upgrade'), 'WebSocket')
  assert.equal(head.length, 'GET /v2 HTTP/1.1\r\nHost: x\r\nUpgrade: WebSocket\r\n\r\n'.length)
  assert.throws(() => parseHttpHead(Buffer.from('NOT HTTP\r\n\r\n')))
  assert.throws(() => parseHttpHead(Buffer.alloc(20000, 0x41)))
})

test('checkUpgrade tells plain HTTP, a valid upgrade and a broken one apart', () => {
  const head = (extra: string): ReturnType<typeof parseHttpHead> =>
    parseHttpHead(Buffer.from(`GET / HTTP/1.1\r\nHost: x\r\n${extra}\r\n`))
  assert.equal(checkUpgrade(head('')!), null)
  assert.deepEqual(
    checkUpgrade(head('Upgrade: websocket\r\nConnection: keep-alive, Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n')!),
    { key: 'dGhlIHNhbXBsZSBub25jZQ==' }
  )
  assert.ok('error' in (checkUpgrade(head('Upgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 8\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n')!) ?? {}))
})

test('the decoder unmasks, reassembles split frames, and handles every length form', () => {
  const decoder = new FrameDecoder()
  const small = Buffer.from('hello')
  const medium = Buffer.alloc(300, 7)
  const large = Buffer.alloc(70000, 9)
  const bytes = Buffer.concat([clientFrame(OPCODE_BINARY, small), clientFrame(OPCODE_BINARY, medium, false), clientFrame(OPCODE_CONTINUATION, large)])
  const frames = []
  for (let i = 0; i < bytes.length; i += 1000) frames.push(...decoder.push(bytes.subarray(i, i + 1000)))
  assert.equal(frames.length, 3)
  assert.deepEqual(frames[0]!.payload, small)
  assert.deepEqual(frames[1]!.payload, medium)
  assert.equal(frames[1]!.fin, false)
  assert.deepEqual(frames[2]!.payload, large)
})

test('the decoder refuses unmasked and oversized control frames', () => {
  assert.throws(() => new FrameDecoder().push(Buffer.from([0x82, 0x01, 0x00])), FrameError)
  const longPing = clientFrame(OPCODE_PING, Buffer.alloc(200))
  assert.throws(() => new FrameDecoder().push(longPing), FrameError)
  // A text frame decodes; refusing it is WebSocketStream's job.
  assert.equal(new FrameDecoder().push(clientFrame(OPCODE_TEXT, Buffer.from('x')))[0]!.opcode, OPCODE_TEXT)
})

test('server frames are unmasked with the right length encoding', () => {
  assert.deepEqual(encodeFrame(OPCODE_BINARY, Buffer.from('ab')), Buffer.from([0x82, 2, 0x61, 0x62]))
  assert.equal(encodeFrame(OPCODE_BINARY, Buffer.alloc(300))[1], 126)
  assert.equal(encodeFrame(OPCODE_BINARY, Buffer.alloc(70000))[1], 127)
})

// --- the pipelined password shim, against scripted servers -----------------

function startup(user: string): Buffer {
  const body = Buffer.from(`user\0${user}\0database\0blog\0\0`)
  const out = Buffer.alloc(8)
  out.writeInt32BE(8 + body.length, 0)
  out.writeInt32BE(196608, 4)
  return Buffer.concat([out, body])
}
function typed(type: string, body: Buffer): Buffer {
  const h = Buffer.alloc(5)
  h.write(type, 0, 'latin1')
  h.writeInt32BE(body.length + 4, 1)
  return Buffer.concat([h, body])
}
const auth = (code: number, rest: Buffer = Buffer.alloc(0)): Buffer => {
  const b = Buffer.alloc(4)
  b.writeInt32BE(code, 0)
  return typed('R', Buffer.concat([b, rest]))
}
const passwordMessage = (pw: string): Buffer => typed('p', Buffer.from(`${pw}\0`))
const query = typed('Q', Buffer.from('SELECT 1\0'))
const ready = typed('Z', Buffer.from('I'))

test('shim: a pipelined password answers an MD5 challenge, and held queries follow the login', () => {
  const shim = new PipelinedPasswordShim()
  const first = shim.fromClient(Buffer.concat([startup('app'), passwordMessage('secret'), query]))
  assert.deepEqual(first.toBackend, [startup('app')])
  assert.deepEqual(first.toClient, [])
  const salt = Buffer.from([1, 2, 3, 4])
  const challenge = shim.fromBackend(auth(5, salt))
  const inner = createHash('md5').update('secretapp').digest('hex')
  const expected = 'md5' + createHash('md5').update(Buffer.concat([Buffer.from(inner), salt])).digest('hex')
  assert.deepEqual(challenge.toBackend, [passwordMessage(expected)])
  assert.deepEqual(challenge.toClient, [], 'the challenge is answered for the client, not shown to it')
  const ok = shim.fromBackend(Buffer.concat([auth(0), ready]))
  assert.deepEqual(ok.toClient, [auth(0), ready])
  assert.deepEqual(ok.toBackend, [query])
  assert.equal(shim.done, true)
})

test('shim: cleartext and trust', () => {
  const clear = new PipelinedPasswordShim()
  clear.fromClient(Buffer.concat([startup('app'), passwordMessage('pw')]))
  assert.deepEqual(clear.fromBackend(auth(3)).toBackend, [passwordMessage('pw')])

  const trust = new PipelinedPasswordShim()
  trust.fromClient(Buffer.concat([startup('app'), passwordMessage('pw')]))
  const out = trust.fromBackend(auth(0))
  assert.deepEqual(out.toBackend, [], 'the unasked-for password is dropped')
  assert.deepEqual(out.toClient, [auth(0)])
})

test('shim: a client that waits to be asked passes through untouched', () => {
  const shim = new PipelinedPasswordShim()
  assert.deepEqual(shim.fromClient(startup('app')).toBackend, [startup('app')])
  const challenge = auth(10, Buffer.from('SCRAM-SHA-256\0\0'))
  assert.deepEqual(shim.fromBackend(challenge).toClient, [challenge])
  assert.equal(shim.done, true)
})

test('shim: an error during login reaches the client; an unsupported method fails', () => {
  const shim = new PipelinedPasswordShim()
  shim.fromClient(Buffer.concat([startup('app'), passwordMessage('pw')]))
  const error = typed('E', Buffer.from('SFATAL\0C28P01\0Mbad\0\0'))
  assert.deepEqual(shim.fromBackend(error).toClient, [error])

  const gss = new PipelinedPasswordShim()
  gss.fromClient(Buffer.concat([startup('app'), passwordMessage('pw')]))
  assert.match(gss.fromBackend(auth(7)).fail ?? '', /cannot answer/)
})

test('shim: a server signature that does not verify fails the login', () => {
  const shim = new PipelinedPasswordShim()
  shim.fromClient(Buffer.concat([startup('app'), passwordMessage('pw')]))
  const start = shim.fromBackend(auth(10, Buffer.from('SCRAM-SHA-256\0\0')))
  const initial = start.toBackend[0]!.toString('utf8')
  const nonce = /r=([^,\0]+)/.exec(initial)![1]!
  shim.fromBackend(auth(11, Buffer.from(`r=${nonce}server,s=${Buffer.from('salt').toString('base64')},i=4096`)))
  assert.match(shim.fromBackend(auth(12, Buffer.from('v=AAAA'))).fail ?? '', /does not verify/)
})

// --- /sql value conversion ---------------------------------------------------

test('parameters become Postgres text as Neon converts them', () => {
  assert.equal(jsonToPgText(null), null)
  assert.equal(jsonToPgText('a "b"'), 'a "b"')
  assert.equal(jsonToPgText(3), '3')
  assert.equal(jsonToPgText(true), 'true')
  assert.equal(jsonToPgText({ a: 1 }), '{"a":1}')
  assert.equal(jsonToPgText([1, null, 'x"y', [2]]), '{1,NULL,"x\\"y",{2}}')
})

test('array output text parses to nested JSON arrays', () => {
  assert.deepEqual(parsePgArray('{}', 23), [])
  assert.deepEqual(parsePgArray('{{1,2},{3,NULL}}', 23), [
    [1, 2],
    [3, null],
  ])
  assert.deepEqual(parsePgArray('{"a b","NULL",NULL,"q\\"x"}', 25), ['a b', 'NULL', null, 'q"x'])
  assert.deepEqual(parsePgArray('[0:1]={t,f}', 16), [true, false])
  assert.throws(() => parsePgArray('{1,2', 23))
})
