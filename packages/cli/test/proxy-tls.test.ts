// The daemon's half of TLS at the Postgres proxy, ADR 0019: refusing a
// half-configured proxyTls, and the bind note `hobby init` prints. The proxy
// half is in packages/proxy/test/tls.test.ts.

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { HobbyError } from '@hobby.sh/core'
import { proxyBindNote } from '../src/cli/output.js'
import { proxyTlsFiles } from '../src/daemon/server.js'

test('proxyTlsFiles: null means no TLS', () => {
  assert.equal(proxyTlsFiles(null), undefined)
})

test('proxyTlsFiles: a complete config yields the two files', () => {
  assert.deepEqual(proxyTlsFiles({ certFile: '/c.pem', keyFile: '/k.pem', hostname: 'db.example.com' }), {
    certFile: '/c.pem',
    keyFile: '/k.pem',
  })
})

test('proxyTlsFiles: a partial config refuses to start and names what is missing', () => {
  assert.throws(
    () => proxyTlsFiles({ certFile: '/c.pem', keyFile: '', hostname: ' ' }),
    (err: unknown) => err instanceof HobbyError && /keyFile, hostname/.test(err.message)
  )
})

test('proxyBindNote: every interface without TLS still warns about cleartext', () => {
  assert.match(proxyBindNote('all'), /^warning: .*cleartext/)
})

test('proxyBindNote: every interface with TLS says plaintext is refused, and does not warn', () => {
  const note = proxyBindNote('all', 'db.example.com')
  assert.doesNotMatch(note, /warning/)
  assert.match(note, /every interface, with TLS for db\.example\.com/)
  assert.match(note, /sslmode=require/)
})
