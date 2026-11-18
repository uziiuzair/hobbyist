// Server settings a postgres resource may declare, and the preload libraries
// its extensions need. Pure: no connection, no container. The daemon decides
// when a change is applied (packages/cli/src/daemon/pg-settings.ts), and
// containerSpec (postgres.ts) and renderCompose (the eject route) turn the
// declaration into the same server arguments.
//
// Settings reach Postgres only as `postgres -c name=value` on the
// container's command line, never through postgresql.conf or
// postgresql.auto.conf, so the data directory stays exactly what initdb
// wrote (ADR 0003). One consequence decides how every change is applied: a
// value given on the command line outranks the config files and is not
// re-read by pg_reload_conf, so even a setting Postgres itself could reload
// takes effect here only when the container is recreated with new
// arguments. `restartRequired` below is still reported, because it is what
// the PostgreSQL docs say about the setting, but hobby recreates the
// container for every change. See docs/engine/CLAUDE.md's 2026-11-17
// amendment on settings.
//
// The allowlist is grounded in pg_settings as postgres:18-alpine (18.7)
// reports it (vartype, unit, min_val, max_val, boot_val, context, read on
// 2026-11-17), with bounds narrowed to what makes sense for one small box.
// Xata's internal/postgrescfg/parameters.yaml (xataio/xata, Apache-2.0) was
// read as a guide to which settings are worth exposing; nothing here is
// copied from it. A setting not listed is refused, so a typo or a setting
// that can stop the server from booting (data_directory, port, listen
// addresses, archive and replication settings, anything that names a file)
// never reaches a container.

import { HobbyError } from '@hobby.sh/core'

const DOCS = 'https://www.postgresql.org/docs/18'

export type SettingContext = 'postmaster' | 'sighup' | 'superuser' | 'user'

type SettingType =
  | { type: 'integer'; min: number; max: number }
  | { type: 'real'; min: number; max: number }
  | { type: 'bool' }
  | { type: 'enum'; values: readonly string[] }
  // Memory, compared in kB. `unitKb` is what a bare number means (8 for a
  // setting counted in 8kB pages, 1024 for one counted in MB).
  | { type: 'memory'; unitKb: number; minKb: number; maxKb: number; minusOne?: boolean }
  // Time, compared in ms. `unitMs` is what a bare number means.
  | { type: 'duration'; unitMs: number; minMs: number; maxMs: number; minusOne?: boolean }
  | { type: 'libraries' }

export type SettingSpec = SettingType & {
  // pg_settings.context. postmaster means Postgres reads it only at start.
  context: SettingContext
  default: string
  summary: string
  docs: string
  // A setting that belongs to a preload library is inert until that
  // library is in shared_preload_libraries, so it is refused without it.
  library?: PreloadLibrary
}

// What the stock image ships that is worth preloading, and nothing else.
// Checked in postgres:18-alpine: /usr/local/lib/postgresql has both .so
// files, and `postgres -c shared_preload_libraries=pg_stat_statements`
// makes the pg_stat_statements view answer where without it the view
// raises "pg_stat_statements must be loaded via shared_preload_libraries".
//
// Deliberately absent, though the image ships them:
//   pg_prewarm     its autoprewarm worker is what ADR 0020 measured and did
//                  not build: the first queries after a wake got slower.
//   auth_delay     slows failed logins inside Postgres; ADR 0019 already
//                  decided against login throttling at this layer.
//   passwordcheck, pg_overexplain
//                  no use on a box with one owner, and pg_overexplain is
//                  meant for LOAD in a session.
// Not shipped, and not allowed if a custom image ships it: pg_cron. Its
// jobs run only while the database is awake, so on a database that sleeps
// a schedule silently stops firing, and its launcher is a background worker
// holding a connection, which is the wrong shape for something that must
// sleep (ADR 0007, the wedge breaks the tie). Worker cron triggers
// (`hobby cron ls`) are the scheduler that wakes what it runs.
export const PRELOAD_LIBRARIES = ['pg_stat_statements', 'auto_explain'] as const
export type PreloadLibrary = (typeof PRELOAD_LIBRARIES)[number]

const KB = 1
const MB = 1024
const GB = 1024 * 1024
const SEC = 1000
const MIN = 60 * SEC
const DAY = 24 * 60 * MIN
const PG_INT_MAX = 2147483647

function guc(page: string, name: string): string {
  return `${DOCS}/${page}.html#GUC-${name.toUpperCase().replace(/_/g, '-')}`
}

export const SETTINGS: Readonly<Record<string, SettingSpec>> = {
  // Connections and sessions
  max_connections: {
    type: 'integer', min: 5, max: 1000, context: 'postmaster', default: '100',
    summary: 'most concurrent connections; each one is a backend process with its own memory',
    docs: guc('runtime-config-connection', 'max_connections'),
  },
  idle_session_timeout: {
    type: 'duration', unitMs: 1, minMs: 0, maxMs: PG_INT_MAX, context: 'user', default: '0',
    summary: 'end a session idle this long outside a transaction (0 disables)',
    docs: guc('runtime-config-client', 'idle_session_timeout'),
  },
  idle_in_transaction_session_timeout: {
    type: 'duration', unitMs: 1, minMs: 0, maxMs: PG_INT_MAX, context: 'user', default: '0',
    summary: 'end a session idle this long inside an open transaction (0 disables)',
    docs: guc('runtime-config-client', 'idle_in_transaction_session_timeout'),
  },
  statement_timeout: {
    type: 'duration', unitMs: 1, minMs: 0, maxMs: PG_INT_MAX, context: 'user', default: '0',
    summary: 'abort any statement running longer than this (0 disables)',
    docs: guc('runtime-config-client', 'statement_timeout'),
  },
  lock_timeout: {
    type: 'duration', unitMs: 1, minMs: 0, maxMs: PG_INT_MAX, context: 'user', default: '0',
    summary: 'abort a statement that waits longer than this for a lock (0 disables)',
    docs: guc('runtime-config-client', 'lock_timeout'),
  },
  transaction_timeout: {
    type: 'duration', unitMs: 1, minMs: 0, maxMs: PG_INT_MAX, context: 'user', default: '0',
    summary: 'end a session whose transaction runs longer than this (0 disables)',
    docs: guc('runtime-config-client', 'transaction_timeout'),
  },

  // Memory
  shared_buffers: {
    type: 'memory', unitKb: 8, minKb: 1 * MB, maxKb: 8 * GB, context: 'postmaster', default: '128MB',
    summary: 'shared page cache; allocated at start whether or not it is used',
    docs: guc('runtime-config-resource', 'shared_buffers'),
  },
  work_mem: {
    type: 'memory', unitKb: KB, minKb: 64, maxKb: 1 * GB, context: 'user', default: '4MB',
    summary: 'memory per sort or hash step before spilling to disk; one query can use several',
    docs: guc('runtime-config-resource', 'work_mem'),
  },
  maintenance_work_mem: {
    type: 'memory', unitKb: KB, minKb: 1 * MB, maxKb: 4 * GB, context: 'user', default: '64MB',
    summary: 'memory for VACUUM, CREATE INDEX and ALTER TABLE ADD FOREIGN KEY',
    docs: guc('runtime-config-resource', 'maintenance_work_mem'),
  },
  temp_buffers: {
    type: 'memory', unitKb: 8, minKb: 800, maxKb: 1 * GB, context: 'user', default: '8MB',
    summary: 'per-session buffers for temporary tables',
    docs: guc('runtime-config-resource', 'temp_buffers'),
  },
  effective_cache_size: {
    type: 'memory', unitKb: 8, minKb: 1 * MB, maxKb: 1024 * GB, context: 'user', default: '4GB',
    summary: "the planner's estimate of cache available to one query; allocates nothing",
    docs: guc('runtime-config-query', 'effective_cache_size'),
  },

  // Planner
  random_page_cost: {
    type: 'real', min: 0, max: 100, context: 'user', default: '4',
    summary: 'planner cost of a non-sequential page read; lower it on SSDs',
    docs: guc('runtime-config-query', 'random_page_cost'),
  },
  seq_page_cost: {
    type: 'real', min: 0, max: 100, context: 'user', default: '1',
    summary: 'planner cost of a sequential page read',
    docs: guc('runtime-config-query', 'seq_page_cost'),
  },
  default_statistics_target: {
    type: 'integer', min: 1, max: 10000, context: 'user', default: '100',
    summary: 'how much ANALYZE samples per column',
    docs: guc('runtime-config-query', 'default_statistics_target'),
  },
  jit: {
    type: 'bool', context: 'user', default: 'on',
    summary: 'JIT compilation of expensive queries (llvmjit ships in the image)',
    docs: guc('runtime-config-query', 'jit'),
  },

  // Asynchronous I/O and parallelism
  // io_uring is left out: under Docker's default seccomp profile the server
  // exits at start with "could not setup io_uring queue: Operation not
  // permitted" (postgres:18-alpine, Docker 28.4, 2026-11-17).
  io_method: {
    type: 'enum', values: ['worker', 'sync'], context: 'postmaster', default: 'worker',
    summary: 'how asynchronous reads are issued: I/O worker processes, or synchronously',
    docs: guc('runtime-config-resource', 'io_method'),
  },
  io_workers: {
    type: 'integer', min: 1, max: 32, context: 'sighup', default: '3',
    summary: 'I/O worker processes when io_method is worker',
    docs: guc('runtime-config-resource', 'io_workers'),
  },
  effective_io_concurrency: {
    type: 'integer', min: 0, max: 1000, context: 'user', default: '16',
    summary: 'concurrent I/O requests one session may issue',
    docs: guc('runtime-config-resource', 'effective_io_concurrency'),
  },
  maintenance_io_concurrency: {
    type: 'integer', min: 0, max: 1000, context: 'user', default: '16',
    summary: 'the same, for maintenance work',
    docs: guc('runtime-config-resource', 'maintenance_io_concurrency'),
  },
  max_worker_processes: {
    type: 'integer', min: 0, max: 64, context: 'postmaster', default: '8',
    summary: 'background worker slots, which parallel query draws from',
    docs: guc('runtime-config-resource', 'max_worker_processes'),
  },
  max_parallel_workers: {
    type: 'integer', min: 0, max: 64, context: 'user', default: '8',
    summary: 'parallel workers across all queries',
    docs: guc('runtime-config-resource', 'max_parallel_workers'),
  },
  max_parallel_workers_per_gather: {
    type: 'integer', min: 0, max: 64, context: 'user', default: '2',
    summary: 'parallel workers for one query step (0 turns parallel query off)',
    docs: guc('runtime-config-resource', 'max_parallel_workers_per_gather'),
  },
  max_parallel_maintenance_workers: {
    type: 'integer', min: 0, max: 64, context: 'user', default: '2',
    summary: 'parallel workers for one CREATE INDEX or VACUUM',
    docs: guc('runtime-config-resource', 'max_parallel_maintenance_workers'),
  },

  // WAL and checkpoints
  max_wal_size: {
    type: 'memory', unitKb: MB, minKb: 32 * MB, maxKb: 64 * GB, context: 'sighup', default: '1GB',
    summary: 'WAL allowed to build up between automatic checkpoints',
    docs: guc('runtime-config-wal', 'max_wal_size'),
  },
  min_wal_size: {
    type: 'memory', unitKb: MB, minKb: 32 * MB, maxKb: 16 * GB, context: 'sighup', default: '80MB',
    summary: 'WAL kept for reuse rather than removed at a checkpoint',
    docs: guc('runtime-config-wal', 'min_wal_size'),
  },
  checkpoint_timeout: {
    type: 'duration', unitMs: SEC, minMs: 30 * SEC, maxMs: DAY, context: 'sighup', default: '5min',
    summary: 'longest time between automatic checkpoints',
    docs: guc('runtime-config-wal', 'checkpoint_timeout'),
  },
  checkpoint_completion_target: {
    type: 'real', min: 0, max: 1, context: 'sighup', default: '0.9',
    summary: 'fraction of the checkpoint interval to spread checkpoint writes over',
    docs: guc('runtime-config-wal', 'checkpoint_completion_target'),
  },
  wal_compression: {
    type: 'enum', values: ['off', 'on', 'pglz', 'lz4', 'zstd'], context: 'superuser', default: 'off',
    summary: 'compress full-page images in WAL (the image is built with lz4 and zstd)',
    docs: guc('runtime-config-wal', 'wal_compression'),
  },
  // remote_write and remote_apply need a synchronous standby, which one
  // box does not have.
  synchronous_commit: {
    type: 'enum', values: ['on', 'off', 'local'], context: 'user', default: 'on',
    summary: 'off trades the last few hundred ms of commits on a crash for faster commits; never corrupts',
    docs: guc('runtime-config-wal', 'synchronous_commit'),
  },

  // Logging and statistics
  log_min_duration_statement: {
    type: 'duration', unitMs: 1, minMs: 0, maxMs: PG_INT_MAX, minusOne: true, context: 'superuser', default: '-1',
    summary: 'log every statement that runs at least this long (-1 disables); read with `hobby logs`',
    docs: guc('runtime-config-logging', 'log_min_duration_statement'),
  },
  log_statement: {
    type: 'enum', values: ['none', 'ddl', 'mod', 'all'], context: 'superuser', default: 'none',
    summary: 'which statements to log',
    docs: guc('runtime-config-logging', 'log_statement'),
  },
  log_lock_waits: {
    type: 'bool', context: 'superuser', default: 'off',
    summary: 'log a session that waits longer than deadlock_timeout for a lock',
    docs: guc('runtime-config-logging', 'log_lock_waits'),
  },
  log_temp_files: {
    type: 'memory', unitKb: KB, minKb: 0, maxKb: 1024 * GB, minusOne: true, context: 'superuser', default: '-1',
    summary: 'log temporary files at least this large (-1 disables, 0 logs all)',
    docs: guc('runtime-config-logging', 'log_temp_files'),
  },
  track_io_timing: {
    type: 'bool', context: 'superuser', default: 'off',
    summary: 'time block reads and writes, shown by EXPLAIN (BUFFERS) and pg_stat_statements',
    docs: guc('runtime-config-statistics', 'track_io_timing'),
  },

  // Autovacuum
  autovacuum_naptime: {
    type: 'duration', unitMs: SEC, minMs: 1 * SEC, maxMs: DAY, context: 'sighup', default: '1min',
    summary: 'delay between autovacuum runs on one database',
    docs: guc('runtime-config-vacuum', 'autovacuum_naptime'),
  },
  autovacuum_vacuum_scale_factor: {
    type: 'real', min: 0, max: 100, context: 'sighup', default: '0.2',
    summary: 'fraction of a table changed before it is vacuumed',
    docs: guc('runtime-config-vacuum', 'autovacuum_vacuum_scale_factor'),
  },
  autovacuum_analyze_scale_factor: {
    type: 'real', min: 0, max: 100, context: 'sighup', default: '0.1',
    summary: 'fraction of a table changed before it is analyzed',
    docs: guc('runtime-config-vacuum', 'autovacuum_analyze_scale_factor'),
  },
  // Capped at autovacuum_worker_slots' default (16): above it Postgres
  // only warns and starts no more workers.
  autovacuum_max_workers: {
    type: 'integer', min: 1, max: 16, context: 'sighup', default: '3',
    summary: 'concurrent autovacuum workers',
    docs: guc('runtime-config-vacuum', 'autovacuum_max_workers'),
  },

  // Preload libraries, and the settings that belong to them
  shared_preload_libraries: {
    type: 'libraries', context: 'postmaster', default: '',
    summary: `libraries loaded at server start; allowed: ${PRELOAD_LIBRARIES.join(', ')}`,
    docs: guc('runtime-config-client', 'shared_preload_libraries'),
  },
  'pg_stat_statements.max': {
    type: 'integer', min: 100, max: 100000, context: 'postmaster', default: '5000', library: 'pg_stat_statements',
    summary: 'distinct statements tracked',
    docs: `${DOCS}/pgstatstatements.html#PGSTATSTATEMENTS-CONFIG-PARAMS`,
  },
  'pg_stat_statements.track': {
    type: 'enum', values: ['none', 'top', 'all'], context: 'superuser', default: 'top', library: 'pg_stat_statements',
    summary: 'which statements are counted: top-level, all including nested, or none',
    docs: `${DOCS}/pgstatstatements.html#PGSTATSTATEMENTS-CONFIG-PARAMS`,
  },
  'pg_stat_statements.track_utility': {
    type: 'bool', context: 'superuser', default: 'on', library: 'pg_stat_statements',
    summary: 'count utility commands too (anything not SELECT, INSERT, UPDATE, DELETE, MERGE)',
    docs: `${DOCS}/pgstatstatements.html#PGSTATSTATEMENTS-CONFIG-PARAMS`,
  },
  'auto_explain.log_min_duration': {
    type: 'duration', unitMs: 1, minMs: 0, maxMs: PG_INT_MAX, minusOne: true, context: 'superuser', default: '-1',
    library: 'auto_explain',
    summary: 'log the plan of every statement at least this slow (-1 disables)',
    docs: `${DOCS}/auto-explain.html#AUTO-EXPLAIN-CONFIGURATION-PARAMETERS-LOG-MIN-DURATION`,
  },
  'auto_explain.log_analyze': {
    type: 'bool', context: 'superuser', default: 'off', library: 'auto_explain',
    summary: 'log EXPLAIN ANALYZE rather than EXPLAIN; times every plan node of every statement',
    docs: `${DOCS}/auto-explain.html#AUTO-EXPLAIN-CONFIGURATION-PARAMETERS-LOG-ANALYZE`,
  },
  'auto_explain.log_buffers': {
    type: 'bool', context: 'superuser', default: 'off', library: 'auto_explain',
    summary: 'include buffer usage (needs log_analyze)',
    docs: `${DOCS}/auto-explain.html#AUTO-EXPLAIN-CONFIGURATION-PARAMETERS-LOG-BUFFERS`,
  },
  'auto_explain.log_format': {
    type: 'enum', values: ['text', 'xml', 'json', 'yaml'], context: 'superuser', default: 'text', library: 'auto_explain',
    summary: 'format of the logged plans',
    docs: `${DOCS}/auto-explain.html#AUTO-EXPLAIN-CONFIGURATION-PARAMETERS-LOG-FORMAT`,
  },
}

// Extensions in the stock image that do nothing useful until a library is
// preloaded. CREATE EXTENSION succeeds either way, which is the trap:
// pg_stat_statements is created, and every read of its view then fails.
// Checked in postgres:18-alpine on 2026-11-17; of the 60 extensions it
// ships, pg_stat_statements is the only one whose objects refuse to work
// without a preload (pg_prewarm's functions work without one; only its
// autoprewarm worker needs it, see PRELOAD_LIBRARIES). pg_cron is listed
// although the stock image does not ship it, because HOBBY_IMAGE may name
// one that does, and the answer for it is no rather than "preload it".
export interface ExtensionPreload {
  library: string
  // False when hobby will not preload the library at all.
  allowed: boolean
  why?: string
}

export const EXTENSION_PRELOADS: Readonly<Record<string, ExtensionPreload>> = {
  pg_stat_statements: { library: 'pg_stat_statements', allowed: true },
  pg_cron: {
    library: 'pg_cron',
    allowed: false,
    why:
      'pg_cron runs jobs only while the database is awake, so on a database that sleeps its schedule silently stops, ' +
      'and its launcher is a background worker; worker cron triggers (`hobby cron ls`) wake what they run instead',
  },
}

export type PostgresSettings = Record<string, string>

export interface SettingInfo {
  name: string
  type: SettingSpec['type']
  context: SettingContext
  restartRequired: boolean
  default: string
  summary: string
  docs: string
  min?: string
  max?: string
  values?: string[]
  library?: string
}

function formatKb(kb: number): string {
  if (kb % GB === 0) return `${kb / GB}GB`
  if (kb % MB === 0) return `${kb / MB}MB`
  return `${kb}kB`
}

function formatMs(ms: number): string {
  if (ms === PG_INT_MAX) return `${ms}ms`
  if (ms % DAY === 0) return `${ms / DAY}d`
  if (ms % (60 * MIN) === 0) return `${ms / (60 * MIN)}h`
  if (ms % MIN === 0) return `${ms / MIN}min`
  if (ms % SEC === 0) return `${ms / SEC}s`
  return `${ms}ms`
}

// The allowlist as the API reports it, in declaration order.
export function settingCatalog(): SettingInfo[] {
  return Object.entries(SETTINGS).map(([name, spec]) => {
    const info: SettingInfo = {
      name,
      type: spec.type,
      context: spec.context,
      restartRequired: spec.context === 'postmaster',
      default: spec.default,
      summary: spec.summary,
      docs: spec.docs,
      ...(spec.library !== undefined ? { library: spec.library } : {}),
    }
    switch (spec.type) {
      case 'integer':
      case 'real':
        return { ...info, min: String(spec.min), max: String(spec.max) }
      case 'memory':
        return { ...info, min: spec.minusOne === true ? '-1' : formatKb(spec.minKb), max: formatKb(spec.maxKb) }
      case 'duration':
        return { ...info, min: spec.minusOne === true ? '-1' : formatMs(spec.minMs), max: formatMs(spec.maxMs) }
      case 'enum':
        return { ...info, values: [...spec.values] }
      case 'libraries':
        return { ...info, values: [...PRELOAD_LIBRARIES] }
      default:
        return info
    }
  })
}

const MEMORY_UNITS: Record<string, number> = { B: 1 / 1024, kB: KB, MB, GB, TB: 1024 * GB }
const TIME_UNITS: Record<string, number> = { us: 1 / 1000, ms: 1, s: SEC, min: MIN, h: 60 * MIN, d: DAY }

function bad(name: string, raw: string, why: string): HobbyError {
  return new HobbyError('usage', `${name}=${raw} is not a valid value: ${why}`, `see ${SETTINGS[name]?.docs ?? DOCS}`)
}

function asText(name: string, value: unknown): string {
  if (typeof value === 'string') return value.trim()
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  if (typeof value === 'boolean') return value ? 'on' : 'off'
  throw new HobbyError('usage', `${name} must be a string, number or boolean`)
}

// Postgres's own spelling: an integer and, optionally, a case-sensitive
// unit straight after it or after a space. Only the forms Postgres accepts
// for the setting's type get through, so a value never needs quoting in
// argv or in the compose file.
function parseUnit(name: string, raw: string, units: Record<string, number>, kind: string): { n: number; scale: number | null } {
  const match = /^(-?\d+)\s*([A-Za-z]*)$/.exec(raw)
  if (match === null) {
    throw bad(name, raw, `expected a whole number with an optional unit (${Object.keys(units).join(', ')})`)
  }
  const n = Number(match[1])
  const unit = match[2] ?? ''
  if (unit === '') return { n, scale: null }
  const scale = units[unit]
  if (scale === undefined) {
    throw bad(name, raw, `${unit} is not a ${kind} unit; Postgres accepts ${Object.keys(units).join(', ')} (case-sensitive)`)
  }
  return { n, scale }
}

function normalizeValue(name: string, spec: SettingSpec, value: unknown): string {
  const raw = asText(name, value)
  switch (spec.type) {
    case 'integer': {
      if (!/^-?\d+$/.test(raw)) throw bad(name, raw, 'expected a whole number')
      const n = Number(raw)
      if (n < spec.min || n > spec.max) throw bad(name, raw, `allowed range is ${spec.min} to ${spec.max}`)
      return String(n)
    }
    case 'real': {
      if (!/^-?(\d+\.?\d*|\.\d+)$/.test(raw)) throw bad(name, raw, 'expected a number')
      const n = Number(raw)
      if (n < spec.min || n > spec.max) throw bad(name, raw, `allowed range is ${spec.min} to ${spec.max}`)
      return String(n)
    }
    case 'bool': {
      const lower = raw.toLowerCase()
      if (['on', 'true', 'yes', '1'].includes(lower)) return 'on'
      if (['off', 'false', 'no', '0'].includes(lower)) return 'off'
      throw bad(name, raw, 'expected on or off')
    }
    case 'enum': {
      const lower = raw.toLowerCase()
      if (!spec.values.includes(lower)) throw bad(name, raw, `allowed values are ${spec.values.join(', ')}`)
      return lower
    }
    case 'memory': {
      const { n, scale } = parseUnit(name, raw, MEMORY_UNITS, 'memory')
      if (n === -1 && spec.minusOne === true && scale === null) return '-1'
      const kb = n * (scale ?? spec.unitKb)
      if (kb < spec.minKb || kb > spec.maxKb) {
        throw bad(name, raw, `allowed range is ${spec.minusOne === true ? '-1 (off), or ' : ''}${formatKb(spec.minKb)} to ${formatKb(spec.maxKb)}`)
      }
      return raw.replace(/\s+/g, '')
    }
    case 'duration': {
      const { n, scale } = parseUnit(name, raw, TIME_UNITS, 'time')
      if (n === -1 && spec.minusOne === true && scale === null) return '-1'
      const ms = n * (scale ?? spec.unitMs)
      if (ms < spec.minMs || ms > spec.maxMs) {
        throw bad(name, raw, `allowed range is ${spec.minusOne === true ? '-1 (off), or ' : ''}${formatMs(spec.minMs)} to ${formatMs(spec.maxMs)}`)
      }
      return raw.replace(/\s+/g, '')
    }
    case 'libraries': {
      const libs: string[] = []
      for (const part of raw.split(',')) {
        const lib = part.trim()
        if (lib === '') continue
        if (!(PRELOAD_LIBRARIES as readonly string[]).includes(lib)) {
          const known = EXTENSION_PRELOADS[lib]
          throw new HobbyError(
            'usage',
            `${lib} is not a library hobby preloads`,
            known !== undefined && !known.allowed
              ? known.why
              : `allowed: ${PRELOAD_LIBRARIES.join(', ')}. pg_prewarm is left out on purpose (ADR 0020, autoprewarm made the first queries after a wake slower)`
          )
        }
        if (!libs.includes(lib)) libs.push(lib)
      }
      if (libs.length === 0) {
        throw bad(name, raw, `name at least one library, or unset ${name} to preload none`)
      }
      return libs.join(',')
    }
  }
}

export function preloadedLibraries(settings: PostgresSettings | undefined): string[] {
  const raw = settings?.['shared_preload_libraries']
  return raw === undefined || raw === '' ? [] : raw.split(',')
}

function checkSettingName(name: string): SettingSpec {
  const spec = SETTINGS[name]
  if (spec === undefined) {
    throw new HobbyError(
      'usage',
      `${name} is not a setting hobby allows`,
      '`hobby pg config ls <target> --all` lists every allowed setting with its range; anything else is refused so a typo or a setting that can stop the server from booting never reaches a container'
    )
  }
  return spec
}

// The whole declaration, after a set and an unset are applied to what is
// stored. Checked as a whole, because a setting that belongs to a library
// is only valid while that library is preloaded, whichever of the two
// changed.
export function nextSettings(
  current: PostgresSettings | undefined,
  change: { set?: Record<string, unknown>; unset?: string[] }
): PostgresSettings {
  const next: PostgresSettings = { ...(current ?? {}) }
  for (const raw of change.unset ?? []) {
    const name = String(raw).trim()
    checkSettingName(name)
    delete next[name]
  }
  for (const [rawName, value] of Object.entries(change.set ?? {})) {
    const name = rawName.trim()
    const spec = checkSettingName(name)
    if (change.unset?.includes(name) === true) {
      throw new HobbyError('usage', `${name} is both set and unset in one request`)
    }
    next[name] = normalizeValue(name, spec, value)
  }
  const libs = preloadedLibraries(next)
  const orphaned = Object.keys(next).filter((name) => {
    const lib = SETTINGS[name]?.library
    return lib !== undefined && !libs.includes(lib)
  })
  if (orphaned.length > 0) {
    const needed = [...new Set(orphaned.map((name) => SETTINGS[name]!.library!))]
    throw new HobbyError(
      'usage',
      `${orphaned.join(', ')} ${orphaned.length === 1 ? 'belongs' : 'belong'} to ${needed.join(', ')}, which would not be preloaded`,
      `add it with shared_preload_libraries=${[...libs, ...needed.filter((lib) => !libs.includes(lib))].join(',')}, or unset ${orphaned.join(' ')} too`
    )
  }
  // Sorted, so the container's argv and the compose command are stable
  // whatever order the settings were given in.
  return Object.fromEntries(Object.entries(next).sort(([a], [b]) => a.localeCompare(b)))
}

// For a stored declaration (a create body, or a row written by an older
// daemon): every name allowlisted and every value valid.
export function validateSettings(input: unknown, route: string): PostgresSettings {
  if (input === undefined || input === null) return {}
  if (typeof input !== 'object' || Array.isArray(input)) {
    throw new HobbyError('usage', 'settings must be an object of name to value', `${route} expects { "settings": { "shared_buffers": "256MB" } }`)
  }
  return nextSettings({}, { set: input as Record<string, unknown> })
}

// The server arguments a declaration becomes. Empty for no settings, so a
// resource that declares none runs the image's own default command exactly
// as before this existed. `postgres` first: the official entrypoint passes
// the whole command to its initdb temp server as well, so a first boot
// already runs with the declared settings.
export function settingsCommand(settings: PostgresSettings | undefined): string[] {
  const entries = Object.entries(settings ?? {})
  if (entries.length === 0) return []
  const argv = ['postgres']
  for (const [name, value] of entries.sort(([a], [b]) => a.localeCompare(b))) {
    argv.push('-c', `${name}=${value}`)
  }
  return argv
}

export interface MissingPreload {
  extension: string
  library: string
  allowed: boolean
}

// Extensions, from a list of names, whose library is not preloaded.
export function missingPreloads(extensions: Iterable<string>, settings: PostgresSettings | undefined): MissingPreload[] {
  const libs = preloadedLibraries(settings)
  const out: MissingPreload[] = []
  for (const extension of new Set(extensions)) {
    const need = EXTENSION_PRELOADS[extension]
    if (need !== undefined && !libs.includes(need.library)) {
      out.push({ extension, library: need.library, allowed: need.allowed })
    }
  }
  return out
}

// The refusal `hobby pg ext add` and a create with --extension both give:
// names the library, and the exact command that would preload it.
export function refuseMissingPreloads(missing: MissingPreload[], settings: PostgresSettings | undefined, target: string): void {
  if (missing.length === 0) return
  const refused = missing.filter((m) => !m.allowed)
  if (refused.length > 0) {
    throw new HobbyError(
      'usage',
      `${refused.map((m) => m.extension).join(', ')} needs ${refused.map((m) => m.library).join(', ')} preloaded, which hobby does not allow`,
      EXTENSION_PRELOADS[refused[0]!.extension]?.why
    )
  }
  const libs = preloadedLibraries(settings)
  const want = [...libs, ...missing.map((m) => m.library).filter((lib, i, all) => !libs.includes(lib) && all.indexOf(lib) === i)]
  throw new HobbyError(
    'usage',
    `${missing.map((m) => m.extension).join(', ')} only works with ${missing.map((m) => m.library).join(', ')} in shared_preload_libraries, and it is not there`,
    `preload it first: hobby pg config set ${target} shared_preload_libraries=${want.join(',')}` +
      ' (this restarts the database if it is awake), then add the extension again'
  )
}
