// Entry point of the proxy process (packages/cli/bin/hobby-proxy.js). Started
// by the daemon (spawnProxy in packages/cli/src/daemon/proxy-link.ts), never by
// hand, with its configuration in HOBBY_PROXYD_CONFIG.
//
// Signals: SIGTERM and SIGINT stop it, which ends every proxied session. SIGHUP
// is ignored, so a terminal closing behind `hobby daemon &` does not take the
// proxy with it (it is also in its own session, see spawnProxy).

import type { ProxydConfig } from './protocol.js'
import { startProxyHost } from './host.js'

export async function proxydMain(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const raw = env.HOBBY_PROXYD_CONFIG
  if (raw === undefined) {
    console.error('hobby-proxy: HOBBY_PROXYD_CONFIG is not set; this process is started by `hobby daemon`')
    process.exit(2)
  }
  const config = JSON.parse(raw) as ProxydConfig
  process.on('SIGHUP', () => {})
  let host: Awaited<ReturnType<typeof startProxyHost>>
  try {
    host = await startProxyHost(config, { onStopped: () => process.exit(0) })
  } catch (err) {
    console.error(`${new Date().toISOString()} proxy: could not start: ${err instanceof Error ? err.message : String(err)}`)
    process.exit(1)
  }
  const onSignal = (): void => {
    void host.stop()
  }
  process.on('SIGTERM', onSignal)
  process.on('SIGINT', onSignal)
}
