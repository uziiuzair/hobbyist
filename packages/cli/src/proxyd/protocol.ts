// The link between the daemon and the separate proxy process.
//
// docs/proxy/specs/2026-11-18-proxy-outlives-the-daemon.md is the design. In
// short: the proxy process listens on a unix socket ($HOBBY_HOME/proxy.sock),
// the daemon dials it, and the two exchange newline-delimited JSON. The proxy
// asks (wake), the daemon acts and answers. The proxy reports every proxied
// connection opening and closing, so the daemon's ActivityTracker, which the
// hibernator reads, sees exactly what it saw when the proxy ran in-process.
//
// This file holds only what both ends must agree on: the messages, the
// framing, and the two hashes the daemon compares to decide whether a proxy it
// finds running can be adopted.

import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type net from 'node:net'

// Bumped whenever a message below changes shape. A daemon never adopts a
// proxy speaking another version; it restarts it.
export const PROXY_LINK_PROTOCOL = 1

// The mode both unix sockets get right after listen: the daemon's API socket
// (hobby.sock, server.ts) and this proxy's control socket (proxy.sock,
// proxyd/host.ts). Owner-only. HOBBY_HOME is already 0700, so for proxy.sock
// this is defence in depth: whoever can dial it can stop the proxy.
export const SOCKET_MODE = 0o600

// What the proxy process is started with. Serialised into its environment
// (HOBBY_PROXYD_CONFIG) by the daemon. Nothing here is secret: the TLS entries
// are file paths, and the key file's bytes are only ever hashed.
export interface ProxydConfig {
  socketPath: string
  statePath: string
  port: number
  // The configured bind addresses (resolveProxyHosts in
  // packages/cli/src/daemon/proxy-hosts.ts). Docker network gateways are not
  // here: the daemon sends them as `listen` messages, on adoption and as
  // networks are created, because they change while the proxy runs.
  hosts: string[]
  wakeTimeoutMs: number
  tls: { certFile: string; keyFile: string } | null
}

export interface LiveConnection {
  id: number
  resourceId: string
}

// Proxy to daemon.
export type ProxyMessage =
  | {
      t: 'hello'
      protocol: number
      fingerprint: string
      configKey: string
      pid: number
      // The port the proxy actually bound (differs from config.port only when
      // that was 0, which tests use).
      port: number
      // For the daemon's log only: what attaching would bring with it.
      live: LiveConnection[]
    }
  // The answer to `attach`: the live connections as of the moment this link
  // became the one events are sent on, so none is counted twice or missed.
  | { t: 'attached'; live: LiveConnection[] }
  | { t: 'open'; id: number; resourceId: string }
  | { t: 'close'; id: number }
  | { t: 'wake'; req: number; resourceId: string }

// The answer to a wake. `leaving` means this daemon is shutting down and the
// proxy should ask the next one. `retryAt` is the daemon's wake refusal
// (WakeRefusal.retryAt, epoch ms) when the failed wake left one.
export type WakeResult =
  | { t: 'wake_result'; req: number; ok: true }
  | {
      t: 'wake_result'
      req: number
      ok: false
      leaving?: boolean
      code?: string
      message: string
      hint?: string
      retryAt?: number | null
    }

// Daemon to proxy. A connection that never sends `attach` is a probe (`hobby
// init`'s preflight): it gets the hello and nothing else, and cannot displace
// the daemon that is linked. Only an attached link may send the rest.
export type DaemonMessage = { t: 'attach' } | WakeResult | { t: 'listen'; host: string } | { t: 'stop' }

export function send(socket: net.Socket, message: ProxyMessage | DaemonMessage): void {
  if (!socket.destroyed && socket.writable) {
    socket.write(`${JSON.stringify(message)}\n`)
  }
}

// Splits a socket's bytes into JSON lines. A line that does not parse ends the
// link: the other side is not speaking this protocol.
export function onMessages<T>(socket: net.Socket, handle: (message: T) => void): void {
  let buffer = ''
  socket.setEncoding('utf8')
  socket.on('data', (chunk: string) => {
    buffer += chunk
    let newline = buffer.indexOf('\n')
    while (newline !== -1) {
      const line = buffer.slice(0, newline)
      buffer = buffer.slice(newline + 1)
      if (line.length > 0) {
        let message: T
        try {
          message = JSON.parse(line) as T
        } catch {
          socket.destroy()
          return
        }
        handle(message)
      }
      newline = buffer.indexOf('\n')
    }
  })
}

// A hash of the compiled code the proxy process runs: @hobby.sh/proxy,
// @hobby.sh/core, this directory, and the shared resolver. The proxy computes
// it once at start, over the files it has just loaded; the daemon computes it
// over what is on disk now. Equal means `hobby update` did not change anything
// the proxy runs, so adopting it keeps its sessions; different means the
// daemon restarts it.
export function proxyCodeFingerprint(): string {
  const require = createRequire(import.meta.url)
  const here = dirname(fileURLToPath(import.meta.url))
  const dirs = [
    dirname(require.resolve('@hobby.sh/proxy')),
    dirname(require.resolve('@hobby.sh/core')),
    here,
  ]
  const files = [join(here, '..', 'daemon', 'proxy-resolve.js')]
  for (const dir of dirs) {
    for (const name of readdirSync(dir).sort()) {
      if (name.endsWith('.js')) files.push(join(dir, name))
    }
  }
  const hash = createHash('sha256')
  for (const file of files) {
    hash.update(file)
    hash.update('\0')
    hash.update(readFileSync(file))
    hash.update('\0')
  }
  return hash.digest('hex').slice(0, 16)
}

// A hash of what the proxy was started with, the TLS files' contents
// included, so a renewed certificate is picked up the next time the daemon
// starts, exactly as it was when the proxy lived in the daemon. A file that
// cannot be read hashes as missing; the proxy itself then fails to start and
// says why.
export function proxyConfigKey(config: ProxydConfig): string {
  const hash = createHash('sha256')
  hash.update(
    JSON.stringify({
      statePath: config.statePath,
      port: config.port,
      hosts: config.hosts,
      wakeTimeoutMs: config.wakeTimeoutMs,
      tls: config.tls,
    })
  )
  if (config.tls !== null) {
    for (const file of [config.tls.certFile, config.tls.keyFile]) {
      hash.update('\0')
      try {
        hash.update(readFileSync(file))
      } catch {
        hash.update('missing')
      }
    }
  }
  return hash.digest('hex').slice(0, 16)
}
