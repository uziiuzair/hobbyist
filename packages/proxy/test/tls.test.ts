// TLS termination at the Postgres proxy, ADR 0019. Real sockets, a real TLS
// handshake, and a fake upstream that records what arrives, same approach as
// proxy.test.ts. These run under node --test; the daemon runs under Bun, and
// the whole reason tls.ts relays to an inner server is a Bun gap, so a Bun
// run against a real daemon is part of verifying this and is not replaced by
// these tests.

import assert from 'node:assert/strict'
import { copyFileSync, mkdirSync, utimesSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import tls from 'node:tls'
import { test } from 'node:test'
import {
  ActivityTracker,
  buildStartupPacket,
  CANCEL_REQUEST_CODE,
  isLoopbackAddress,
  SSL_REQUEST_CODE,
  startPgProxy,
  type ProxyDeps,
} from '../src/index.js'

// Compiled to dist/test, the fixtures stay in test/fixtures.
const FIXTURES = fileURLToPath(new URL('../../test/fixtures/', import.meta.url))

function fixtureFiles(name: 'first' | 'second'): { certFile: string; keyFile: string } {
  return { certFile: join(FIXTURES, `${name}.crt`), keyFile: join(FIXTURES, `${name}.key`) }
}

function sslRequestBytes(): Buffer {
  const buf = Buffer.alloc(8)
  buf.writeInt32BE(8, 0)
  buf.writeInt32BE(SSL_REQUEST_CODE, 4)
  return buf
}

function extractSqlState(buf: Buffer): string | null {
  const cIndex = buf.indexOf(Buffer.from('C', 'ascii'))
  if (cIndex === -1) return null
  const end = buf.indexOf(0, cIndex + 1)
  return end === -1 ? null : buf.toString('ascii', cIndex + 1, end)
}

function readAll(socket: net.Socket): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    socket.on('data', (chunk: Buffer) => chunks.push(chunk))
    socket.on('close', () => resolve(Buffer.concat(chunks)))
    socket.on('error', reject)
  })
}

function connectClient(port: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: '127.0.0.1', port })
    socket.once('connect', () => resolve(socket))
    socket.once('error', reject)
  })
}

// SSLRequest, expect 'S', then a TLS handshake on the same socket. Resolves
// with the TLS socket and the common name of the certificate it was served.
async function negotiateTls(port: number): Promise<{ socket: tls.TLSSocket; commonName: string }> {
  const raw = await connectClient(port)
  raw.write(sslRequestBytes())
  const answer = await new Promise<Buffer>((resolve) => raw.once('data', resolve))
  assert.deepEqual(answer, Buffer.from('S', 'ascii'))
  return new Promise((resolve, reject) => {
    const socket = tls.connect({ socket: raw, rejectUnauthorized: false }, () => {
      resolve({ socket, commonName: String(socket.getPeerCertificate().subject.CN) })
    })
    socket.once('error', reject)
  })
}

// A fake upstream that records the first bytes of the first connection.
function startFakeUpstream(): Promise<{ port: number; firstBytes: Promise<Buffer>; dials: () => number; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    let dials = 0
    let onFirst: (b: Buffer) => void = () => {}
    const firstBytes = new Promise<Buffer>((res) => {
      onFirst = res
    })
    const server = net.createServer((socket) => {
      dials++
      socket.once('data', onFirst)
    })
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      resolve({
        port: typeof address === 'object' && address !== null ? address.port : 0,
        firstBytes,
        dials: () => dials,
        close: () =>
          new Promise((res) => {
            server.close(() => res())
          }),
      })
    })
  })
}

function depsFor(upstreamPort: number): ProxyDeps {
  return {
    resolve: async () => ({ resourceId: 'r1', host: '127.0.0.1', port: upstreamPort, state: 'running', database: 'blog' }),
    wake: async () => {},
    activity: new ActivityTracker(),
  }
}

test('with a certificate, SSLRequest gets S and the startup packet inside TLS is routed', async () => {
  const upstream = await startFakeUpstream()
  const proxy = await startPgProxy({ port: 0, deps: depsFor(upstream.port), wakeTimeoutMs: 1000, tls: fixtureFiles('first') })
  try {
    const { socket, commonName } = await negotiateTls(proxy.port)
    assert.equal(commonName, 'first.test')
    socket.write(buildStartupPacket({ user: 'alice', database: 'blog' }))
    const forwarded = await upstream.firstBytes
    assert.ok(forwarded.includes(Buffer.from('alice\0')), 'the upstream received the decrypted startup packet')
    socket.destroy()
  } finally {
    await proxy.close()
    await upstream.close()
  }
})

test('with a certificate, a plaintext startup from another machine is refused with 28000 and nothing is dialed', async () => {
  const upstream = await startFakeUpstream()
  const proxy = await startPgProxy({
    port: 0,
    deps: depsFor(upstream.port),
    wakeTimeoutMs: 1000,
    tls: fixtureFiles('first'),
    plaintextAllowed: () => false,
  })
  try {
    const client = await connectClient(proxy.port)
    client.write(buildStartupPacket({ user: 'alice', database: 'blog' }))
    const response = await readAll(client)
    assert.equal(response[0], 0x45)
    assert.equal(extractSqlState(response), '28000')
    assert.ok(response.includes(Buffer.from('sslmode=require')), 'the error says how to fix it')
    assert.equal(upstream.dials(), 0)
  } finally {
    await proxy.close()
    await upstream.close()
  }
})

test('with a certificate, a remote client that negotiates TLS is not refused', async () => {
  const upstream = await startFakeUpstream()
  const proxy = await startPgProxy({
    port: 0,
    deps: depsFor(upstream.port),
    wakeTimeoutMs: 1000,
    tls: fixtureFiles('first'),
    plaintextAllowed: () => false,
  })
  try {
    const { socket } = await negotiateTls(proxy.port)
    socket.write(buildStartupPacket({ user: 'alice', database: 'blog' }))
    await upstream.firstBytes
    assert.equal(upstream.dials(), 1)
    socket.destroy()
  } finally {
    await proxy.close()
    await upstream.close()
  }
})

test('with a certificate, a plaintext startup from loopback is still routed', async () => {
  const upstream = await startFakeUpstream()
  const proxy = await startPgProxy({ port: 0, deps: depsFor(upstream.port), wakeTimeoutMs: 1000, tls: fixtureFiles('first') })
  try {
    const client = await connectClient(proxy.port)
    client.write(buildStartupPacket({ user: 'alice', database: 'blog' }))
    await upstream.firstBytes
    assert.equal(upstream.dials(), 1)
    client.destroy()
  } finally {
    await proxy.close()
    await upstream.close()
  }
})

test('with a certificate, a plaintext CancelRequest from another machine is not refused with 28000', async () => {
  // libpq before 17 sends cancels in plaintext even for sslmode=require
  // sessions. An unknown key closes silently, as in proxy.test.ts; what
  // matters is that no TLS refusal comes back.
  const proxy = await startPgProxy({
    port: 0,
    deps: depsFor(1),
    wakeTimeoutMs: 1000,
    tls: fixtureFiles('first'),
    plaintextAllowed: () => false,
  })
  try {
    const client = await connectClient(proxy.port)
    const cancel = Buffer.alloc(16)
    cancel.writeInt32BE(16, 0)
    cancel.writeInt32BE(CANCEL_REQUEST_CODE, 4)
    cancel.writeInt32BE(1, 8)
    cancel.writeInt32BE(2, 12)
    client.write(cancel)
    const response = await readAll(client)
    assert.notEqual(extractSqlState(response), '28000')
  } finally {
    await proxy.close()
  }
})

test('a replaced certificate is served to the next connection without a restart', async () => {
  const dir = join(tmpdir(), `hobby-tls-test-${randomUUID()}`)
  mkdirSync(dir, { recursive: true })
  const files = { certFile: join(dir, 'cert.pem'), keyFile: join(dir, 'key.pem') }
  copyFileSync(fixtureFiles('first').certFile, files.certFile)
  copyFileSync(fixtureFiles('first').keyFile, files.keyFile)

  const proxy = await startPgProxy({ port: 0, deps: depsFor(1), wakeTimeoutMs: 1000, tls: files })
  try {
    const before = await negotiateTls(proxy.port)
    assert.equal(before.commonName, 'first.test')
    before.socket.destroy()

    // What a certbot renewal does to the live path, with the modification
    // time pushed forward explicitly so a fast filesystem cannot land both
    // writes in the same timestamp.
    copyFileSync(fixtureFiles('second').certFile, files.certFile)
    copyFileSync(fixtureFiles('second').keyFile, files.keyFile)
    const later = new Date(Date.now() + 5000)
    utimesSync(files.certFile, later, later)
    utimesSync(files.keyFile, later, later)

    const after = await negotiateTls(proxy.port)
    assert.equal(after.commonName, 'second.test')
    after.socket.destroy()
  } finally {
    await proxy.close()
  }
})

test('a renewal caught halfway keeps serving the old certificate, then swaps once both files are in place', async () => {
  const dir = join(tmpdir(), `hobby-tls-test-${randomUUID()}`)
  mkdirSync(dir, { recursive: true })
  const files = { certFile: join(dir, 'cert.pem'), keyFile: join(dir, 'key.pem') }
  copyFileSync(fixtureFiles('first').certFile, files.certFile)
  copyFileSync(fixtureFiles('first').keyFile, files.keyFile)

  const proxy = await startPgProxy({ port: 0, deps: depsFor(1), wakeTimeoutMs: 1000, tls: files })
  try {
    // The new certificate is on disk, its key is not yet: a pair that does
    // not match, which tls.createServer refuses.
    copyFileSync(fixtureFiles('second').certFile, files.certFile)
    const later = new Date(Date.now() + 5000)
    utimesSync(files.certFile, later, later)

    const during = await negotiateTls(proxy.port)
    assert.equal(during.commonName, 'first.test')
    during.socket.destroy()

    copyFileSync(fixtureFiles('second').keyFile, files.keyFile)
    const evenLater = new Date(Date.now() + 10000)
    utimesSync(files.certFile, evenLater, evenLater)
    utimesSync(files.keyFile, evenLater, evenLater)

    const after = await negotiateTls(proxy.port)
    assert.equal(after.commonName, 'second.test')
    after.socket.destroy()
  } finally {
    await proxy.close()
  }
})

test('a certificate that cannot be read fails startPgProxy instead of serving plaintext', async () => {
  await assert.rejects(
    startPgProxy({
      port: 0,
      deps: depsFor(1),
      wakeTimeoutMs: 1000,
      tls: { certFile: '/nonexistent/cert.pem', keyFile: '/nonexistent/key.pem' },
    })
  )
})

test('isLoopbackAddress', () => {
  assert.equal(isLoopbackAddress('127.0.0.1'), true)
  assert.equal(isLoopbackAddress('127.8.9.10'), true)
  assert.equal(isLoopbackAddress('::1'), true)
  assert.equal(isLoopbackAddress('::ffff:127.0.0.1'), true)
  assert.equal(isLoopbackAddress('100.89.160.46'), false)
  assert.equal(isLoopbackAddress('::ffff:147.182.214.35'), false)
  assert.equal(isLoopbackAddress(undefined), false)
})
