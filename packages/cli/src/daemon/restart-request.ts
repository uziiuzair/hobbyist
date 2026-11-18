// How the daemon tells "stop" from "restart" when the signal alone cannot.
//
// The proxy runs as its own process and survives a daemon restart
// (docs/proxy/specs/2026-11-18-proxy-outlives-the-daemon.md). Under systemd,
// `systemctl stop hobby` and `systemctl restart hobby` both arrive as the same
// SIGTERM: systemd implements a restart as a stop followed by a start, runs
// ExecStop= and ExecStopPost= for both, and passes nothing to the daemon or to
// those commands that says which one it is (systemd.service(5), ExecStop=).
// So the shipped unit (scripts/hobby.service) sets HOBBY_SIGTERM=stop, which
// makes SIGTERM a full stop that ends the proxy and frees its port, and a
// restart that keeps proxied sessions is asked for explicitly with
// `hobby daemon restart`:
//
//   1. the CLI writes the daemon's pid to $HOBBY_HOME/restart-request (0600);
//   2. it sends SIGTERM;
//   3. the daemon takes the request (it must name this pid and be fresh), shuts
//      down in restart mode, leaving the proxy up, and exits RESTART_EXIT_CODE;
//   4. the unit's RestartForceExitStatus=75 has systemd start it again, and the
//      new daemon adopts the proxy.
//
// Without a request SIGTERM means what HOBBY_SIGTERM says, which defaults to
// `restart` outside the unit, as it did before.

import { readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { HobbyError } from '@hobby.sh/core'
import type { ShutdownMode } from './server.js'

// EX_TEMPFAIL (sysexits.h): "try again". What a daemon exits with after a
// requested restart, so a supervisor that restarts on it (the unit's
// RestartForceExitStatus=75) starts the next one.
export const RESTART_EXIT_CODE = 75

// A request older than this is stale (a CLI that died between writing it and
// signalling), and is ignored rather than turning a later stop into a restart.
const REQUEST_TTL_MS = 60_000

export function restartRequestPath(home: string): string {
  return join(home, 'restart-request')
}

export function writeRestartRequest(home: string, pid: number): void {
  writeFileSync(restartRequestPath(home), `${pid}\n`, { mode: 0o600 })
}

// True when a fresh request names this pid. The file is removed either way,
// so a request is used at most once.
export function takeRestartRequest(home: string, pid: number = process.pid, now: number = Date.now()): boolean {
  const path = restartRequestPath(home)
  let body: string
  let mtimeMs: number
  try {
    body = readFileSync(path, 'utf8')
    mtimeMs = statSync(path).mtimeMs
  } catch {
    return false
  }
  try {
    rmSync(path, { force: true })
  } catch {
    // Unremovable: still answered below, and the pid check keeps a stale one
    // from applying to the next daemon.
  }
  return body.trim() === String(pid) && now - mtimeMs < REQUEST_TTL_MS
}

// HOBBY_SIGTERM: what a plain SIGTERM means. `stop` in the shipped systemd
// unit; `restart` (the default) otherwise. Anything else is refused at start
// rather than guessed at.
export function sigtermModeFromEnv(env: NodeJS.ProcessEnv): ShutdownMode {
  const raw = env.HOBBY_SIGTERM
  if (raw === undefined || raw === '' || raw === 'restart') return 'restart'
  if (raw === 'stop') return 'stop'
  throw new HobbyError('usage', `HOBBY_SIGTERM must be "stop" or "restart", got "${raw}"`)
}

// What a SIGTERM does: a restart `hobby daemon restart` asked for (exiting
// RESTART_EXIT_CODE so a supervisor starts the next daemon), else what
// HOBBY_SIGTERM configured, exiting 0. server.ts's SIGTERM handler.
export function onSigterm(home: string, configured: ShutdownMode, pid: number = process.pid): { mode: ShutdownMode; exitCode: number; requested: boolean } {
  if (takeRestartRequest(home, pid)) return { mode: 'restart', exitCode: RESTART_EXIT_CODE, requested: true }
  return { mode: configured, exitCode: 0, requested: false }
}
