// `hobby import`: copy an existing Postgres database (Neon, Supabase, RDS, a
// local server, anything reachable) into a hobby postgres resource, with
// stock pg_dump and pg_restore. docs/portability/CLAUDE.md's 2026-11-17
// import amendment is the design record; this file is the implementation.
//
// The shape, after github.com/xataio/migration-tool's migrate.sh (read, not
// copied) minus its logical-replication phase: an import is a one-shot copy,
// and a subscription held open against the source would keep the target
// awake forever, which is the wedge (ADR 0007) losing to a convenience.
//
// Everything Postgres-facing runs in ONE throwaway container, from the
// target resource's own image (`--pull never`: it is on the box, because the
// target is running from it). That is what makes the host need no client
// tools, and what makes pg_dump's version the target's: pg_dump can dump a
// server of its own major version or older, never a newer one, and the
// script checks that before dumping anything. One container rather than one
// per step because the dump lives in the container's own filesystem: never
// on the host (no cleanup, no Linux ownership question, no 0600 file to
// forget) and gone with `--rm`.
//
// The credential's path. The daemon renders a libpq service file holding
// both connections (packages/pg/src/import-source.ts) and writes it to the
// container's stdin; the script's first act is to copy stdin into a file in
// a 0700 directory inside the container, and every pg tool is then told only
// `service=source` or `service=target`. Nothing secret is in any argv (the
// host's process list shows container processes), in the container's
// environment (`docker inspect` shows that), or on the host's disk.
// Whatever the tools print is redacted (redactor, import-source.ts) before
// it reaches an error, a response or a log line.
//
// Awake while it runs, asleep after. The import holds an activity handle on
// the target (ActivityTracker.open), which is how the hibernator already
// knows not to stop a resource with a live connection, and the restore
// session itself carries HOBBY_APPLICATION_NAME so the pre-sleep guard does
// not count it either way. When the import ends the handle closes and the
// ordinary idle countdown starts from that moment. The project is also held
// exclusive (holdProjectExclusive), so a snapshot or an in-place restore
// cannot interleave with a restore into the same database.

import { Readable } from 'node:stream'
import { randomBytes } from 'node:crypto'
import {
  DEFAULT_POSTGRES_NAME,
  HobbyError,
  defaultDockerExec,
  validateName,
  type ExecFn,
  type PostgresResource,
  type Project,
  type Resource,
} from '@hobby.sh/core'
import {
  HOBBY_APPLICATION_NAME,
  PER_PROJECT_IMAGE_ISSUE,
  createPostgres,
  parseSourceConnection,
  redactor,
  renderServiceSection,
  type SourceConnection,
} from '@hobby.sh/pg'
import { getOrCreateWake, holdProjectExclusive, type DaemonContext } from './context.js'

export interface ImportRequest {
  project: string
  // A postgres resource in the project. Omitted: the project's only one, or
  // a new one named DEFAULT_POSTGRES_NAME when the project has none.
  resource?: string
  // The connection string itself. Clients resolve it from stdin, a file or
  // an environment variable on their side (the CLI and the MCP server both
  // do); the daemon never reads a file or an environment variable for it.
  source: string
  // pg_dump --schema patterns. When any are given, the import is
  // "restricted": pg_dump then dumps no extensions on its own, so the
  // source's extensions that the target image ships are added back with
  // --extension and their schemas created first.
  schemas: string[]
  // pg_dump --exclude-schema patterns.
  excludeSchemas: string[]
  // pg_restore --single-transaction --exit-on-error: all or nothing.
  strict: boolean
}

export interface ImportReport {
  project: string
  resource: string
  resourceId: string
  // What the import made, so a caller knows what a failure rolled back and
  // what a success created.
  created: 'project' | 'resource' | null
  source: {
    host: string
    database: string | null
    serverVersion: string
    bytes: number | null
    // The source named localhost; it was reached as host.docker.internal.
    viaHostAlias: boolean
  }
  image: string
  pgDumpMajor: number
  dumpBytes: number
  // TABLE entries in the dump, and the tables and rows the target holds
  // after the restore. Rows are pg_class.reltuples right after an ANALYZE the
  // import runs: exact for small tables, a sampled estimate for large ones.
  dumpTables: number
  tables: number
  rows: number
  rowsAreEstimates: true
  targetBytes: number
  durationMs: number
  extensions: {
    // Created on the target by the restore.
    copied: string[]
    // Installed on the source and not part of this import, with the schema
    // each lives in: outside the selected schemas, or not shipped by the
    // target image.
    notCopied: Array<{ name: string; schema: string; shipped: boolean }>
  }
  restore: {
    // pg_restore's own error count (it continues past errors unless strict).
    errors: number
    // Up to RESTORE_MESSAGE_LIMIT of them, deduplicated, redacted.
    messages: string[]
    // Errors that every restricted import of `public` produces and that
    // change nothing (pg_dump --schema=public emits CREATE SCHEMA public).
    expected: string[]
  }
  warnings: string[]
}

// What the daemon reads back from the container: one `hobby-import <key>
// <value>` line per fact. Exported for the tests.
export const IMPORT_SCRIPT_MARKER = 'hobby-import'

// The script. POSIX sh, so it runs in a debian image's dash and an alpine
// image's busybox ash alike. `$@` is the pg_dump selection flags, passed as
// separate argv elements and never interpolated into a shell string. Exit
// codes: 0 done (restore errors, if any, are reported on stdout), 3 a step
// failed (`fail <step>` names it, the tool's stderr follows on stderr), 4
// target not empty, 5 source too new for this pg_dump, 6 extensions the
// image does not ship, 7 a strict restore failed and rolled back.
export const IMPORT_SCRIPT = String.raw`set -u
umask 077
W=$(mktemp -d)
export PGSERVICEFILE="$W/pg_service.conf"
cat > "$PGSERVICEFILE"
TAB=$(printf '\t')
say() { printf 'hobby-import %s\n' "$*"; }
fail() { say "fail $1"; if [ -s "$2" ]; then tail -c 8192 "$2" >&2; fi; exit 3; }
q() { psql -X -q -A -t -v ON_ERROR_STOP=1 -d "service=$1" -c "$2"; }
major=$(pg_dump --version | sed -E 's/^[^0-9]*([0-9]+).*/\1/')
say pg-dump-major "$major"
q target "$HOBBY_IMPORT_EMPTY_SQL" > "$W/out" 2> "$W/err" || fail connect-target "$W/err"
say target-objects "$(cat "$W/out")"
[ "$(cat "$W/out")" = 0 ] || exit 4
q source 'SHOW server_version_num' > "$W/out" 2> "$W/err" || fail connect-source "$W/err"
say source-version "$(cat "$W/out")"
[ "$(( $(cat "$W/out") / 10000 ))" -le "$major" ] || exit 5
q source 'SELECT pg_database_size(current_database())' > "$W/out" 2> /dev/null && say source-bytes "$(cat "$W/out")"
q target 'SELECT name FROM pg_available_extensions' > "$W/avail" 2> "$W/err" || fail connect-target "$W/err"
q source "SELECT e.extname || E'\t' || n.nspname FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace WHERE e.extname <> 'plpgsql' ORDER BY 1" > "$W/exts" 2> "$W/err" || fail connect-source "$W/err"
: > "$W/extschemas"
while IFS="$TAB" read -r name schema; do
  [ -n "$name" ] || continue
  if grep -qxF "$name" "$W/avail"; then say source-extension "$name" "$schema" shipped; else say source-extension "$name" "$schema" missing; fi
  if [ "$HOBBY_IMPORT_RESTRICTED" = 1 ] && grep -qxF "$name" "$W/avail"; then
    set -- "$@" "--extension=\"$name\""
    printf '%s\n' "$schema" >> "$W/extschemas"
  fi
done < "$W/exts"
pg_dump -d service=source --format=custom --no-owner --no-acl --no-subscriptions --no-security-labels --no-tablespaces "$@" -f "$W/db.dump" 2> "$W/err" || fail dump "$W/err"
say dump-bytes "$(wc -c < "$W/db.dump" | tr -d ' ')"
pg_restore -l "$W/db.dump" > "$W/toc" 2> "$W/err" || fail list "$W/err"
awk '$4 == "TABLE" && $5 != "DATA" { n++ } END { print "hobby-import dump-tables " (n + 0) }' "$W/toc"
missing=0
for e in $(awk '$4 == "EXTENSION" && $5 == "-" { print $6 }' "$W/toc"); do
  say dump-extension "$e"
  if ! grep -qxF "$e" "$W/avail"; then say missing-extension "$e"; missing=1; fi
done
[ "$missing" = 0 ] || exit 6
sort -u "$W/extschemas" | while read -r s; do
  printf '%s\n' "SELECT format('CREATE SCHEMA IF NOT EXISTS %I', :'s') \\gexec" | psql -X -q -v ON_ERROR_STOP=1 -v s="$s" -d service=target -f - > /dev/null 2> "$W/err" || fail create-schema "$W/err"
done
if [ "$HOBBY_IMPORT_STRICT" = 1 ]; then
  pg_restore -d service=target --no-owner --no-acl --single-transaction --exit-on-error "$W/db.dump" 2> "$W/err"
else
  pg_restore -d service=target --no-owner --no-acl "$W/db.dump" 2> "$W/err"
fi
rc=$?
say restore-exit "$rc"
say restore-errors "$(grep -c '^pg_restore: error:' "$W/err")"
grep '^pg_restore: error:' "$W/err" | head -n 50 | sed 's/^pg_restore: error: /hobby-import restore-error /'
[ "$rc" = 0 ] || [ "$HOBBY_IMPORT_STRICT" != 1 ] || exit 7
q target 'ANALYZE' > /dev/null 2> "$W/err" || fail analyze "$W/err"
q target "$HOBBY_IMPORT_STATS_SQL" > "$W/out" 2> "$W/err" || fail stats "$W/err"
sed 's/^/hobby-import /' "$W/out"
say done
`

// "Empty" means no table, view, sequence, foreign table or function outside
// what an extension installed: `hobby pg ext add` before an import (the
// Supabase path) must not make the target count as full, and postgis's
// spatial_ref_sys is an extension's table, not the user's.
export const EMPTY_SQL = `SELECT
 (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg\\_%'
     AND c.relkind IN ('r', 'p', 'v', 'm', 'S', 'f')
     AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_class'::regclass AND d.objid = c.oid AND d.deptype = 'e'))
 + (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg\\_%'
     AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e'))`

// Ordinary tables only (relkind r, partitions included, partitioned parents
// not, so no row is counted twice).
export const STATS_SQL = `SELECT 'tables ' || count(*) || E'\\n' || 'rows ' || coalesce(sum(greatest(c.reltuples, 0))::bigint, 0) || E'\\n' || 'target-bytes ' || pg_database_size(current_database())
 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE c.relkind = 'r' AND n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg\\_%'`

const RESTORE_MESSAGE_LIMIT = 20
// libpq's connect_timeout default for both sessions; a keyword in the source
// string overrides it for the source.
const CONNECT_TIMEOUT_SECONDS = 15
const POSTGRES_CONTAINER_PORT = 5432
// pg_dump pattern syntax allows almost anything; this only keeps a pattern
// from being mistaken for a flag and from carrying a control character.
const SCHEMA_PATTERN = /^[^\0-\x1f-][^\0-\x1f]{0,126}$/

export interface ImportDeps {
  // Removes a project this import created, on failure.
  deleteProject(ctx: DaemonContext, name: string): Promise<void>
}

function readPatterns(raw: unknown, field: string): string[] {
  if (raw === undefined) return []
  if (!Array.isArray(raw) || raw.some((s) => typeof s !== 'string' || !SCHEMA_PATTERN.test(s))) {
    throw new HobbyError('usage', `${field} must be an array of schema names or pg_dump patterns`, 'for example ["public"]')
  }
  return [...new Set(raw as string[])]
}

// Validates the request body. The source is checked for presence only here:
// parsing it is parseSourceConnection's job, and it never quotes the input.
export function readImportRequest(body: unknown): ImportRequest {
  const fields = body !== null && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : {}
  const project = fields['project']
  if (typeof project !== 'string' || project.length === 0) {
    throw new HobbyError('usage', 'project is required', 'POST /v1/import expects { "project": string, "source": string, ... }')
  }
  validateName(project)
  const resource = fields['resource']
  if (resource !== undefined && (typeof resource !== 'string' || resource.length === 0)) {
    throw new HobbyError('usage', 'resource must be a resource name')
  }
  if (typeof resource === 'string') validateName(resource)
  const source = fields['source']
  if (typeof source !== 'string' || source.trim().length === 0) {
    throw new HobbyError(
      'usage',
      'source is required',
      'the source connection string; the CLI reads it from stdin, --from-file or --from-env so it never lands in shell history'
    )
  }
  const strict = fields['strict']
  if (strict !== undefined && typeof strict !== 'boolean') {
    throw new HobbyError('usage', 'strict must be a boolean')
  }
  return {
    project,
    ...(typeof resource === 'string' ? { resource } : {}),
    source,
    schemas: readPatterns(fields['schemas'], 'schemas'),
    excludeSchemas: readPatterns(fields['excludeSchemas'], 'excludeSchemas'),
    strict: strict === true,
  }
}

interface Target {
  project: Project
  resource: PostgresResource
  created: 'project' | 'resource' | null
}

function postgresOf(resource: Resource): PostgresResource | null {
  return resource.kind === 'postgres' ? (resource as PostgresResource) : null
}

async function resolveTarget(ctx: DaemonContext, request: ImportRequest, deps: ImportDeps): Promise<Target> {
  const existing = ctx.store.getProjectByName(request.project)
  if (existing === null) {
    const project = ctx.store.createProject({ name: request.project, sleepAfterSeconds: ctx.config.sleepAfterSeconds })
    try {
      const resource = await createPostgres(ctx, { project, name: request.resource ?? DEFAULT_POSTGRES_NAME })
      return { project, resource, created: 'project' }
    } catch (err) {
      await deps.deleteProject(ctx, project.name).catch(() => {})
      throw err
    }
  }
  if (existing.releasedAt != null) {
    throw new HobbyError(
      'conflict',
      `${existing.name} was released and is no longer managed by hobby`,
      `run \`hobby adopt ${existing.name}\` first, or import into a new project`
    )
  }
  const resources = ctx.store.listResources(existing.id)
  if (request.resource !== undefined) {
    const named = resources.find((r) => r.name === request.resource)
    if (named === undefined) {
      const resource = await createPostgres(ctx, { project: existing, name: request.resource })
      return { project: existing, resource, created: 'resource' }
    }
    const pg = postgresOf(named)
    if (pg === null) {
      throw new HobbyError('usage', `${existing.name}/${named.name} is a ${named.kind}, not a postgres resource`)
    }
    return { project: existing, resource: pg, created: null }
  }
  const postgres = resources.map(postgresOf).filter((r): r is PostgresResource => r !== null)
  if (postgres.length > 1) {
    throw new HobbyError(
      'ambiguous_target',
      `${existing.name} has ${postgres.length} postgres resources`,
      `name one with --resource (${postgres.map((r) => r.name).join(', ')})`
    )
  }
  if (postgres.length === 0) {
    const resource = await createPostgres(ctx, { project: existing, name: DEFAULT_POSTGRES_NAME })
    return { project: existing, resource, created: 'resource' }
  }
  return { project: existing, resource: postgres[0] as PostgresResource, created: null }
}

function targetKeywords(resource: PostgresResource): Array<[string, string]> {
  return [
    ['host', resource.config.containerName],
    ['port', String(POSTGRES_CONTAINER_PORT)],
    ['user', resource.config.superuser],
    ['password', resource.config.password],
    ['dbname', resource.config.database],
    // The pre-sleep guard (checkActiveQuery) skips sessions with this name.
    ['application_name', HOBBY_APPLICATION_NAME],
    // The target is on the project's own bridge network, container to
    // container; the stock image does not configure TLS.
    ['sslmode', 'disable'],
  ]
}

// The docker argv. Exported for the tests, which assert that no secret is
// in it.
export function importDockerArgs(opts: {
  containerName: string
  network: string
  image: string
  restricted: boolean
  strict: boolean
  dumpFlags: string[]
}): string[] {
  return [
    'run',
    '--rm',
    '-i',
    '--pull',
    'never',
    '--name',
    opts.containerName,
    '--network',
    opts.network,
    '--add-host',
    'host.docker.internal:host-gateway',
    '-e',
    `PGCONNECT_TIMEOUT=${CONNECT_TIMEOUT_SECONDS}`,
    '-e',
    `HOBBY_IMPORT_EMPTY_SQL=${EMPTY_SQL}`,
    '-e',
    `HOBBY_IMPORT_STATS_SQL=${STATS_SQL}`,
    '-e',
    `HOBBY_IMPORT_RESTRICTED=${opts.restricted ? 1 : 0}`,
    '-e',
    `HOBBY_IMPORT_STRICT=${opts.strict ? 1 : 0}`,
    '--entrypoint',
    'sh',
    opts.image,
    '-c',
    IMPORT_SCRIPT,
    'sh',
    ...opts.dumpFlags,
  ]
}

export interface ScriptOutput {
  facts: Map<string, string[]>
  sourceExtensions: Array<{ name: string; schema: string; shipped: boolean }>
  dumpExtensions: string[]
  missingExtensions: string[]
  restoreErrors: string[]
  fail: string | null
  done: boolean
}

export function parseScriptOutput(stdout: string): ScriptOutput {
  const out: ScriptOutput = {
    facts: new Map(),
    sourceExtensions: [],
    dumpExtensions: [],
    missingExtensions: [],
    restoreErrors: [],
    fail: null,
    done: false,
  }
  for (const line of stdout.split('\n')) {
    if (!line.startsWith(`${IMPORT_SCRIPT_MARKER} `)) continue
    const body = line.slice(IMPORT_SCRIPT_MARKER.length + 1)
    const space = body.indexOf(' ')
    const key = space === -1 ? body : body.slice(0, space)
    const value = space === -1 ? '' : body.slice(space + 1)
    switch (key) {
      case 'source-extension': {
        const [name = '', schema = '', status = ''] = value.split(' ')
        out.sourceExtensions.push({ name, schema, shipped: status === 'shipped' })
        break
      }
      case 'dump-extension':
        out.dumpExtensions.push(value)
        break
      case 'missing-extension':
        out.missingExtensions.push(value)
        break
      case 'restore-error':
        out.restoreErrors.push(value)
        break
      case 'fail':
        out.fail = value
        break
      case 'done':
        out.done = true
        break
      default:
        out.facts.set(key, [...(out.facts.get(key) ?? []), value])
    }
  }
  return out
}

function fact(out: ScriptOutput, key: string): string | null {
  const values = out.facts.get(key)
  return values === undefined ? null : (values[values.length - 1] ?? null)
}

function num(out: ScriptOutput, key: string): number | null {
  const value = fact(out, key)
  if (value === null || value.trim() === '') return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

function majorOf(versionNum: number): number {
  return Math.floor(versionNum / 10000)
}

const FAIL_STEPS: Record<string, string> = {
  'connect-target': 'could not connect to the target database from the import container',
  'connect-source': 'could not connect to the source database',
  dump: 'pg_dump failed',
  list: 'pg_restore could not read the dump',
  'create-schema': 'could not create an extension schema on the target',
  analyze: 'the restore finished but ANALYZE on the target failed',
  stats: 'the restore finished but reading the target\'s table counts failed',
}

function connectHint(source: SourceConnection, stderr: string): string {
  const hints: string[] = []
  if (/password authentication failed|authentication failed/i.test(stderr)) {
    hints.push('check the user and password in the source connection string')
  }
  if (/SSL|sslmode|encryption/i.test(stderr)) {
    hints.push('managed providers (Neon, Supabase) require TLS: add sslmode=require to the source connection string')
  }
  if (source.loopbackRewritten) {
    hints.push(
      'the source named localhost, which the import container reaches as host.docker.internal; on Linux the server must listen on the docker bridge address, not only 127.0.0.1'
    )
  }
  if (/timeout|could not translate host name|Name or service not known|Connection refused/i.test(stderr)) {
    hints.push('the import container needs outbound network access to the source host and port')
  }
  return hints.join('; ')
}

function summariseRestoreErrors(raw: string[], restricted: boolean): { messages: string[]; expected: string[] } {
  const expected: string[] = []
  const messages: string[] = []
  for (const message of raw) {
    const text = message.replace(/^could not execute query: /, '').replace(/\s+/g, ' ').trim()
    if (restricted && /^ERROR: schema "public" already exists$/.test(text)) {
      if (!expected.includes(text)) expected.push(text)
      continue
    }
    if (!messages.includes(text) && messages.length < RESTORE_MESSAGE_LIMIT) messages.push(text)
  }
  return { messages, expected }
}

function errorText(err: unknown): { stdout: string; stderr: string; message: string } {
  const e = (err !== null && typeof err === 'object' ? err : {}) as { stdout?: unknown; stderr?: unknown; message?: unknown }
  return {
    stdout: typeof e.stdout === 'string' ? e.stdout : '',
    stderr: typeof e.stderr === 'string' ? e.stderr : '',
    message: typeof e.message === 'string' ? e.message : String(err),
  }
}

function lastLines(text: string, n: number): string {
  return text.trim().split('\n').slice(-n).join('\n')
}

export async function runImport(ctx: DaemonContext, request: ImportRequest, deps: ImportDeps): Promise<ImportReport> {
  // Parse before anything is created: a malformed source must not leave an
  // empty project behind.
  const source = parseSourceConnection(request.source)
  const redact = redactor(source.secrets)
  const started = Date.now()
  const target = await resolveTarget(ctx, request, deps)
  const label = `${target.project.name}/${target.resource.name}`
  console.error(`import: ${label} from ${source.display.host} started`)

  let release: (() => void) | null = null
  let handle: ReturnType<DaemonContext['activity']['open']> | null = null
  let succeeded = false
  try {
    release = holdProjectExclusive(ctx, target.project.id, target.project.name, 'an import')
    if (target.resource.state !== 'running') {
      await getOrCreateWake(ctx)(target.resource.id)
    }
    const resource = ctx.store.getResource(target.resource.id)
    const ready = resource === null ? null : postgresOf(resource)
    if (ready === null || ready.state !== 'running') {
      throw new HobbyError('wake_failed', `${label} did not come up for the import`)
    }
    handle = ctx.activity.open(ready.id)

    const restricted = request.schemas.length > 0
    const dumpFlags = [
      ...request.schemas.map((s) => `--schema=${s}`),
      ...request.excludeSchemas.map((s) => `--exclude-schema=${s}`),
    ]
    const serviceFile =
      renderServiceSection('source', source.keywords) + renderServiceSection('target', targetKeywords(ready))
    const secretsWithTarget = redactor([...source.secrets, ready.config.password])
    const args = importDockerArgs({
      containerName: `hobby-import-${target.project.name}-${ready.name}-${randomBytes(3).toString('hex')}`,
      network: target.project.networkName,
      image: ready.config.image,
      restricted,
      strict: request.strict,
      dumpFlags,
    })

    const exec: ExecFn = ctx.importExec ?? defaultDockerExec
    let stdout: string
    let stderr: string
    let exitMessage: string | null = null
    try {
      ;({ stdout, stderr } = await exec('docker', args, { stdin: Readable.from([serviceFile]) }))
    } catch (err) {
      const e = errorText(err)
      stdout = e.stdout
      stderr = e.stderr
      exitMessage = e.message
    }
    stdout = secretsWithTarget(redact(stdout))
    stderr = secretsWithTarget(redact(stderr))
    const out = parseScriptOutput(stdout)
    const image = ready.config.image
    const pgDumpMajor = num(out, 'pg-dump-major')

    const objects = num(out, 'target-objects')
    if (objects !== null && objects > 0) {
      throw new HobbyError(
        'conflict',
        `${label} is not empty (${objects} tables, views, sequences or functions outside extensions), refusing to import into it`,
        'an import never restores over existing data. import into a new project (`hobby import <new-name>`), ' +
          `or a new resource (--resource <new-name>), or take a snapshot and empty this one yourself first`
      )
    }
    const sourceVersion = num(out, 'source-version')
    if (sourceVersion !== null && pgDumpMajor !== null && majorOf(sourceVersion) > pgDumpMajor) {
      throw new HobbyError(
        'usage',
        `the source runs PostgreSQL ${majorOf(sourceVersion)}, and the target image ${image} has pg_dump ${pgDumpMajor}, which cannot dump a newer server`,
        `import into a resource on an image of PostgreSQL ${majorOf(sourceVersion)} or newer: set HOBBY_IMAGE (or image in hobby.json) before creating it. ` +
          `Choosing an image per project is ${PER_PROJECT_IMAGE_ISSUE}`
      )
    }
    if (out.missingExtensions.length > 0) {
      throw new HobbyError(
        'usage',
        `the source uses ${out.missingExtensions.length === 1 ? 'an extension' : 'extensions'} the target image ${image} does not ship: ${out.missingExtensions.join(', ')}`,
        'nothing was restored. either restrict the import to the schemas you need (--schema public), which leaves those extensions out, ' +
          `or use an image that ships them (${PER_PROJECT_IMAGE_ISSUE}). \`hobby pg ext ls\` shows what a resource has installed`
      )
    }
    if (out.fail !== null) {
      const step = FAIL_STEPS[out.fail] ?? `the import step ${out.fail} failed`
      const detail = lastLines(stderr, 6)
      const hint = out.fail === 'connect-source' ? connectHint(source, stderr) : ''
      throw new HobbyError('runtime_unavailable', step, [detail, hint].filter((s) => s.length > 0).join('\n'))
    }
    if (request.strict && num(out, 'restore-exit') !== null && num(out, 'restore-exit') !== 0) {
      const { messages } = summariseRestoreErrors(out.restoreErrors, restricted)
      throw new HobbyError(
        'runtime_unavailable',
        'pg_restore failed and, being --strict, rolled the whole restore back',
        [...messages.slice(0, 5), 'run without --strict to restore everything that can be, with errors reported'].join('\n')
      )
    }
    if (!out.done) {
      // Nothing the script reports: docker itself failed (image missing,
      // daemon down) or the container was killed.
      throw new HobbyError(
        'runtime_unavailable',
        'the import container did not finish',
        lastLines([stderr, exitMessage === null ? '' : secretsWithTarget(redact(exitMessage))].join('\n'), 6) || 'no output'
      )
    }

    const { messages, expected } = summariseRestoreErrors(out.restoreErrors, restricted)
    const restoreErrors = Math.max(0, (num(out, 'restore-errors') ?? 0) - out.restoreErrors.filter((m) => restricted && /schema "public" already exists/.test(m)).length)
    const copied = out.dumpExtensions
    const notCopied = out.sourceExtensions
      .filter((e) => !copied.includes(e.name))
      .map((e) => ({ name: e.name, schema: e.schema, shipped: e.shipped }))
    const warnings: string[] = []
    if (restoreErrors > 0) {
      warnings.push(
        `pg_restore reported ${restoreErrors} error${restoreErrors === 1 ? '' : 's'}; everything else was restored. ` +
          'common causes: roles named in policies (create them, or use pg_dump 18\'s --no-policies by hand), objects in schemas left out'
      )
    }
    if (notCopied.some((e) => !e.shipped)) {
      warnings.push(
        `not shipped by ${image}, so not copied: ${notCopied.filter((e) => !e.shipped).map((e) => e.name).join(', ')} (${PER_PROJECT_IMAGE_ISSUE})`
      )
    }
    if (/-pooler\./.test(source.display.host)) {
      warnings.push('the source host is a connection pooler; pg_dump is meant for the direct (non-pooler) host')
    }
    const report: ImportReport = {
      project: target.project.name,
      resource: ready.name,
      resourceId: ready.id,
      created: target.created,
      source: {
        host: source.display.host,
        database: source.display.database,
        serverVersion: sourceVersion === null ? 'unknown' : `${majorOf(sourceVersion)}.${sourceVersion % 10000}`,
        bytes: num(out, 'source-bytes'),
        viaHostAlias: source.loopbackRewritten,
      },
      image,
      pgDumpMajor: pgDumpMajor ?? 0,
      dumpBytes: num(out, 'dump-bytes') ?? 0,
      dumpTables: num(out, 'dump-tables') ?? 0,
      tables: num(out, 'tables') ?? 0,
      rows: num(out, 'rows') ?? 0,
      rowsAreEstimates: true,
      targetBytes: num(out, 'target-bytes') ?? 0,
      durationMs: Date.now() - started,
      extensions: { copied, notCopied },
      restore: { errors: restoreErrors, messages, expected },
      warnings,
    }
    succeeded = true
    console.error(
      `import: ${label} finished in ${Math.round(report.durationMs / 1000)}s: ${report.tables} tables, ${report.rows} rows, ${restoreErrors} restore errors`
    )
    return report
  } catch (err) {
    // A HobbyError built above already carries only redacted text. Anything
    // else (an exception with a message from somewhere unexpected) is
    // redacted here rather than reaching handleRequest's logger as-is.
    const safe =
      err instanceof HobbyError
        ? err
        : new HobbyError('internal', `import failed: ${redact(err instanceof Error ? err.message : String(err))}`)
    console.error(`import: ${label} failed: ${safe.message}`)
    throw safe
  } finally {
    if (handle !== null) ctx.activity.close(handle)
    release?.()
    if (!succeeded && target.created !== null) {
      await rollback(ctx, target, deps)
    }
  }
}

// Only ever what this import created: a project or a resource that held
// nothing before the import began. An existing resource is never removed.
async function rollback(ctx: DaemonContext, target: Target, deps: ImportDeps): Promise<void> {
  try {
    if (target.created === 'project') {
      await deps.deleteProject(ctx, target.project.name)
    } else if (target.created === 'resource') {
      const current = ctx.store.getResource(target.resource.id)
      if (current !== null) {
        ctx.store.setResourceState(current.id, 'destroying')
        await ctx.kinds.get(current.kind).destroy(ctx, current)
      }
    }
  } catch (err) {
    console.error(
      `import: could not remove the ${target.created} it created for ${target.project.name}: ${err instanceof Error ? err.message : String(err)}`
    )
  }
}
