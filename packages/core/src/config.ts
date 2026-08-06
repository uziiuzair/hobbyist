// Filesystem layout and config resolution. Paths always come from
// $HOBBY_HOME (or ~/.hobby); config values come from flags, then HOBBY_*
// env vars, then a hobby.json found by walking up from cwd, then defaults.

import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

export interface Paths {
  home: string
  statePath: string
  socketPath: string
  projectsDir: string
  configPath: string
  resourceDataDir(project: string, resource: string): string
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
    resourceDataDir(project: string, resource: string): string {
      return join(projectsDir, project, resource, 'pgdata')
    },
  }
}

export interface HobbyConfig {
  image: string
  proxyPort: number
  studioPort: number
  apiPort: number
  sleepAfterSeconds: number | null
  wakeTimeoutMs: number
  readinessPollMs: number
}

const DEFAULT_CONFIG: HobbyConfig = {
  image: 'postgres:18-alpine',
  proxyPort: 5432,
  studioPort: 8443,
  apiPort: 7432,
  sleepAfterSeconds: 300,
  wakeTimeoutMs: 30000,
  readinessPollMs: 25,
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
