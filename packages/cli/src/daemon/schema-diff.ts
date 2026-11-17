// Schema diff between two projects (a branch and its parent by default):
// `hobby diff`. Neon's schema diff, with stock tools: each postgres resource
// is dumped with `pg_dump --schema-only` run inside its own container, over
// its local socket, and the two dumps of each same-named pair are compared
// as a unified line diff (unified-diff.ts).
//
// Why inside the container, the same answer basebackup.ts gives for
// pg_basebackup: the image's pg_dump matches the server's major version by
// construction, nothing has to be installed on the host, and the local
// socket is `trust` in the official image's pg_hba.conf, so no password is
// handled here at all. ComputeRuntime.execStream is the seam, so the whole
// flow runs against the fake runtime in tests.
//
// It wakes what it compares. A dump needs a running server, so a sleeping
// resource is woken through the same wake path the proxy and the query route
// use (getOrCreateWake, context.ts), which also respects a snapshot's or a
// reset's hold. What it does not do is keep anything awake afterwards:
//
//   - the dump's session carries application_name=hobby
//     (HOBBY_APPLICATION_NAME, packages/pg/src/activity-guard.ts), so the
//     pre-sleep guard ignores it exactly as it ignores the daemon's own
//     sessions;
//   - it is not a proxied connection, so the hibernator's connection count
//     never sees it, and nothing here touches the activity tracker. A
//     resource the diff woke gets the idle clock every wake starts
//     (startPostgres), and one already running keeps the clock it had.
//
// The cost of not holding a connection open in the tracker is that a
// database already at its idle threshold can be put to sleep by the
// hibernator in the middle of its dump. The dump then fails, the diff says
// so, and a retry wakes it again. That is preferred to restarting the idle
// clock of every database a diff touches.
//
// Only the database the resource was created with (PostgresConfig.database)
// is dumped, since that is the one hobby knows about; other databases made
// inside the same cluster by hand are not compared.

import { HobbyError, type PostgresResource, type Project } from '@hobby.sh/core'
import { HOBBY_APPLICATION_NAME } from '@hobby.sh/pg'
import { POSTGRES_SOCKET_DIR } from './basebackup.js'
import { getOrCreateWake, type DaemonContext } from './context.js'
import { diffLines, renderUnified, toHunks, type DiffHunk } from './unified-diff.js'

// A schema dump far past this is not a schema anyone diffs by eye, and
// collecting an unbounded stream into the daemon's memory is the failure
// basebackup.ts's streaming exists to avoid.
const MAX_DUMP_BYTES = 32 * 1024 * 1024

export type ResourceDiffStatus = 'same' | 'changed' | 'only-old' | 'only-new'

export interface ResourceSchemaDiff {
  name: string
  status: ResourceDiffStatus
  // The unified diff for this resource, '' when status is not 'changed'.
  diff: string
  hunks: DiffHunk[]
}

export interface SchemaDiffResult {
  // `old` is the side lines are removed from (`---`), `new` the side they
  // are added to (`+++`). For a branch against its parent, the parent is old.
  old: { project: string }
  new: { project: string }
  resources: ResourceSchemaDiff[]
  // Resources this diff had to wake. They sleep again on their own.
  woke: string[]
  // Whether any resource's schema differs.
  identical: boolean
}

export interface SchemaDiffOptions {
  // Test seam: production wakes through getOrCreateWake.
  wake?: (resourceId: string) => Promise<void>
}

// libpq's connection-string quoting: a value in single quotes, with
// backslash and single quote escaped. Every value here is a validated name
// today, so this is insurance rather than a fix, and it is what keeps a
// space in some future database name from becoming a second keyword.
function conninfoValue(value: string): string {
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`
}

// The whole pg_dump invocation, as an argument array, never a shell string.
//
//   --schema-only        DDL only, no rows.
//   --no-password        never prompt: the socket is `trust`, and a prompt
//                        with no terminal would hang.
//   --dbname=<conninfo>  host is the local socket, so the connection is the
//                        one pg_hba admits without a password, and
//                        application_name is HOBBY_APPLICATION_NAME, which
//                        is what makes the session invisible to the
//                        activity guard. pg_dump has no flag of its own for
//                        application_name, and the exec carries no
//                        environment, so it rides in the conninfo.
export function pgDumpSchemaCommand(config: { superuser: string; database: string }): string[] {
  const conninfo = [
    `host=${conninfoValue(POSTGRES_SOCKET_DIR)}`,
    `user=${conninfoValue(config.superuser)}`,
    `dbname=${conninfoValue(config.database)}`,
    `application_name=${conninfoValue(HOBBY_APPLICATION_NAME)}`,
  ].join(' ')
  return ['pg_dump', '--schema-only', '--no-password', `--dbname=${conninfo}`]
}

// Lines that differ between two dumps of identical schemas, removed before
// comparing:
//
//   - `-- Dumped from database version` and `-- Dumped by pg_dump version`
//     name the server and tool, not the schema.
//   - `\restrict <key>` and `\unrestrict <key>`, which pg_dump has written
//     since the August 2025 minor releases (CVE-2025-8714) with a random key
//     per run, so two dumps of one database never match on those lines.
export function normalizeDump(text: string): string[] {
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  const kept = lines.filter(
    (line) =>
      !line.startsWith('-- Dumped from database version') &&
      !line.startsWith('-- Dumped by pg_dump version') &&
      !line.startsWith('\\restrict ') &&
      !line.startsWith('\\unrestrict ')
  )
  while (kept.length > 0 && kept[kept.length - 1] === '') {
    kept.pop()
  }
  return kept
}

async function dumpSchema(ctx: DaemonContext, resource: PostgresResource): Promise<string> {
  const runtime = ctx.runtime
  if (runtime.execStream === undefined) {
    throw new HobbyError(
      'runtime_unavailable',
      'this runtime cannot run a command inside a container, so a schema diff is not possible'
    )
  }
  const exec = runtime.execStream(resource.config.containerName, pgDumpSchemaCommand(resource.config))
  const chunks: Buffer[] = []
  let size = 0
  const collected = new Promise<void>((resolve, reject) => {
    exec.stdout.on('data', (chunk: Buffer | string) => {
      const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
      size += buf.length
      if (size > MAX_DUMP_BYTES) {
        exec.cancel()
        reject(new HobbyError('conflict', `the schema of ${resource.name} is larger than ${MAX_DUMP_BYTES} bytes`, 'compare it with pg_dump by hand'))
        return
      }
      chunks.push(buf)
    })
    exec.stdout.once('end', () => resolve())
    exec.stdout.once('error', reject)
  })
  try {
    await Promise.all([collected, exec.done])
  } catch (err: unknown) {
    const detail = err instanceof HobbyError && err.hint !== undefined ? err.hint : err instanceof Error ? err.message : String(err)
    if (err instanceof HobbyError && err.code === 'conflict') {
      throw err
    }
    throw new HobbyError(
      'internal',
      `pg_dump of ${resource.name} failed`,
      `${detail}. if it was put to sleep during the dump, retry the diff`
    )
  }
  return Buffer.concat(chunks).toString('utf8')
}

function postgresOf(ctx: DaemonContext, project: Project): PostgresResource[] {
  return ctx.store.listResources(project.id).filter((resource): resource is PostgresResource => resource.kind === 'postgres')
}

function refuseUnmanaged(project: Project): void {
  if (project.releasedAt !== null) {
    throw new HobbyError(
      'conflict',
      `project ${project.name} was released and is no longer managed by hobby`,
      `run \`hobby adopt ${project.name}\` first, after stopping the stack it was released to`
    )
  }
}

// Resolves `newName` and the project it is compared against: `oldName`
// when given, otherwise the recorded parent.
function resolvePair(ctx: DaemonContext, newName: string, oldName: string | undefined): { oldProject: Project; newProject: Project } {
  const newProject = ctx.store.getProjectByName(newName)
  if (newProject === null) {
    throw new HobbyError('project_not_found', `no project named ${newName}`, 'run `hobby ls` to see what exists')
  }
  let oldProject: Project | null
  if (oldName !== undefined) {
    oldProject = ctx.store.getProjectByName(oldName)
    if (oldProject === null) {
      throw new HobbyError('project_not_found', `no project named ${oldName}`, 'run `hobby ls` to see what exists')
    }
  } else {
    if (newProject.parentId === null) {
      throw new HobbyError(
        'usage',
        `project ${newName} has no recorded parent to compare against`,
        `name the other project: hobby diff <project> ${newName}`
      )
    }
    oldProject = ctx.store.getProject(newProject.parentId)
    if (oldProject === null) {
      throw new HobbyError(
        'conflict',
        `the project ${newName} was branched from no longer exists`,
        `name another project to compare against: hobby diff <project> ${newName}`
      )
    }
  }
  if (oldProject.id === newProject.id) {
    throw new HobbyError('usage', 'a project compared with itself has no differences', 'name two different projects')
  }
  return { oldProject, newProject }
}

export async function diffSchemas(
  ctx: DaemonContext,
  newName: string,
  oldName: string | undefined,
  opts: SchemaDiffOptions = {}
): Promise<SchemaDiffResult> {
  const wake = opts.wake ?? getOrCreateWake(ctx)
  const { oldProject, newProject } = resolvePair(ctx, newName, oldName)
  refuseUnmanaged(oldProject)
  refuseUnmanaged(newProject)

  const oldResources = postgresOf(ctx, oldProject)
  const newResources = postgresOf(ctx, newProject)
  const names = [...new Set([...oldResources, ...newResources].map((resource) => resource.name))].sort()
  if (names.length === 0) {
    throw new HobbyError('usage', `neither ${oldProject.name} nor ${newProject.name} holds a postgres resource`, 'there is no schema to compare')
  }

  // Every pair that exists on both sides is woken before any dump, so a
  // wake that fails (a broken resource, a held project) refuses the diff
  // before any work is spent on the others.
  const woke: string[] = []
  const paired = names.flatMap((name) => {
    const left = oldResources.find((resource) => resource.name === name)
    const right = newResources.find((resource) => resource.name === name)
    return left !== undefined && right !== undefined ? [left, right] : []
  })
  for (const resource of paired) {
    const current = ctx.store.getResource(resource.id)
    if (current?.state !== 'running') {
      await wake(resource.id)
      const project = resource.projectId === oldProject.id ? oldProject : newProject
      woke.push(`${project.name}/${resource.name}`)
    }
  }

  const resources: ResourceSchemaDiff[] = []
  for (const name of names) {
    const left = oldResources.find((resource) => resource.name === name)
    const right = newResources.find((resource) => resource.name === name)
    if (left === undefined || right === undefined) {
      resources.push({ name, status: left === undefined ? 'only-new' : 'only-old', diff: '', hunks: [] })
      continue
    }
    const before = normalizeDump(await dumpSchema(ctx, left))
    const after = normalizeDump(await dumpSchema(ctx, right))
    const hunks = toHunks(diffLines(before, after))
    resources.push({
      name,
      status: hunks.length === 0 ? 'same' : 'changed',
      diff: renderUnified(`${oldProject.name}/${name}`, `${newProject.name}/${name}`, hunks),
      hunks,
    })
  }

  return {
    old: { project: oldProject.name },
    new: { project: newProject.name },
    resources,
    woke,
    identical: resources.every((resource) => resource.status === 'same'),
  }
}
