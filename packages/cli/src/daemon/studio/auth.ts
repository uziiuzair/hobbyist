// The operator credential (ADR 0008). One credential, no accounts, hashed
// with Argon2id, and the only two things that ever touch it are
// setOperatorPassword (which `hobby studio passwd` must call, see the task
// report for the exact CLI wiring) and the login route in routes.ts.
//
// On the argon2id-versus-scrypt decision: this task tried to add the
// `argon2` package as a real dependency before writing a single line here.
// It installed cleanly and its prebuilt native binding loaded and ran
// (verified against `argon2.hash`/`argon2.verify` directly, and prebuilds
// exist for linux-x64, the real deployment target, not just this dev
// machine's darwin-arm64). Because it installed and worked, this file uses
// it directly and does NOT fall back to node:crypto's scrypt: the brief's
// instruction was to substitute scrypt only if argon2 failed to install, not
// to hedge when it does not fail. State this plainly in the report: there is
// no scrypt code path in this file to review, because the fallback was never
// triggered.

import { HobbyError, type Paths } from '@hobby.sh/core'
import argon2, { type HashOptions } from 'argon2'
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

// Argon2id specifically, never argon2i or argon2d: argon2i alone (the
// package's own default) trades some resistance to GPU/ASIC cracking for
// resistance to a side-channel that does not apply to a server-side
// password hash with no attacker code running on the same machine.
// Argon2id is the hybrid OWASP recommends for exactly this case. Cost
// parameters are the package's own defaults (64 MiB memory, time cost 3,
// parallelism 4), which already exceed OWASP's stated minimum (19 MiB,
// t=2, p=1): this credential is checked at most a few times a day by one
// person, so the extra cost is free in practice and expensive to brute
// force.
const ARGON2_OPTIONS: HashOptions = { type: argon2.argon2id }

export async function hashPassword(plain: string): Promise<string> {
  return argon2.hash(plain, ARGON2_OPTIONS)
}

export async function verifyPassword(plain: string, stored: string): Promise<boolean> {
  try {
    return await argon2.verify(stored, plain)
  } catch {
    // argon2.verify throws on a malformed hash string rather than returning
    // false (e.g. stored is not a real argon2 hash at all, which should
    // never happen from writeOperatorCredential's own output but is not
    // something a login attempt should ever be able to turn into a 500).
    return false
  }
}

// A real argon2id hash of a fixed, unguessable dummy password, computed
// once with the exact same ARGON2_OPTIONS as hashPassword. Used only so a
// login attempt against a fresh install (no credential set yet) pays the
// same argon2 cost as a login attempt against a real one, and so the two
// cases are indistinguishable by response time as well as by message (see
// routes.ts's login handler): ADR 0008 requires that a login failure never
// reveal whether a credential exists, and timing is a channel too.
export const DUMMY_CREDENTIAL_HASH =
  '$argon2id$v=19$m=65536,p=4,t=3$/uh4FnbUEywIgWyHIMscew$WCiZZbOlwIAODlCuN2glT+Qkfa9MxgxoZFGDpDjNvBU'

function credentialPath(paths: Paths): string {
  return join(paths.home, 'studio-credential')
}

export function hasOperatorCredential(paths: Paths): boolean {
  return existsSync(credentialPath(paths))
}

// Reads the raw stored argon2 hash, or null if `hobby studio passwd` has
// never been run. Never throws for "not set yet": that is the expected
// state of a fresh install, not an error.
export function readOperatorCredential(paths: Paths): string | null {
  const path = credentialPath(paths)
  if (!existsSync(path)) {
    return null
  }
  return readFileSync(path, 'utf8').trim()
}

// mode is only honored by writeFileSync when the file does not already
// exist (POSIX open() ignores the mode argument on an existing inode), so a
// second `hobby studio passwd` run rewriting the same path would silently
// keep whatever permissions the file already had without the explicit
// chmodSync below. Owner-only, always, on every write: this file holds the
// one secret that gates the largest surface in the project.
function writeOperatorCredential(paths: Paths, hash: string): void {
  const path = credentialPath(paths)
  writeFileSync(path, `${hash}\n`, { mode: 0o600 })
  chmodSync(path, 0o600)
}

// The floor on the operator password's length, in characters (issue #127).
// One constant, read by setOperatorPassword below and by the CLI's
// `hobby studio passwd` (packages/cli/src/cli/commands.ts, cmdStudioPasswd),
// so the two can never disagree about what is too short. Twelve is the
// length at which a lower-case passphrase stops being cheap to brute force
// against the argon2id hash above, and the whole point of ADR 0008 is that
// this one credential is the largest security surface in the project.
export const MIN_PASSWORD_LENGTH = 12

// The single function that can create or change the operator credential
// (ADR 0008: "can only be created or changed by running `hobby studio
// passwd` on the box"). Nothing reachable over the network calls this; see
// the task report for exactly what the CLI's `hobby studio passwd` verb
// must call and where paths.home is expected to already exist (`hobby init`
// creates it, same precondition cmdInit/cmdDaemon already have).
export async function setOperatorPassword(paths: Paths, plain: string): Promise<void> {
  if (plain.length === 0) {
    throw new HobbyError('usage', 'password must not be empty')
  }
  if (plain.length < MIN_PASSWORD_LENGTH) {
    throw new HobbyError(
      'usage',
      `password must be at least ${MIN_PASSWORD_LENGTH} characters (got ${plain.length})`,
      'this credential gates a network-exposed control plane (ADR 0008); a passphrase of a few words is fine'
    )
  }
  const hash = await hashPassword(plain)
  writeOperatorCredential(paths, hash)
}

// --- login throttling --------------------------------------------------

// A HobbyError with the one extra fact a 429 needs: how long to wait, so
// the response can carry a Retry-After header (routes.ts's sendJson reads
// it). Everything else about it is an ordinary HobbyError('too_many_attempts').
export class ThrottledError extends HobbyError {
  constructor(readonly retryAfterSeconds: number) {
    super(
      'too_many_attempts',
      `too many attempts, retry in ${retryAfterSeconds}s`,
      'each failed login or bearer token from this address doubles the wait; a successful one clears it'
    )
  }
}

interface ThrottleState {
  failures: number
  blockedUntil: number
}

const BASE_DELAY_MS = 1000
const MAX_DELAY_MS = 5 * 60_000

// A defensive cap on the number of distinct keys tracked at once. Spraying
// login attempts from many source addresses to avoid ever re-hitting a
// throttled key is a real attacker strategy; without a cap, that same spray
// would also grow this table without bound. Eviction is coarse (oldest
// insertion order, which Map preserves) rather than a real LRU, which is
// good enough for a bound whose entire job is "never grows forever," not
// "always evict the least useful entry."
const MAX_TRACKED_KEYS = 10_000

// Exponential backoff per source address (per the brief's `key`), never a
// single global counter: a global counter would let one attacker's failures
// lock out every legitimate login attempt from every other address, which
// is a denial-of-service handed to anyone who wants one. Keying state by
// `key` and only ever touching that key's entry is also what satisfies the
// brief's explicit requirement that "the backoff cannot be reset by an
// attacker simply by succeeding on a different address": succeed(key) only
// ever deletes state.get(key), never anything else in the map, so a fresh
// address starting clean has no effect on any other address's state.
//
// Shared by the password routes (login, token) and the bearer-token gate
// (studio/routes.ts's isAuthenticated, issue #118): a bogus bearer token
// counts as a failed attempt from its source address exactly as a wrong
// password does, so neither path can be used to make the daemon do argon2
// work without limit.
export class LoginThrottle {
  private readonly state = new Map<string, ThrottleState>()

  // Seconds left in the key's backoff window, or 0 when it may try now.
  retryAfterSeconds(key: string, now: number = Date.now()): number {
    const entry = this.state.get(key)
    if (entry === undefined || now >= entry.blockedUntil) {
      return 0
    }
    return Math.ceil((entry.blockedUntil - now) / 1000)
  }

  // `too_many_attempts` (429), never `unauthorized` (issue #117): the CLI
  // mapped every 401 to "invalid credentials", so a throttled user with the
  // right password was told it was wrong. The wait is in the message, where
  // every client prints it, and on the error as a number so the HTTP layer
  // can send Retry-After.
  check(key: string, now: number = Date.now()): void {
    const seconds = this.retryAfterSeconds(key, now)
    if (seconds > 0) {
      throw new ThrottledError(seconds)
    }
  }

  fail(key: string, now: number = Date.now()): void {
    const entry = this.state.get(key) ?? { failures: 0, blockedUntil: 0 }
    entry.failures += 1
    const delayMs = Math.min(BASE_DELAY_MS * 2 ** (entry.failures - 1), MAX_DELAY_MS)
    entry.blockedUntil = now + delayMs

    if (!this.state.has(key) && this.state.size >= MAX_TRACKED_KEYS) {
      const oldestKey = this.state.keys().next().value
      if (oldestKey !== undefined) {
        this.state.delete(oldestKey)
      }
    }
    this.state.set(key, entry)
  }

  succeed(key: string): void {
    this.state.delete(key)
  }
}
