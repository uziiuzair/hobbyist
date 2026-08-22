// Where the CLI keeps which box it talks to, and the token for it (ADR 0018).
//
// Deliberately NOT hobby.json. That file is a project file: it belongs in a
// repository, it gets committed, and resolveConfig finds it by walking up from
// the working directory, so every directory beneath one inherits whatever it
// holds. A credential in there is a credential in someone's git history.
//
// This file is per machine, lives beside the daemon's own state, and is 0600.

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { HobbyError, type Paths } from '@hobby.sh/core'

export interface RemoteCredential {
  readonly url: string
  readonly token: string
  readonly name: string
  readonly addedAt: string
}

interface CredentialFile {
  current: string | null
  remotes: Record<string, RemoteCredential>
}

const EMPTY: CredentialFile = { current: null, remotes: {} }

function credentialsPath(paths: Paths): string {
  return join(paths.home, 'credentials.json')
}

export function readCredentials(paths: Paths): CredentialFile {
  const path = credentialsPath(paths)
  if (!existsSync(path)) {
    return { ...EMPTY, remotes: {} }
  }
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
    if (typeof parsed !== 'object' || parsed === null) return { ...EMPTY, remotes: {} }
    const file = parsed as Partial<CredentialFile>
    return {
      current: typeof file.current === 'string' ? file.current : null,
      remotes: typeof file.remotes === 'object' && file.remotes !== null ? file.remotes : {},
    }
  } catch {
    return { ...EMPTY, remotes: {} }
  }
}

function writeCredentials(paths: Paths, file: CredentialFile): void {
  writeFileSync(credentialsPath(paths), `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 })
}

export function saveRemote(paths: Paths, cred: RemoteCredential): void {
  const file = readCredentials(paths)
  file.remotes[cred.url] = cred
  file.current = cred.url
  writeCredentials(paths, file)
}

export function forgetRemote(paths: Paths, url: string | null): string | null {
  const file = readCredentials(paths)
  const target = url ?? file.current
  if (target === null || file.remotes[target] === undefined) {
    return null
  }
  delete file.remotes[target]
  if (file.current === target) {
    // Fall back to whatever else is configured rather than leaving `current`
    // pointing at something that no longer exists.
    file.current = Object.keys(file.remotes)[0] ?? null
  }
  writeCredentials(paths, file)
  return target
}

// Which remote a command should use, or null to mean the local unix socket.
//
// HOBBY_REMOTE wins over the stored current, so a single command can be aimed
// at another box without changing what every other command does.
export function activeRemote(paths: Paths, env: NodeJS.ProcessEnv): RemoteCredential | null {
  const file = readCredentials(paths)
  const override = env.HOBBY_REMOTE
  if (typeof override === 'string' && override.length > 0) {
    const found = file.remotes[override]
    if (found === undefined) {
      throw new HobbyError(
        'usage',
        `HOBBY_REMOTE is ${override}, which is not a remote you are logged in to`,
        'run `hobby login <url>` for it, or `hobby remote ls` to see what is configured'
      )
    }
    return found
  }
  if (file.current === null) return null
  return file.remotes[file.current] ?? null
}

export function listRemotes(paths: Paths): { current: string | null; remotes: RemoteCredential[] } {
  const file = readCredentials(paths)
  return { current: file.current, remotes: Object.values(file.remotes) }
}
