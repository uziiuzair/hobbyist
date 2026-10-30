// API tokens (ADR 0018): the credential a program holds, as opposed to the
// session cookie a browser holds.
//
// Only a hash is ever stored, using the same argon2id parameters as the
// operator credential, so this file is not a list of live credentials and a
// leaked copy of it does not let anyone in. The plaintext exists exactly once,
// in the response to the call that created it, and is never recoverable
// afterwards.
//
// A token is as powerful as the operator password: ADR 0018 says so plainly and
// declines to invent scopes for a single-operator tool. What tokens buy over
// sharing the password is that they are named and individually revocable, so a
// lost laptop costs one `hobby token rm` rather than a password rotation across
// every machine.

import { createHash, randomBytes } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { HobbyError, type Paths } from '@hobby.sh/core'
import { hashPassword, verifyPassword } from './auth.js'

// 32 bytes, the same as a session token, encoded base64url so it is safe in an
// Authorization header with no escaping. The `hob_` prefix is not security: it
// exists so a token found in a shell history or a log is recognisably ours and
// can be searched for and revoked.
const TOKEN_BYTES = 32
const TOKEN_PREFIX = 'hob_'

export interface ApiTokenRecord {
  readonly name: string
  readonly hash: string
  readonly createdAt: string
  // The last 6 characters of the plaintext, so `hobby token ls` can show
  // something a human can match against the value their laptop is holding
  // without the stored file containing anything usable.
  readonly tail: string
  // The first LOOKUP_CHARS hex characters of SHA-256(plaintext) (issue
  // #118). Not a secret and not a credential: 32 bits of a one-way hash of
  // a 256-bit random token narrows a brute force by nothing that matters,
  // and it lets verifyToken find the one record a presented token could
  // match before paying for argon2, instead of paying once per stored
  // token. Absent on records written before this field existed; those are
  // verified the old way and re-keyed on their first successful use.
  readonly lookup?: string
}

const LOOKUP_CHARS = 8

export function tokenLookupKey(plain: string): string {
  return createHash('sha256').update(plain, 'utf8').digest('hex').slice(0, LOOKUP_CHARS)
}

function tokensPath(paths: Paths): string {
  return join(paths.home, 'api-tokens.json')
}

export function readTokens(paths: Paths): ApiTokenRecord[] {
  const path = tokensPath(paths)
  if (!existsSync(path)) {
    return []
  }
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
    return Array.isArray(parsed) ? (parsed as ApiTokenRecord[]) : []
  } catch {
    // A corrupt token file must not lock the operator out of the box itself:
    // the unix socket needs no token, so `hobby token ls` still works locally
    // and can rewrite it. Treating it as empty is the recoverable failure.
    return []
  }
}

function writeTokens(paths: Paths, tokens: ApiTokenRecord[]): void {
  writeFileSync(tokensPath(paths), `${JSON.stringify(tokens, null, 2)}\n`, { mode: 0o600 })
}

export function tokenNameExists(paths: Paths, name: string): boolean {
  return readTokens(paths).some((t) => t.name === name)
}

// Returns the plaintext, which the caller must show once and then forget.
export async function issueToken(paths: Paths, name: string): Promise<string> {
  const trimmed = name.trim()
  if (trimmed.length === 0) {
    throw new HobbyError('usage', 'a token needs a name', 'for example: hobby token create laptop')
  }
  if (tokenNameExists(paths, trimmed)) {
    throw new HobbyError('name_taken', `a token named ${trimmed} already exists`, 'pick another name, or remove that one first')
  }

  const plain = TOKEN_PREFIX + randomBytes(TOKEN_BYTES).toString('base64url')
  const record: ApiTokenRecord = {
    name: trimmed,
    hash: await hashPassword(plain),
    createdAt: new Date().toISOString(),
    tail: plain.slice(-6),
    lookup: tokenLookupKey(plain),
  }
  writeTokens(paths, [...readTokens(paths), record])
  return plain
}

export function revokeToken(paths: Paths, name: string): boolean {
  const before = readTokens(paths)
  const after = before.filter((t) => t.name !== name)
  if (after.length === before.length) {
    return false
  }
  writeTokens(paths, after)
  return true
}

// At most one argon2 verify per request for a token minted with a lookup
// key (issue #118): the candidate is the record whose stored lookup equals
// the presented token's, and a token matching no record costs a SHA-256 and
// a file read, about what a request with no header costs. A wrong token
// that happens to share a lookup key with a real one costs one verify, the
// same as the right token does, so timing does not say which.
//
// Records without a lookup key were written before the field existed and
// are verified the old way, every one of them, so an upgrade never locks a
// laptop out. The first successful verify writes the key onto the record,
// so the slow path runs once per legacy token rather than forever.
export async function verifyToken(paths: Paths, presented: string): Promise<boolean> {
  if (!presented.startsWith(TOKEN_PREFIX)) {
    return false
  }
  const tokens = readTokens(paths)
  const lookup = tokenLookupKey(presented)

  for (const record of tokens) {
    if (record.lookup === lookup && (await verifyPassword(presented, record.hash))) {
      return true
    }
  }

  let matchedLegacy: ApiTokenRecord | null = null
  for (const record of tokens) {
    if (record.lookup === undefined && (await verifyPassword(presented, record.hash))) {
      matchedLegacy = record
    }
  }
  if (matchedLegacy === null) {
    return false
  }
  rekeyLegacyToken(paths, matchedLegacy, lookup)
  return true
}

// Best effort: the verify already succeeded, and a token file that cannot be
// rewritten right now (read-only home, a concurrent `hobby token rm`) is
// not a reason to refuse a request that presented the right credential.
function rekeyLegacyToken(paths: Paths, matched: ApiTokenRecord, lookup: string): void {
  try {
    const current = readTokens(paths)
    const updated = current.map((t) => (t.name === matched.name && t.hash === matched.hash ? { ...t, lookup } : t))
    writeTokens(paths, updated)
  } catch {
    // The next successful verify tries again.
  }
}

// Reads a bearer token from the Authorization header. Returns null rather than
// throwing for anything malformed, so an unparseable header falls through to
// the session cookie check and then to a 401, which is the same answer a wrong
// token gets.
export function readBearerToken(header: string | string[] | undefined): string | null {
  const value = Array.isArray(header) ? header[0] : header
  if (typeof value !== 'string') {
    return null
  }
  const match = /^Bearer\s+(\S+)$/i.exec(value.trim())
  return match === null ? null : (match[1] ?? null)
}
