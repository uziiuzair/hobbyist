// Which addresses the wire-protocol proxy binds, from the proxyHost setting
// (ADR 0017):
//
//   "all"      every interface. The pre-0.1 default, now opt in and spelled out
//   "tailnet"  loopback plus this machine's Tailscale address
//   anything   bound literally
//
// Lived in server.ts until issue #108: `hobby init` said "host is
// ready" for a proxyHost the daemon then refused ("bogus", an address not on
// this machine, "tailnet" with no tailscaled), because preflight never ran
// this resolution. It is its own module so preflight.ts can call exactly
// what startDaemon calls without importing server.ts (which imports caddy.ts,
// which imports preflight.ts: a cycle).
//
// The default is loopback, because the proxy speaks no TLS: it answers an
// SSLRequest with N, so anything reaching it across a network sends its
// password in cleartext. Two boxes installed from hobby.sh/install were
// measured reachable from the open internet before this existed
// (docs/proxy/research/2026-08-22-the-proxy-binds-every-interface.md).

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { HobbyError } from '@hobby.sh/core'
import type { DaemonContext } from './context.js'
import { parseTailscaleIp } from './tailnet.js'

const execFileAsync = promisify(execFile)

export async function resolveProxyHosts(ctx: Pick<DaemonContext, 'config'>): Promise<string[]> {
  const setting = ctx.config.proxyHost.trim()

  if (setting === 'all') {
    return ['0.0.0.0']
  }

  if (setting !== 'tailnet') {
    return [setting]
  }

  let ip: string | null = null
  try {
    const { stdout } = await execFileAsync('tailscale', ['status', '--json'])
    ip = parseTailscaleIp(stdout)
  } catch {
    ip = null
  }

  if (ip === null) {
    // Loud and fatal rather than a quiet fallback. Falling back to loopback
    // would look like it worked and leave the operator's other machines
    // unable to connect with no reason given; falling back to every
    // interface would silently do the thing this decision exists to stop.
    throw new HobbyError(
      'usage',
      'proxyHost is "tailnet" but no tailscale address could be found',
      'Start tailscaled, or set proxyHost to an address, to "all", or remove it to use loopback.'
    )
  }

  return ['127.0.0.1', ip]
}
