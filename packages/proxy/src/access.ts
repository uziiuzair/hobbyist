// Per-project IP allowlists, the proxy's half. docs/proxy/CLAUDE.md, the
// 2026-11-17 amendment on allowlists, has the whole design; this file is the
// pieces proxy.ts, tls.ts and serverless.ts share.
//
// The decision needs two facts about a connection that the socket proxy.ts
// finally reads may not have: who the client really is, and whether it is
// this box. A TLS connection reaches proxy.ts through the terminator's
// loopback relay (tls.ts), and a serverless request through an in-memory
// pair (socket-pair.ts), so the socket in hand says 127.0.0.1 or nothing at
// all. Both facts are therefore read once, from the socket the outer server
// accepted, and carried along as a ClientAddress.

import { isIP } from 'node:net'
import { addressAllowed } from '@hobby.sh/core'
import { isLoopbackAddress } from './tls.js'

export interface ClientAddress {
  // The peer of the TCP connection the proxy accepted. Undefined only when
  // the origin was lost (a relay whose record is gone), which no allowlist
  // matches: a restricted project then refuses rather than guesses.
  address: string | undefined
  // The connection came from this machine: loopback, or dialed at a docker
  // network gateway the daemon binds for its own apps and workers. Exempt
  // from every allowlist, because an app on the box is the box.
  sameBox: boolean
}

export const UNKNOWN_CLIENT: ClientAddress = { address: undefined, sameBox: false }

// What startPgProxy uses when the daemon does not say more: a loopback peer,
// or a connection that arrived on a loopback address (on Docker Desktop and
// OrbStack an app container reaching host.docker.internal lands on the host's
// loopback listener, and nothing off the machine can reach that listener).
export function defaultSameBox(local: string | undefined, peer: string | undefined): boolean {
  return isLoopbackAddress(peer) || isLoopbackAddress(local)
}

// Strips the IPv4-mapped prefix a dual-stack listener puts on an IPv4 peer,
// so messages and log lines show the address the operator would type.
export function displayAddress(address: string | undefined): string {
  if (address === undefined) return 'an unknown address'
  if (address.startsWith('::ffff:') && isIP(address.slice(7)) === 4) return address.slice(7)
  return address
}

// What the daemon supplies, through ProxyDeps. Null is "no restriction".
export type AllowlistLookup = (project: string) => readonly string[] | null | Promise<readonly string[] | null>

export interface AccessRefusal {
  project: string
  address: string | undefined
  // Which path was refused: a startup packet (TCP, TLS, or a serverless
  // request's in-memory connection), or a CancelRequest.
  via: 'startup' | 'cancel'
}

export async function clientAllowed(
  lookup: AllowlistLookup | undefined,
  project: string,
  client: ClientAddress
): Promise<boolean> {
  if (lookup === undefined || client.sameBox) return true
  const entries = await lookup(project)
  if (entries === null) return true
  return addressAllowed(entries, client.address)
}

export function refusalMessage(project: string, client: ClientAddress): string {
  return `project ${project} does not accept connections from ${displayAddress(client.address)}: it is not on the project's allowlist (\`hobby allow ls ${project}\` on the box shows it)`
}

// Rate limit for refusal log lines. A scanner can send thousands of startups
// a minute, and the daemon log must stay readable and bounded: one line per
// address per window, carrying how many were folded into it. The map of
// tracked addresses is capped too, because a scanner rotating through an
// IPv6 range is a new address every time; past the cap, every untracked
// address shares one bucket.
export class RefusalLimiter {
  private readonly windowMs: number
  private readonly maxTracked: number
  private readonly now: () => number
  private readonly seen = new Map<string, { since: number; suppressed: number }>()

  constructor(opts: { windowMs?: number; maxTracked?: number; now?: () => number } = {}) {
    this.windowMs = opts.windowMs ?? 60_000
    this.maxTracked = opts.maxTracked ?? 1024
    this.now = opts.now ?? Date.now
  }

  // log: whether to write a line for this refusal. suppressed: how many
  // refusals from the same key went unlogged since the last line.
  admit(address: string): { log: boolean; suppressed: number; key: string } {
    const now = this.now()
    let key = address
    if (!this.seen.has(key) && this.seen.size >= this.maxTracked) {
      for (const [k, entry] of this.seen) {
        if (now - entry.since >= this.windowMs) this.seen.delete(k)
      }
      if (this.seen.size >= this.maxTracked) key = '(other addresses)'
    }
    const entry = this.seen.get(key)
    if (entry === undefined || now - entry.since >= this.windowMs) {
      const suppressed = entry?.suppressed ?? 0
      if (entry !== undefined) this.seen.delete(key)
      this.seen.set(key, { since: now, suppressed: 0 })
      return { log: true, suppressed, key }
    }
    entry.suppressed++
    return { log: false, suppressed: entry.suppressed, key }
  }
}

// The daemon log line for one admitted refusal. No credentials are ever in
// it: a startup packet's user is not logged, only the project and address.
export function refusalLogLine(refusal: AccessRefusal, key: string, suppressed: number): string {
  const what = refusal.via === 'cancel' ? 'a cancel request' : 'a connection'
  const from = key === '(other addresses)' ? `${displayAddress(refusal.address)} (and other addresses past the tracking cap)` : displayAddress(refusal.address)
  const more = suppressed > 0 ? `; ${suppressed} more refused from it since the last line about it` : ''
  return `proxy: refused ${what} to project ${refusal.project} from ${from}, not on its allowlist${more}`
}
