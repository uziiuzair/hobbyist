// TLS termination for the Postgres wire proxy. ADR 0019.
//
// Postgres negotiates TLS in-band: the client sends an SSLRequest in the
// clear, the server answers one byte, 'S', and only then does the TLS
// handshake start, on the same TCP connection. The obvious implementation is
// to wrap the accepted socket in place with `new tls.TLSSocket(socket,
// { isServer: true })`. That works under Node and hangs under Bun (measured,
// Bun 1.3.14: the client's ClientHello is never answered), and the daemon
// runs on Bun (ADR 0006).
//
// So the handshake happens somewhere Bun does support: a real
// `tls.createServer` listening on an ephemeral loopback port. After the 'S',
// the proxy pipes the raw client socket into that server, and the server
// hands each decrypted connection back to the proxy's ordinary connection
// handler, which reads the startup packet as if TLS had never happened. The
// extra hop is a loopback copy per byte, which is nothing next to a network.
//
// Certificate renewal. certbot replaces the files behind a stable path.
// `server.setSecureContext()` is the documented way to pick that up, and it
// is also a no-op under Bun (measured, same version: the old certificate is
// still served after the call). So a changed certificate gets a new inner
// server instead, started beside the old one, which stops accepting and
// drains. The files are checked on each new TLS connection, by modification
// time, which costs two stat calls and nothing more.

import { statSync, readFileSync } from 'node:fs'
import net from 'node:net'
import tls from 'node:tls'

// Matches proxy.ts's grace for the same purpose.
const FORCE_CLOSE_GRACE_MS = 1000

export interface ProxyTlsFiles {
  certFile: string
  keyFile: string
}

interface Inner {
  server: tls.Server
  port: number
  // The pair of modification times this server was built from, so a check
  // can tell whether the files on disk are still the ones being served.
  stamp: string
}

function stampOf(files: ProxyTlsFiles): string {
  return `${statSync(files.certFile).mtimeMs}:${statSync(files.keyFile).mtimeMs}`
}

// Async so every failure is a rejection. The stat, the reads and
// tls.createServer all throw synchronously (a key that does not match its
// certificate throws from createServer), and a synchronous throw here would
// escape refresh's .catch and reach the client as an internal error instead
// of leaving the old certificate in service.
async function startInner(files: ProxyTlsFiles, onConnection: (socket: tls.TLSSocket) => void): Promise<Inner> {
  // Stamp before reading, so a renewal landing between the two reads makes
  // the stamp look stale and the next check rebuilds, rather than the
  // reverse, which would serve an old certificate under a new stamp forever.
  const stamp = stampOf(files)
  // Read synchronously and let a bad file throw here: a certificate that
  // cannot be loaded at startup is a configuration error the operator has
  // to see, not a proxy that quietly serves plaintext instead.
  const server = tls.createServer(
    { cert: readFileSync(files.certFile), key: readFileSync(files.keyFile), minVersion: 'TLSv1.2' },
    onConnection
  )
  return await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      // Same reasoning as the outer server in proxy.ts: a listener must stay
      // attached, or an accept-level error takes the whole process down.
      server.on('error', () => {})
      // A failed handshake (a scanner, a client that rejects the
      // certificate) arrives here, not on any socket the proxy holds.
      server.on('tlsClientError', () => {})
      const address = server.address()
      resolve({ server, port: typeof address === 'object' && address !== null ? address.port : 0, stamp })
    })
  })
}

export interface TlsTerminator {
  // Called after the proxy has written 'S'. Takes over the socket: pipes it
  // to the inner TLS server, whose decrypted connection arrives at the
  // onConnection handler given to startTlsTerminator.
  relay(client: net.Socket): void
  close(): Promise<void>
}

export async function startTlsTerminator(
  files: ProxyTlsFiles,
  onConnection: (socket: tls.TLSSocket) => void
): Promise<TlsTerminator> {
  let current = await startInner(files, onConnection)
  let rebuilding: Promise<void> | null = null
  let closed = false

  // Rebuilds when the files changed since `current` was built. Failures keep
  // the old server: a renewal caught halfway (one file replaced, the other
  // not yet) is a pair that does not match, and the next connection will
  // try again once both are in place.
  const refresh = (): Promise<void> => {
    if (rebuilding !== null) return rebuilding
    let stamp: string
    try {
      stamp = stampOf(files)
    } catch {
      return Promise.resolve()
    }
    if (stamp === current.stamp) return Promise.resolve()
    rebuilding = startInner(files, onConnection)
      .then((next) => {
        if (closed) {
          next.server.close()
          return
        }
        const old = current
        current = next
        old.server.close()
      })
      .catch(() => {})
      .finally(() => {
        rebuilding = null
      })
    return rebuilding
  }

  return {
    relay(client: net.Socket): void {
      // Paused before anything asynchronous: the client sends its
      // ClientHello the moment it reads the 'S', and a flowing socket with
      // no 'data' listener drops what arrives. pipe() resumes it.
      client.pause()
      refresh().then(() => {
        const upstream = net.createConnection({ host: '127.0.0.1', port: current.port })
        const finish = (): void => {
          client.destroy()
          upstream.destroy()
        }
        client.on('error', finish)
        upstream.on('error', finish)
        client.on('close', () => upstream.destroy())
        // end() then a forced destroy, for the same reason proxy.ts's
        // sendErrorAndClose has one: a peer that never acknowledges the FIN
        // would hold this socket half-open and keep server.close() from
        // resolving.
        upstream.on('close', () => {
          client.end()
          setTimeout(() => client.destroy(), FORCE_CLOSE_GRACE_MS).unref()
        })
        client.pipe(upstream)
        upstream.pipe(client)
      })
    },
    async close(): Promise<void> {
      closed = true
      await new Promise<void>((resolve) => current.server.close(() => resolve()))
    },
  }
}

// Loopback peers are the one place plaintext stays allowed once TLS is on:
// a password that never leaves the machine has nothing to be sniffed from,
// and `hobby connect` and apps on the same box should not need certificates
// for a hostname that resolves elsewhere.
export function isLoopbackAddress(address: string | undefined): boolean {
  if (address === undefined) return false
  return address.startsWith('127.') || address === '::1' || address.startsWith('::ffff:127.')
}
