// Server-side sessions for the Studio operator credential (ADR 0008). No JWT,
// no signed cookie: the cookie carries nothing but an opaque random token,
// and every verify is a lookup against this process's own memory. That is
// what decision 4 in the task report means by "sessions live in memory and
// are lost on daemon restart": there is no persistence format to invent, and
// a daemon restart already logs the operator out, which is an acceptable
// price for a single-operator tool that otherwise has no server-side state
// worth calling a database.

import { randomBytes, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage } from 'node:http'

// 32 random bytes, per the brief and ADR 0008, from node:crypto.randomBytes:
// enough entropy that guessing a live token is not a real attack, encoded as
// base64url so it is a safe, unambiguous cookie value with no characters
// that need escaping.
const TOKEN_BYTES = 32

export const SESSION_COOKIE_NAME = 'hobby_studio_session'

// An upper bound on how long a browser is asked to hold on to the cookie.
// This is not a session lifetime: SessionStore has no expiry of its own (see
// the task report on why), so the real lifetime is however long the daemon
// process runs, or until an explicit logout calls revoke(). This value only
// keeps a stale cookie from surviving in a browser's cookie jar forever
// after that.
const COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 30

function cookieAttributes(maxAgeSeconds: number): string {
  // HttpOnly: javascript on the page can never read the token, which is the
  // mitigation for a stored-XSS bug anywhere in Studio's own UI stealing it.
  // Secure: the browser refuses to send it over plain HTTP, so a
  // man-in-the-middle on the network never sees it in transit either.
  // SameSite=Strict: the browser never attaches it to a request that did not
  // originate from Studio's own origin, which is the mitigation for CSRF
  // against every state-changing route this cookie authenticates.
  return `Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAgeSeconds}`
}

export function serializeSessionCookie(token: string): string {
  return `${SESSION_COOKIE_NAME}=${token}; ${cookieAttributes(COOKIE_MAX_AGE_SECONDS)}`
}

export function serializeClearCookie(): string {
  return `${SESSION_COOKIE_NAME}=; ${cookieAttributes(0)}`
}

// Cookie header parsing has no built-in in plain node:http. This reads only
// the one cookie Studio ever sets; anything else on the header is ignored.
export function readSessionCookie(req: IncomingMessage): string | null {
  const header = req.headers.cookie
  if (typeof header !== 'string') {
    return null
  }
  for (const part of header.split(';')) {
    const eq = part.indexOf('=')
    if (eq === -1) continue
    const name = part.slice(0, eq).trim()
    if (name === SESSION_COOKIE_NAME) {
      return decodeURIComponent(part.slice(eq + 1).trim())
    }
  }
  return null
}

function decodeToken(token: string): Buffer | null {
  if (typeof token !== 'string' || token.length === 0) {
    return null
  }
  const buf = Buffer.from(token, 'base64url')
  // A token that does not round-trip to exactly TOKEN_BYTES is never one
  // this store issued (issue() always encodes exactly TOKEN_BYTES), so it is
  // rejected before it is ever compared to a real one.
  if (buf.length !== TOKEN_BYTES) {
    return null
  }
  return buf
}

// Sessions expire on two clocks, and a session dies when it hits either.
//
// Idle: a session unused for this long is dead, so a cookie captured from a
// machine somebody has walked away from stops working on its own.
//
// Absolute: a session is dead this long after it was issued no matter how
// active it has been, which bounds the damage from a token that was stolen
// and is being actively used, because refreshing on use cannot extend it
// forever.
//
// Before this, the store had no expiry at all: a session lived until the
// daemon process restarted, so a stolen cookie stayed valid indefinitely on a
// box that stays up, which is exactly the box this is for.
const IDLE_TIMEOUT_MS = 12 * 60 * 60 * 1000
const ABSOLUTE_TIMEOUT_MS = 30 * 24 * 60 * 60 * 1000

interface SessionRecord {
  readonly issuedAt: number
  lastUsedAt: number
}

// One operator, so at most a handful of concurrent sessions (a few browser
// tabs or devices) ever exist at once: the linear scan in verify() below is
// not a scaling concern here the way it would be for a multi-tenant service.
export class SessionStore {
  private readonly tokens = new Map<string, SessionRecord>()

  // Injectable so a test can drive expiry without sleeping for twelve hours.
  constructor(private readonly now: () => number = Date.now) {}

  issue(): string {
    const token = randomBytes(TOKEN_BYTES).toString('base64url')
    const at = this.now()
    this.tokens.set(token, { issuedAt: at, lastUsedAt: at })
    return token
  }

  private expired(record: SessionRecord, at: number): boolean {
    return at - record.lastUsedAt > IDLE_TIMEOUT_MS || at - record.issuedAt > ABSOLUTE_TIMEOUT_MS
  }

  // Dropping expired entries on each verify keeps the store from growing
  // without bound on a daemon that runs for months, with no timer to own.
  private sweep(at: number): void {
    for (const [token, record] of this.tokens) {
      if (this.expired(record, at)) {
        this.tokens.delete(token)
      }
    }
  }

  // Never a plain `===` or Set.has() against the raw presented token: a
  // membership test on a hash table can only prove "no candidate hashed to
  // this bucket" or "found a match," but does not by itself guarantee the
  // engine's string comparison inside that bucket is constant time, and this
  // is exactly the code path the brief calls out for crypto.timingSafeEqual.
  // Every stored token is compared to the presented one, in full, after a
  // length check (timingSafeEqual throws on a length mismatch rather than
  // returning false, which decodeToken's length check exists to avoid ever
  // triggering).
  verify(token: string): boolean {
    const candidate = decodeToken(token)
    if (candidate === null) {
      return false
    }
    const at = this.now()
    this.sweep(at)

    // Still a full constant-time scan over every live session: the loop does
    // not break on a match, and the expiry check happens after the compare so
    // that a live token and an expired one take the same path here.
    let matched: string | null = null
    for (const [stored] of this.tokens) {
      const storedBuf = Buffer.from(stored, 'base64url')
      if (timingSafeEqual(storedBuf, candidate)) {
        matched = stored
      }
    }
    if (matched === null) {
      return false
    }

    // Sliding refresh on the idle clock only. The absolute clock is never
    // touched, which is what stops an attacker with a live token from holding
    // it forever simply by using it.
    const record = this.tokens.get(matched)
    if (record === undefined) {
      return false
    }
    record.lastUsedAt = at
    return true
  }

  // Called only with a token the caller already owns (its own cookie), never
  // with attacker-supplied input on its own, so a direct Set.delete is fine
  // here: nothing is learned by an attacker from its timing that verify()'s
  // constant-time scan above does not already have to defend against.
  // Exposed for tests, which is how the sweep is proved to actually drop
  // entries rather than merely refusing to verify them.
  get size(): number {
    return this.tokens.size
  }

  revoke(token: string): void {
    this.tokens.delete(token)
  }
}
