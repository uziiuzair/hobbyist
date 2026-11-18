// The source of `hobby import`: a connection string to someone else's
// Postgres, which is a credential, and everything this file does follows from
// that (docs/portability/CLAUDE.md, 2026-11-17 import amendment).
//
// Three jobs, none of which touch a network or a container:
//
//   1. Parse it. Both shapes libpq accepts: a URI (postgres:// or
//      postgresql://) and keyword=value pairs. The result is a list of libpq
//      keywords, not a string, because the string is never handed to anything.
//   2. Render it as a libpq service file section. pg_dump and psql run inside
//      a throwaway container and are told only `service=source`; the keywords,
//      password included, reach them through a file the container writes from
//      its own stdin (packages/cli/src/daemon/import.ts). So the credential is
//      never in an argv (the host's process list shows every container's
//      processes), never in a container's environment (`docker inspect` shows
//      it), and never in a file on the host's disk.
//   3. Redact it. Anything a tool printed (psql, pg_dump and pg_restore name
//      the host and the user in their errors, and libpq echoes a fragment of
//      a malformed connection string) passes through a redactor holding the
//      raw input and the password in every spelling it was given in, before
//      it reaches an error message, a response or a log line.
//
// Errors from this file never quote the input, only the name of a keyword:
// a malformed string is exactly the one most likely to have the password in
// the place the parser choked on.

import { HobbyError } from '@hobby.sh/core'

export interface SourceConnection {
  // libpq keywords, in input order, after validation and the loopback
  // rewrite below. Includes the password when one was given.
  keywords: Array<[string, string]>
  // For reports and log lines: never the password, never the user.
  display: { host: string; database: string | null }
  // True when a loopback host was rewritten to host.docker.internal, so the
  // report can say so (the source was this box, reached from a container).
  loopbackRewritten: boolean
  // Every spelling of the secret the input contained, for redactor().
  secrets: string[]
}

// The host as seen from inside a container. docker run --add-host
// host.docker.internal:host-gateway makes it resolve on Linux too; Docker
// Desktop and OrbStack resolve it natively.
export const CONTAINER_HOST_ALIAS = 'host.docker.internal'

// The keywords the import passes through. Every other libpq keyword is
// refused by name, either because it names a file (which would be a path on
// the daemon's box, read inside a container that cannot see it) or because
// it would change what the session is (replication, service).
const ALLOWED = new Set([
  'host',
  'hostaddr',
  'port',
  'dbname',
  'user',
  'password',
  'connect_timeout',
  'client_encoding',
  'options',
  'keepalives',
  'keepalives_idle',
  'keepalives_interval',
  'keepalives_count',
  'tcp_user_timeout',
  'sslmode',
  'sslnegotiation',
  'sslcompression',
  'sslsni',
  'sslcertmode',
  'ssl_min_protocol_version',
  'ssl_max_protocol_version',
  'sslrootcert',
  'channel_binding',
  'require_auth',
  'gssencmode',
  'krbsrvname',
  'gsslib',
  'gssdelegation',
  'target_session_attrs',
  'load_balance_hosts',
  // Overwritten below: the source session is always labelled hobby-import.
  'application_name',
  'fallback_application_name',
])

const FILE_KEYWORDS = new Set(['sslcert', 'sslkey', 'sslpassword', 'sslcrl', 'sslcrldir', 'passfile', 'service', 'servicefile', 'sslkeylogfile'])

// What the source session calls itself in the source's pg_stat_activity, so
// whoever runs that database can see what is reading it.
export const IMPORT_SOURCE_APPLICATION_NAME = 'hobby-import'

const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1', '[::1]'])

function usage(message: string, hint?: string): HobbyError {
  return new HobbyError('usage', message, hint)
}

function decode(part: string, what: string): string {
  try {
    return decodeURIComponent(part)
  } catch {
    throw usage(`the source connection string has a malformed percent-encoding in its ${what}`)
  }
}

function parseUri(text: string): Array<[string, string]> {
  const scheme = /^postgres(?:ql)?:\/\//i.exec(text)
  if (scheme === null) {
    throw usage('the source is not a postgres:// URL')
  }
  const rest = text.slice(scheme[0].length)
  const queryAt = rest.indexOf('?')
  const main = queryAt === -1 ? rest : rest.slice(0, queryAt)
  const query = queryAt === -1 ? '' : rest.slice(queryAt + 1)
  const out: Array<[string, string]> = []

  // The last @ before the path, so a password with an unencoded @ still
  // splits where the person meant it to.
  const slash = main.indexOf('/', Math.max(0, main.lastIndexOf('@')))
  const authority = slash === -1 ? main : main.slice(0, slash)
  const path = slash === -1 ? '' : main.slice(slash + 1)
  const at = authority.lastIndexOf('@')
  const userinfo = at === -1 ? null : authority.slice(0, at)
  const hostinfo = at === -1 ? authority : authority.slice(at + 1)

  if (userinfo !== null) {
    const colon = userinfo.indexOf(':')
    const user = colon === -1 ? userinfo : userinfo.slice(0, colon)
    if (user.length > 0) out.push(['user', decode(user, 'user')])
    if (colon !== -1) out.push(['password', decode(userinfo.slice(colon + 1), 'password')])
  }

  if (hostinfo.length > 0) {
    const hosts: string[] = []
    const ports: string[] = []
    for (const entry of hostinfo.split(',')) {
      let host: string
      let port = ''
      if (entry.startsWith('[')) {
        const close = entry.indexOf(']')
        if (close === -1) throw usage('the source connection string has an unclosed [ in its host')
        host = entry.slice(1, close)
        const after = entry.slice(close + 1)
        if (after.startsWith(':')) port = after.slice(1)
        else if (after.length > 0) throw usage('the source connection string has a malformed host')
      } else {
        const colon = entry.lastIndexOf(':')
        host = colon === -1 ? entry : entry.slice(0, colon)
        port = colon === -1 ? '' : entry.slice(colon + 1)
      }
      hosts.push(decode(host, 'host'))
      ports.push(port)
    }
    if (hosts.some((h) => h.length > 0)) out.push(['host', hosts.join(',')])
    if (ports.some((p) => p.length > 0)) out.push(['port', ports.join(',')])
  }

  if (path.length > 0) out.push(['dbname', decode(path, 'database name')])

  for (const pair of query.split('&')) {
    if (pair.length === 0) continue
    const eq = pair.indexOf('=')
    if (eq === -1) throw usage('the source connection string has a query parameter without a value')
    const key = decode(pair.slice(0, eq), 'query')
    const value = decode(pair.slice(eq + 1), 'query')
    // libpq's own JDBC compatibility: ssl=true means sslmode=require.
    if (key === 'ssl') {
      if (value !== 'true') throw usage('ssl= in the source connection string only accepts true')
      out.push(['sslmode', 'require'])
      continue
    }
    out.push([key, value])
  }
  return out
}

// keyword = value pairs, separated by whitespace, values optionally in single
// quotes, backslash escaping the next character either way: libpq's
// conninfo_parse.
function parseKeywordValue(text: string): Array<[string, string]> {
  const out: Array<[string, string]> = []
  let i = 0
  const n = text.length
  const space = (c: string | undefined): boolean => c !== undefined && /\s/.test(c)
  while (i < n) {
    while (space(text[i])) i++
    if (i >= n) break
    let key = ''
    while (i < n && text[i] !== '=' && !space(text[i])) key += text[i++]
    while (space(text[i])) i++
    if (text[i] !== '=' || key.length === 0) {
      throw usage('the source is neither a postgres:// URL nor keyword=value pairs')
    }
    i++
    while (space(text[i])) i++
    let value = ''
    if (text[i] === "'") {
      i++
      let closed = false
      while (i < n) {
        const c = text[i++] as string
        if (c === '\\' && i < n) {
          value += text[i++]
        } else if (c === "'") {
          closed = true
          break
        } else {
          value += c
        }
      }
      if (!closed) throw usage(`the source connection string has an unterminated quoted value for ${key}`)
    } else {
      while (i < n && !space(text[i])) {
        const c = text[i++] as string
        if (c === '\\' && i < n) value += text[i++]
        else value += c
      }
    }
    out.push([key, value])
  }
  return out
}

export function parseSourceConnection(raw: string): SourceConnection {
  const text = raw.trim()
  if (text.length === 0) {
    throw usage('the source connection string is empty')
  }
  const pairs = /^postgres(?:ql)?:\/\//i.test(text) ? parseUri(text) : parseKeywordValue(text)

  const seen = new Map<string, string>()
  for (const [key, value] of pairs) {
    if (FILE_KEYWORDS.has(key)) {
      throw usage(
        `the source connection string sets ${key}, which names a file`,
        'the import runs pg_dump in a container that cannot read files on this machine; use sslmode and sslrootcert=system instead'
      )
    }
    if (key === 'replication') {
      throw usage('the source connection string sets replication', 'an import is a one-shot pg_dump, never a replication connection')
    }
    if (!ALLOWED.has(key)) {
      throw usage(`the source connection string sets ${key}, which hobby import does not pass through`)
    }
    if (key === 'sslrootcert' && value !== 'system') {
      throw usage(
        'the source connection string sets sslrootcert to a file',
        'the import container cannot read files on this machine; sslrootcert=system uses the image\'s CA bundle'
      )
    }
    // A service file line is the rest of the line after `=`, with trailing
    // whitespace dropped: a value with a line break or trailing whitespace
    // cannot be carried through one.
    if (/[\r\n\0]/.test(value) || (value.length > 0 && /\s$/.test(value))) {
      throw usage(`the source connection string's ${key} contains a line break or trailing whitespace, which cannot be passed on`)
    }
    seen.set(key, value)
  }

  const host = seen.get('host') ?? ''
  const hostaddr = seen.get('hostaddr') ?? ''
  if (host.length === 0 && hostaddr.length === 0) {
    throw usage(
      'the source connection string names no host',
      'without one, libpq would look for a unix socket inside the import container; give the host the database listens on'
    )
  }
  const hosts = host.length === 0 ? [] : host.split(',')
  if (hosts.some((h) => h.startsWith('/') || h.startsWith('@'))) {
    throw usage(
      'the source connection string names a unix socket',
      'the import runs in a container that cannot reach a socket on this machine; use the TCP host and port instead'
    )
  }
  if (hostaddr.split(',').some((a) => LOOPBACK.has(a))) {
    throw usage('the source connection string sets hostaddr to a loopback address', `use host=localhost; it is reached as ${CONTAINER_HOST_ALIAS} from the import container`)
  }
  let loopbackRewritten = false
  const rewritten = hosts.map((h) => {
    if (LOOPBACK.has(h.toLowerCase())) {
      loopbackRewritten = true
      return CONTAINER_HOST_ALIAS
    }
    return h
  })
  if (loopbackRewritten) seen.set('host', rewritten.join(','))
  seen.set('application_name', IMPORT_SOURCE_APPLICATION_NAME)
  seen.delete('fallback_application_name')

  const password = seen.get('password')
  const secrets = [raw, text]
  if (password !== undefined && password.length > 0) {
    secrets.push(password, encodeURIComponent(password))
    // The spelling the URI carried, which may differ from both of the above
    // (a partially encoded password).
    const m = /^postgres(?:ql)?:\/\/([^@/?]*:)?([^@]*)@/i.exec(text)
    if (m?.[1] !== undefined && m[2] !== undefined) secrets.push(m[2])
  }

  return {
    keywords: [...seen.entries()],
    display: { host: host.length > 0 ? host.split(',')[0] as string : hostaddr, database: seen.get('dbname') ?? null },
    loopbackRewritten,
    secrets: [...new Set(secrets.filter((s) => s.length > 0))],
  }
}

// One [name] section of a libpq service file. Values are written as they
// are: the service file format has no quoting, which is why
// parseSourceConnection refuses the two things it cannot carry.
export function renderServiceSection(name: string, keywords: Array<[string, string]>): string {
  return `[${name}]\n${keywords.map(([key, value]) => `${key}=${value}`).join('\n')}\n`
}

// Replaces every occurrence of every secret, longest first so a password
// that is a substring of the whole string does not leave the rest of it
// behind. Applied to every byte of tool output the import surfaces.
export function redactor(secrets: string[]): (text: string) => string {
  const ordered = [...new Set(secrets.filter((s) => s.length > 0))].sort((a, b) => b.length - a.length)
  return (text: string): string => {
    let out = text
    for (const secret of ordered) {
      out = out.split(secret).join('[redacted]')
    }
    return out
  }
}
