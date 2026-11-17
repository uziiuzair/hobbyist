// Declared extensions: the factual half. A postgres resource may declare a
// list of extension names (PostgresConfig.extensions); this file answers the
// two questions the daemon asks of a running Postgres about them, "make
// these exist" and "what is installed, at which version". When to ask is the
// daemon's policy (packages/cli/src/daemon/routes.ts and createPostgres in
// postgres.ts); this file never wakes, starts or stops anything.
//
// Neon's compute_ctl applies a declarative spec when a compute starts and
// reports installed extensions back. Hobbyist keeps the first half only at
// the moments the declaration is written (creation, and every change), not
// on every wake: an extension is a row in pg_extension plus objects in the
// catalog, all inside the data directory, so once created it survives every
// stop, start, branch, snapshot and eject by itself. Re-applying on wake
// would put a connection and a catalog read inside the cold start (whose
// budget is 3 seconds) to re-confirm something the data directory already
// guarantees. See docs/engine/CLAUDE.md's 2026-11-17 amendment.
//
// Same one-shot Client shape as query.ts, size.ts and activity-guard.ts:
// connect, query, always end, never a pool. Every connection carries
// HOBBY_APPLICATION_NAME, so the pre-sleep guard (checkActiveQuery) does
// not count this work as someone using the database.

import { Client } from 'pg'
import { HobbyError, type PostgresConfig } from '@hobby.sh/core'
import { HOBBY_APPLICATION_NAME } from './activity-guard.js'

const EXTENSIONS_CONNECTION_TIMEOUT_MS = 5000
// CREATE EXTENSION for something large (postgis) runs a long install
// script. Bounded so a wedged server cannot hold a route forever, generous
// so a real install is never cut off.
const EXTENSIONS_QUERY_TIMEOUT_MS = 60_000

// The issue that tracks choosing an image per project. Until it lands, the
// box-wide image (HOBBY_IMAGE, or `image` in hobby.json) is what decides
// which extensions exist to be created.
export const PER_PROJECT_IMAGE_ISSUE = 'https://github.com/uziiuzair/hobbyist/issues/2'

export interface InstalledExtension {
  name: string
  version: string
}

// Postgres stores extension names as identifiers (NAMEDATALEN 64, so 63
// bytes). Contrib uses lowercase letters, digits, underscores and, in one
// well-known case (uuid-ossp), a hyphen. Anything outside that is refused
// here rather than quoted through, so a declaration can never carry SQL.
const EXTENSION_NAME = /^[a-z0-9_][a-z0-9_-]{0,62}$/

export function validateExtensionNames(names: unknown, route: string): string[] {
  if (!Array.isArray(names) || names.some((name) => typeof name !== 'string')) {
    throw new HobbyError('usage', 'extensions must be an array of extension names', `${route} expects extension names as strings`)
  }
  const out: string[] = []
  for (const raw of names as string[]) {
    const name = raw.trim()
    if (!EXTENSION_NAME.test(name)) {
      throw new HobbyError(
        'usage',
        `"${raw}" is not an extension name`,
        'extension names are lowercase letters, digits, underscores and hyphens, as pg_available_extensions lists them'
      )
    }
    if (!out.includes(name)) {
      out.push(name)
    }
  }
  return out
}

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

async function withClient<T>(config: PostgresConfig, fn: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({
    host: '127.0.0.1',
    port: config.hostPort,
    user: config.superuser,
    password: config.password,
    database: config.database,
    application_name: HOBBY_APPLICATION_NAME,
    connectionTimeoutMillis: EXTENSIONS_CONNECTION_TIMEOUT_MS,
    query_timeout: EXTENSIONS_QUERY_TIMEOUT_MS,
  })
  try {
    await client.connect()
  } catch (err) {
    throw new HobbyError(
      'not_ready',
      `could not connect to read or apply extensions: ${errorMessage(err)}`,
      'the resource may still be starting; try again in a moment'
    )
  }
  try {
    return await fn(client)
  } finally {
    try {
      await client.end()
    } catch {
      // ignore, same reasoning as pgProbe / checkActiveQuery
    }
  }
}

const INSTALLED_SQL = 'SELECT extname AS name, extversion AS version FROM pg_extension ORDER BY extname'

async function readInstalled(client: Client): Promise<InstalledExtension[]> {
  const result = await client.query(INSTALLED_SQL)
  return (result.rows as Array<{ name: string; version: string }>).map((row) => ({ name: row.name, version: row.version }))
}

export async function listInstalledExtensions(config: PostgresConfig): Promise<InstalledExtension[]> {
  return await withClient(config, readInstalled)
}

// All or nothing at the check: every name is looked up in
// pg_available_extensions (the control files the image ships) before any
// CREATE runs, so a declaration naming one missing extension creates none
// of them and the error names every missing one at once. CASCADE installs
// whatever a declared extension requires (earthdistance needs cube), the
// same thing a person would type.
export async function applyExtensions(config: PostgresConfig, names: string[]): Promise<InstalledExtension[]> {
  return await withClient(config, async (client) => {
    if (names.length > 0) {
      const available = await client.query('SELECT name FROM pg_available_extensions WHERE name = ANY($1::text[])', [names])
      const found = new Set((available.rows as Array<{ name: string }>).map((row) => row.name))
      const missing = names.filter((name) => !found.has(name))
      if (missing.length > 0) {
        throw new HobbyError(
          'usage',
          `the image ${config.image} does not ship ${missing.length === 1 ? 'the extension' : 'the extensions'} ${missing.join(', ')}`,
          `Postgres here is the unmodified image, and an extension it does not ship cannot be created. ` +
            `Choosing an image per project is ${PER_PROJECT_IMAGE_ISSUE}; until then HOBBY_IMAGE sets the image for new resources on this box.`
        )
      }
      for (const name of names) {
        try {
          await client.query(`CREATE EXTENSION IF NOT EXISTS ${quoteIdent(name)} CASCADE`)
        } catch (err) {
          const hint = err instanceof Error && 'hint' in err && typeof err.hint === 'string' ? err.hint : undefined
          throw new HobbyError('usage', `CREATE EXTENSION ${name} failed: ${errorMessage(err)}`, hint)
        }
      }
    }
    return await readInstalled(client)
  })
}

// The seam both callers (createPostgres and the daemon's extensions route)
// go through, so a test against the fake runtime can play a Postgres that
// ships some extensions and not others. Production leaves PgDeps.extensions
// unset and gets the two real functions above.
export interface ExtensionOps {
  apply(config: PostgresConfig, names: string[]): Promise<InstalledExtension[]>
  list(config: PostgresConfig): Promise<InstalledExtension[]>
}

export const realExtensionOps: ExtensionOps = {
  apply: applyExtensions,
  list: listInstalledExtensions,
}

// What is declared, what is installed, and what is declared but missing
// (someone ran DROP EXTENSION by hand, or the declaration predates a
// restore of older data). Installed but undeclared is normal: plpgsql is
// always there, CASCADE adds dependencies, and anyone can CREATE EXTENSION
// from psql.
export interface ExtensionReport {
  declared: string[]
  installed: InstalledExtension[] | null
  missing: string[] | null
}

export function reportExtensions(declared: string[], installed: InstalledExtension[] | null): ExtensionReport {
  if (installed === null) {
    return { declared, installed: null, missing: null }
  }
  const names = new Set(installed.map((ext) => ext.name))
  return { declared, installed, missing: declared.filter((name) => !names.has(name)) }
}
