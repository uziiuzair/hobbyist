// Per-project IP allowlists: the parsing and matching half, shared by the
// daemon (which validates and stores entries) and the proxy (which matches a
// client address against them on every connection). Pure, no I/O.
//
// Written for Hobbyist, after the shape of Xata's gateway filter
// (services/gateway/ipfiltering/filter.go, Apache-2.0): an entry is an
// address or a CIDR range, a bare address is the range holding only itself,
// and a client address that cannot be parsed is refused rather than let
// through. No code is taken from it; Node has no netip, so the parsing below
// is our own, done on bigints so IPv4 and IPv6 share one comparison.
//
// What an allowlist means is the proxy's business (docs/proxy/CLAUDE.md,
// the 2026-11-17 amendment on allowlists): null is "no restriction", a list,
// even an empty one, is "only these, plus this box itself".

import { HobbyError } from './errors.js'

export interface AllowEntry {
  // How the entry is stored and shown: a bare address for a single host
  // (`203.0.113.7`, `2001:db8::1`), otherwise `network/prefix` with the host
  // bits cleared (`192.168.1.0/24`).
  canonical: string
  family: 4 | 6
  network: bigint
  prefix: number
}

// Enough for any real allowlist, small enough that matching every entry on
// every connection costs nothing and a stored row stays a row.
export const MAX_ALLOWLIST_ENTRIES = 256

const IPV4_BITS = 32
const IPV6_BITS = 128

function parseIpv4(text: string): bigint | null {
  const parts = text.split('.')
  if (parts.length !== 4) return null
  let value = 0n
  for (const part of parts) {
    // Leading zeros refused: inet_aton reads `010` as octal 8, and an
    // allowlist is the last place a typo should change meaning.
    if (!/^(0|[1-9][0-9]{0,2})$/.test(part)) return null
    const n = Number(part)
    if (n > 255) return null
    value = (value << 8n) | BigInt(n)
  }
  return value
}

function parseIpv6(text: string): bigint | null {
  if (text.length === 0 || text.length > 45) return null
  const halves = text.split('::')
  if (halves.length > 2) return null
  const groupsOf = (half: string): number[] | null => {
    if (half === '') return []
    const out: number[] = []
    const parts = half.split(':')
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i]!
      // The last group may be a dotted IPv4 address (`::ffff:192.0.2.1`).
      if (i === parts.length - 1 && part.includes('.')) {
        const v4 = parseIpv4(part)
        if (v4 === null) return null
        out.push(Number(v4 >> 16n), Number(v4 & 0xffffn))
        continue
      }
      if (!/^[0-9a-fA-F]{1,4}$/.test(part)) return null
      out.push(parseInt(part, 16))
    }
    return out
  }
  const head = groupsOf(halves[0]!)
  const tail = halves.length === 2 ? groupsOf(halves[1]!) : []
  if (head === null || tail === null) return null
  let groups: number[]
  if (halves.length === 2) {
    const missing = 8 - head.length - tail.length
    if (missing < 1) return null
    groups = [...head, ...new Array<number>(missing).fill(0), ...tail]
  } else {
    groups = head
  }
  if (groups.length !== 8) return null
  return groups.reduce((acc, g) => (acc << 16n) | BigInt(g), 0n)
}

// ::ffff:0:0/96, the IPv4-mapped block. A dual-stack listener reports an
// IPv4 peer as `::ffff:203.0.113.7`, so both a client address and an entry
// in this block are folded to IPv4 before anything is compared.
const MAPPED_HIGH_BITS = 0xffffn

function formatIpv4(value: bigint): string {
  return [24n, 16n, 8n, 0n].map((shift) => String((value >> shift) & 0xffn)).join('.')
}

// RFC 5952: lowercase, no leading zeros, the longest run of two or more zero
// groups (the first, on a tie) written as `::`.
function formatIpv6(value: bigint): string {
  const groups: number[] = []
  for (let i = 7; i >= 0; i--) groups.push(Number((value >> BigInt(i * 16)) & 0xffffn))
  let bestStart = -1
  let bestLength = 1
  for (let i = 0; i < 8; ) {
    if (groups[i] !== 0) {
      i++
      continue
    }
    let j = i
    while (j < 8 && groups[j] === 0) j++
    if (j - i > bestLength) {
      bestStart = i
      bestLength = j - i
    }
    i = j
  }
  const hex = groups.map((g) => g.toString(16))
  if (bestStart === -1) return hex.join(':')
  return `${hex.slice(0, bestStart).join(':')}::${hex.slice(bestStart + bestLength).join(':')}`
}

interface ParsedAddress {
  family: 4 | 6
  value: bigint
}

function parseAddress(text: string): ParsedAddress | null {
  const v4 = parseIpv4(text)
  if (v4 !== null) return { family: 4, value: v4 }
  const v6 = parseIpv6(text)
  if (v6 === null) return null
  if (v6 >> 32n === MAPPED_HIGH_BITS) return { family: 4, value: v6 & 0xffffffffn }
  return { family: 6, value: v6 }
}

function mask(bits: number, prefix: number): bigint {
  return prefix === 0 ? 0n : ((1n << BigInt(prefix)) - 1n) << BigInt(bits - prefix)
}

function usage(text: string, why: string): HobbyError {
  return new HobbyError(
    'usage',
    `${JSON.stringify(text)} is not an IP address or CIDR range: ${why}`,
    'use an address (203.0.113.7, 2001:db8::1) or a range (192.168.1.0/24, 2001:db8::/32)'
  )
}

// Throws a usage HobbyError naming the entry, so a CLI or MCP caller sees
// exactly which of several entries was wrong.
export function parseAllowEntry(text: string): AllowEntry {
  const trimmed = text.trim()
  const slash = trimmed.indexOf('/')
  const addressText = slash === -1 ? trimmed : trimmed.slice(0, slash)
  if (addressText.includes('%')) throw usage(text, 'a zone index (%eth0) cannot be allowlisted')
  const raw6 = parseIpv6(addressText)
  const address = parseAddress(addressText)
  if (address === null) throw usage(text, 'the address does not parse')
  let bits = address.family === 4 ? IPV4_BITS : IPV6_BITS
  let prefix = bits
  if (slash !== -1) {
    const prefixText = trimmed.slice(slash + 1)
    if (!/^(0|[1-9][0-9]{0,2})$/.test(prefixText)) throw usage(text, 'the prefix length is not a number')
    prefix = Number(prefixText)
    // A mapped address written as IPv6 has a /96 to /128 prefix; folded to
    // IPv4 above, its prefix folds with it.
    if (raw6 !== null && address.family === 4) {
      if (prefix < 96) throw usage(text, 'a range over ::ffff:0:0/96 must be /96 or narrower')
      prefix -= 96
    }
    if (prefix > bits) throw usage(text, `the prefix length is more than ${bits}`)
  }
  bits = address.family === 4 ? IPV4_BITS : IPV6_BITS
  const network = address.value & mask(bits, prefix)
  const formatted = address.family === 4 ? formatIpv4(network) : formatIpv6(network)
  return {
    canonical: prefix === bits ? formatted : `${formatted}/${prefix}`,
    family: address.family,
    network,
    prefix,
  }
}

// Canonical, deduplicated, in the order given. Throws on the first bad
// entry, and when the result would be longer than MAX_ALLOWLIST_ENTRIES.
export function canonicalAllowlist(entries: readonly string[]): string[] {
  const out: string[] = []
  for (const entry of entries) {
    const { canonical } = parseAllowEntry(entry)
    if (!out.includes(canonical)) out.push(canonical)
  }
  if (out.length > MAX_ALLOWLIST_ENTRIES) {
    throw new HobbyError(
      'usage',
      `an allowlist holds at most ${MAX_ALLOWLIST_ENTRIES} entries`,
      'cover neighbouring addresses with one CIDR range'
    )
  }
  return out
}

// A socket's remoteAddress, folded to the form entries are compared in: a
// zone index dropped, an IPv4-mapped IPv6 address read as IPv4. Null for
// anything that does not parse, which never matches.
export function parseClientAddress(address: string | undefined): ParsedAddress | null {
  if (address === undefined) return null
  const percent = address.indexOf('%')
  return parseAddress(percent === -1 ? address : address.slice(0, percent))
}

// Whether `address` falls inside any entry. Stored entries were validated on
// the way in; one that no longer parses (a hand-edited state file) is
// skipped rather than throwing on a live connection, which can only make the
// list narrower, never wider.
export function addressAllowed(entries: readonly string[], address: string | undefined): boolean {
  const client = parseClientAddress(address)
  if (client === null) return false
  for (const text of entries) {
    let entry: AllowEntry
    try {
      entry = parseAllowEntry(text)
    } catch {
      continue
    }
    if (entry.family !== client.family) continue
    const bits = entry.family === 4 ? IPV4_BITS : IPV6_BITS
    if ((client.value & mask(bits, entry.prefix)) === entry.network) return true
  }
  return false
}
