import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  parseStartup,
  buildStartupPacket,
  SSL_REQUEST_CODE,
  CANCEL_REQUEST_CODE,
  PROTOCOL_3_0,
} from '../src/startup.ts'

test('parses user and database out of a startup packet', () => {
  const buf = buildStartupPacket({ user: 'hobby', database: 'blog' })
  const parsed = parseStartup(buf)
  assert.notEqual(parsed, null)
  assert.equal(parsed!.message.type, 'startup')
  if (parsed!.message.type !== 'startup') throw new Error('unreachable')
  assert.equal(parsed!.message.version, PROTOCOL_3_0)
  assert.equal(parsed!.message.params.user, 'hobby')
  assert.equal(parsed!.message.params.database, 'blog')
  assert.equal(parsed!.consumed, buf.length)
})

test('returns null when the packet is incomplete, so the caller keeps reading', () => {
  const buf = buildStartupPacket({ user: 'hobby', database: 'blog' })
  assert.equal(parseStartup(buf.subarray(0, 4)), null)
  assert.equal(parseStartup(buf.subarray(0, buf.length - 1)), null)
})

test('recognises an SSLRequest', () => {
  const buf = Buffer.alloc(8)
  buf.writeInt32BE(8, 0)
  buf.writeInt32BE(SSL_REQUEST_CODE, 4)
  const parsed = parseStartup(buf)
  assert.equal(parsed!.message.type, 'ssl_request')
  assert.equal(parsed!.consumed, 8)
})

test('recognises a CancelRequest and reads its key', () => {
  const buf = Buffer.alloc(16)
  buf.writeInt32BE(16, 0)
  buf.writeInt32BE(CANCEL_REQUEST_CODE, 4)
  buf.writeInt32BE(4242, 8)
  buf.writeInt32BE(9999, 12)
  const parsed = parseStartup(buf)
  if (parsed!.message.type !== 'cancel_request') throw new Error('unreachable')
  assert.equal(parsed!.message.processId, 4242)
  assert.equal(parsed!.message.secretKey, 9999)
})

test('rejects an implausible length rather than allocating on it', () => {
  const buf = Buffer.alloc(8)
  buf.writeInt32BE(999_999, 0)
  buf.writeInt32BE(PROTOCOL_3_0, 4)
  assert.throws(() => parseStartup(buf), /implausible startup length/)
})

test('rejects a packet whose final key is unterminated', () => {
  const body = Buffer.from('user\0hobby\0database', 'utf8')
  const buf = Buffer.alloc(8 + body.length)
  buf.writeInt32BE(buf.length, 0)
  buf.writeInt32BE(PROTOCOL_3_0, 4)
  body.copy(buf, 8)
  assert.throws(() => parseStartup(buf), /malformed startup/)
})
