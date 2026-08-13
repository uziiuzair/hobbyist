// Filesystem layout and config resolution. Paths always come from
// $HOBBY_HOME (or ~/.hobby); config values come from flags, then HOBBY_*
// env vars, then a hobby.json found by walking up from cwd, then defaults.

import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

// Which subdirectory of a resource's own directory a caller wants. Phase 1
// had exactly one and hard-coded it; each kind now owns its own parts and
// nothing else writes into them.
//
//   pgdata  the postgres data directory. ADR 0003's plain PGDATA, unchanged,
//           so no existing resource's data moves.
//   bundle  a worker's built script and the manifest generated from its
//           wrangler file.
//   state   a worker's Miniflare persistence root: KV, R2, D1, cache.
//   do      a worker's Durable Object storage. Read (never written) by the
//           daemon's alarm mirror, which recovers pending alarm deadlines
//           from stopped objects' sqlite files, since a stopped container
//           cannot fire its own timer.
//   queue   a queue's messages.sqlite, written only by the daemon.
//
// An `app` has no part at all: ADR 0007 makes Phase 2 compute stateless and
// volumes wait for Phase 3.
export type ResourcePart = 'pgdata' | 'bundle' | 'state' | 'do' | 'queue'

export interface Paths {
  home: string
  statePath: string
  socketPath: string
  projectsDir: string
  configPath: string
  // The resource's own directory, holding whichever parts its kind uses.
  resourceDir(project: string, resource: string): string
  resourcePath(project: string, resource: string, part: ResourcePart): string
}

export function resolvePaths(env: NodeJS.ProcessEnv = process.env): Paths {
  const home = env.HOBBY_HOME ?? join(homedir(), '.hobby')
  const projectsDir = join(home, 'projects')
  return {
    home,
    statePath: join(home, 'state.db'),
    socketPath: join(home, 'hobby.sock'),
    projectsDir,
    configPath: join(home, 'hobby.json'),
    resourceDir(project: string, resource: string): string {
      return join(projectsDir, project, resource)
    },
    resourcePath(project: string, resource: string, part: ResourcePart): string {
      return join(projectsDir, project, resource, part)
    },
  }
}

// PostgreSQL 18's official image refuses to start when a bind mount lands
// directly at what used to be PGDATA (see docs/decisions/0003's 2026-08-07
// amendment). The corrected mount point, POSTGRES_HOME_CONTAINER_PATH in
// packages/pg/src/postgres.ts, is the postgres home directory, and the
// entrypoint places the real data directory in a subdirectory named after
// the major version: <mount>/<major>/docker. This is the one place that
// pattern is written down. Every caller that needs the true on-disk PGDATA
// path, not just the mount source, derives it from here rather than
// hardcoding the subdirectory itself.
const POSTGRES_MAJOR_VERSION = '18'

export function resolvePgdataPath(hostDataDir: string): string {
  return join(hostDataDir, POSTGRES_MAJOR_VERSION, 'docker')
}

export interface HobbyConfig {
  image: string
  proxyPort: number
  studioPort: number
  apiPort: number
  // Where the HTTP wake router listens, on loopback. Caddy's catch-all route
  // points here and every request to an app or a worker passes through it,
  // because Caddy itself cannot trigger a wake (ADR 0009). This is to port
  // 443 what proxyPort is to 5432.
  httpPort: number
  // The suffix every app and worker hostname is built under:
  // <resource>.<project>.<domain>. Defaults to `localhost` because
  // *.localhost already resolves to loopback in browsers and in curl, so a
  // laptop install works with no DNS and no /etc/hosts edit. Set it to a
  // real domain to serve a real one.
  domain: string
  sleepAfterSeconds: number | null
  wakeTimeoutMs: number
  readinessPollMs: number
  // Where the daemon's queue enqueue listener answers `POST /enqueue`.
  // Separate from apiPort: a compromised container should be able to reach
  // only this endpoint, with its own per-resource token, not the operator
  // control surface. See docs/queues/specs/2026-08-13-queues-design.md,
  // "Daemon API, two listeners". The listener itself is a later task; this
  // package only needs the number, to build the URL a worker's producer
  // binding is given. Optional (unlike the ports above) so every existing
  // hand-built HobbyConfig fixture across the repo, most of them owned by
  // other work, does not have to be touched to add a field it does not care
  // about; DEFAULT_CONFIG still supplies it for real use.
  queuePort?: number
}

const DEFAULT_CONFIG: HobbyConfig = {
  image: 'postgres:18-alpine',
  proxyPort: 5432,
  studioPort: 8443,
  apiPort: 7432,
  httpPort: 7433,
  domain: 'localhost',
  sleepAfterSeconds: 300,
  wakeTimeoutMs: 30000,
  readinessPollMs: 25,
  queuePort: 7434,
}

function findConfigFile(cwd: string): string | null {
  let dir = resolve(cwd)
  for (;;) {
    const candidate = join(dir, 'hobby.json')
    if (existsSync(candidate)) return candidate
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

function readFileConfig(cwd: string): Partial<HobbyConfig> {
  const path = findConfigFile(cwd)
  if (path === null) return {}
  return JSON.parse(readFileSync(path, 'utf8')) as Partial<HobbyConfig>
}

function readEnvConfig(env: NodeJS.ProcessEnv): Partial<HobbyConfig> {
  const config: Partial<HobbyConfig> = {}
  if (env.HOBBY_IMAGE !== undefined) config.image = env.HOBBY_IMAGE
  if (env.HOBBY_PROXY_PORT !== undefined) config.proxyPort = Number(env.HOBBY_PROXY_PORT)
  if (env.HOBBY_STUDIO_PORT !== undefined) config.studioPort = Number(env.HOBBY_STUDIO_PORT)
  if (env.HOBBY_API_PORT !== undefined) config.apiPort = Number(env.HOBBY_API_PORT)
  if (env.HOBBY_HTTP_PORT !== undefined) config.httpPort = Number(env.HOBBY_HTTP_PORT)
  if (env.HOBBY_DOMAIN !== undefined) config.domain = env.HOBBY_DOMAIN
  if (env.HOBBY_SLEEP_AFTER_SECONDS !== undefined) {
    config.sleepAfterSeconds =
      env.HOBBY_SLEEP_AFTER_SECONDS === 'null' ? null : Number(env.HOBBY_SLEEP_AFTER_SECONDS)
  }
  if (env.HOBBY_WAKE_TIMEOUT_MS !== undefined) {
    config.wakeTimeoutMs = Number(env.HOBBY_WAKE_TIMEOUT_MS)
  }
  if (env.HOBBY_READINESS_POLL_MS !== undefined) {
    config.readinessPollMs = Number(env.HOBBY_READINESS_POLL_MS)
  }
  if (env.HOBBY_QUEUE_PORT !== undefined) {
    config.queuePort = Number(env.HOBBY_QUEUE_PORT)
  }
  return config
}

export function resolveConfig(opts: {
  flags?: Partial<HobbyConfig>
  env?: NodeJS.ProcessEnv
  cwd?: string
}): HobbyConfig {
  const env = opts.env ?? process.env
  const cwd = opts.cwd ?? process.cwd()
  return {
    ...DEFAULT_CONFIG,
    ...readFileConfig(cwd),
    ...readEnvConfig(env),
    ...opts.flags,
  }
}
