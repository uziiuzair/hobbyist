// Tailnet detection for connection strings. The proxy already answers on
// the tailnet interface because startPgProxy binds 0.0.0.0 (verified in
// docs/proxy/research/2026-08-13-postgres-over-tailnet.md); the only thing
// missing was telling the user the address. This asks the host's own
// `tailscale` CLI, the BYO model from that doc: Hobbyist never manages
// tailscaled, it only notices one.

import { execFile } from 'node:child_process'

// `tailscale status --json` prints BackendState and Self.DNSName. DNSName
// arrives with a trailing dot (a DNS FQDN, `box.tail1234.ts.net.`), which
// psql would technically accept but no one writes by hand, so it is
// stripped. Anything short of a running backend with a non-empty name is
// null: NeedsLogin, Stopped, a Self-less reply, or output that is not JSON
// at all (a PATH shim printing an error, say).
export function parseTailscaleStatus(stdout: string): string | null {
  let status: unknown
  try {
    status = JSON.parse(stdout)
  } catch {
    return null
  }
  if (typeof status !== 'object' || status === null) return null
  const record = status as { BackendState?: unknown; Self?: { DNSName?: unknown } }
  if (record.BackendState !== 'Running') return null
  const dnsName = record.Self?.DNSName
  if (typeof dnsName !== 'string' || dnsName === '') return null
  return dnsName.endsWith('.') ? dnsName.slice(0, -1) : dnsName
}

// The macOS app installs the CLI at /usr/local/bin (Homebrew's Apple
// Silicon prefix is /opt/homebrew/bin), and Linux packages use /usr/bin.
// A daemon started by launchd or systemd gets a minimal PATH that may hold
// none of them, so the bare name is tried first and the known homes after.
// The DNSName parser above answers "what should a connection string say".
// Binding needs an address, not a name: MagicDNS may be off, and a listener
// should not depend on the resolver of the machine it is running on.
// Self.TailscaleIPs is ordered v4 first, which is what we want to bind.
export function parseTailscaleIp(stdout: string): string | null {
  let status: unknown
  try {
    status = JSON.parse(stdout)
  } catch {
    return null
  }
  if (typeof status !== 'object' || status === null) return null
  const self = (status as { Self?: unknown }).Self
  if (typeof self !== 'object' || self === null) return null
  const ips = (self as { TailscaleIPs?: unknown }).TailscaleIPs
  if (!Array.isArray(ips)) return null
  for (const ip of ips) {
    if (typeof ip === 'string' && ip.includes('.')) return ip
  }
  return null
}

const TAILSCALE_CANDIDATES = ['tailscale', '/usr/local/bin/tailscale', '/opt/homebrew/bin/tailscale', '/usr/bin/tailscale']

function runTailscaleStatus(): Promise<string> {
  let attempt = 0
  const tryNext = (resolve: (v: string) => void, reject: (e: Error) => void): void => {
    const candidate = TAILSCALE_CANDIDATES[attempt]
    if (candidate === undefined) {
      reject(new Error('no tailscale binary found'))
      return
    }
    attempt++
    execFile(candidate, ['status', '--json'], { timeout: 2000 }, (err, stdout) => {
      if (err === null) resolve(stdout)
      else tryNext(resolve, reject)
    })
  }
  return new Promise(tryNext)
}

// Cached because the caller is a daemon route: a Studio page or an MCP
// agent asking for a handful of connection strings should cost one exec,
// not one per string. Null is cached too, deliberately: a box with no
// tailscale should not pay a four-candidate spawn cascade on every
// request. 30 seconds means a freshly started tailscaled shows up within
// half a minute, which matches how often anyone joins a tailnet.
const DEFAULT_TTL_MS = 30_000

export function createTailnetDetector(opts?: {
  run?: () => Promise<string>
  ttlMs?: number
  now?: () => number
}): () => Promise<string | null> {
  const run = opts?.run ?? runTailscaleStatus
  const ttlMs = opts?.ttlMs ?? DEFAULT_TTL_MS
  const now = opts?.now ?? Date.now
  let cached: { value: string | null; at: number } | null = null
  return async () => {
    if (cached !== null && now() - cached.at < ttlMs) return cached.value
    let value: string | null
    try {
      value = parseTailscaleStatus(await run())
    } catch {
      value = null
    }
    cached = { value, at: now() }
    return value
  }
}
