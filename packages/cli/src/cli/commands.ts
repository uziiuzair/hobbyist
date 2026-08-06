// One function per verb. Every command takes the parsed positionals and
// flags for its own subcommand (main.ts owns dispatch and flag *parsing*;
// this file owns what each verb actually does) plus a Ctx carrying the
// pieces a command might need, and returns the process exit code directly,
// never process.exit. Errors are always thrown (HobbyError, UsageError, or
// a DaemonUnreachableError from client.ts) and handled in exactly one place,
// main.ts's handleError, so a command never has to decide its own exit code
// for a failure path.

import { spawnSync } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import { HobbyError, parseTarget, type HobbyConfig, type Paths, type Project, type Resource } from '@hobby.sh/core'
import { createDaemonContext } from '../daemon/context.js'
import { runPreflight } from '../daemon/preflight.js'
import { reconcile } from '../daemon/reconcile.js'
import { startDaemon } from '../daemon/server.js'
import type { Api } from './client.js'
import { exitCodeForError } from './exit.js'
import { reflinkWarning, renderPreflight, renderResourceLine } from './output.js'

// Io is defined in main.ts, which owns run() and is the file the brief
// names for the exported signature `run(argv, io)`; imported here as a
// type only, so this does not create a runtime circular dependency between
// the two files (main.ts imports these command functions at runtime).
import type { Io } from './main.js'

export type Flags = Record<string, string | boolean>

export interface Ctx {
  io: Io
  api: Api
  paths: Paths
  config: HobbyConfig
}

export class UsageError extends Error {}

function flagString(flags: Flags, name: string): string | undefined {
  const value = flags[name]
  return typeof value === 'string' ? value : undefined
}

// Resolves a CLI target (`project` or `project/resource`) to exactly one
// resource. Ambiguity, per the spec, is an error listing the candidates,
// never a guess: a bare project name with more than one resource throws
// `ambiguous_target`, the same ErrorCode the daemon uses for this exact
// situation, so it maps through exit.ts identically regardless of which
// side of the socket noticed it.
export async function resolveTarget(api: Api, target: string): Promise<{ project: Project; resource: Resource }> {
  const { project: projectName, resource: resourceName } = parseTarget(target)
  const detail = await api.getProject(projectName)

  if (resourceName !== null) {
    const resource = detail.resources.find((r) => r.name === resourceName)
    if (resource === undefined) {
      throw new HobbyError(
        'resource_not_found',
        `no resource named ${resourceName} in project ${projectName}`,
        detail.resources.length === 0
          ? `project ${projectName} has no resources`
          : `known resources: ${detail.resources.map((r) => r.name).join(', ')}`
      )
    }
    return { project: detail.project, resource }
  }

  if (detail.resources.length === 0) {
    throw new HobbyError('resource_not_found', `project ${projectName} has no resources`)
  }
  if (detail.resources.length === 1) {
    return { project: detail.project, resource: detail.resources[0] as Resource }
  }
  throw new HobbyError(
    'ambiguous_target',
    `project ${projectName} has more than one resource: ${detail.resources.map((r) => r.name).join(', ')}`,
    `specify project/resource, for example ${projectName}/${detail.resources[0]?.name}`
  )
}

// `hobby init` never talks to the daemon over the socket: there is nothing
// listening on it yet, since starting that listener is the very thing init
// is preparing the host for. It builds its own short-lived DaemonContext
// (the same factory the real daemon uses, see daemon/context.ts) and calls
// runPreflight in-process, which is the same function GET /v1/preflight
// calls once the daemon exists. This deliberately does not start the daemon
// as a background process: `hobby daemon` (below) is the long-running verb,
// and how it gets supervised (systemd, launchd, or run by hand) is called
// out as an open question in docs/cli/CLAUDE.md, not something this task
// resolves.
export async function cmdInit(io: Io, paths: Paths, config: HobbyConfig, json: boolean): Promise<number> {
  await mkdir(paths.home, { recursive: true })
  await mkdir(paths.projectsDir, { recursive: true })

  const ctx = createDaemonContext({ paths, config })
  let report
  try {
    report = await runPreflight(ctx)
  } finally {
    ctx.store.close()
  }

  if (json) {
    io.out(JSON.stringify(report))
  } else {
    for (const line of renderPreflight(report)) {
      io.out(line)
    }
  }

  // Always to stderr, in both --json and human mode: advisory text must
  // never land on the same stream as the JSON body or corrupt the output of
  // anyone piping/parsing `hobby init`'s stdout.
  const warning = reflinkWarning(report)
  if (warning !== null) {
    io.err(warning)
  }

  if (!report.runtimeAvailable) {
    io.err('the container runtime is not reachable; hobby refuses to continue until it is')
    return exitCodeForError('runtime_unavailable')
  }

  if (!json) {
    io.out('host is ready. run `hobby daemon` to start the daemon.')
  }
  return 0
}

// The long-running verb. Builds a real DaemonContext, reconciles state
// against the runtime (per task-4-report.md, this is the caller's job, not
// startDaemon's), then binds both listeners and blocks. Under normal
// operation this promise never settles: startDaemon's own SIGTERM/SIGINT
// handlers (packages/cli/src/daemon/server.ts) call process.exit directly
// once shutdown finishes, which is a pre-existing property of that code,
// not something introduced here. It only returns if startDaemon itself
// throws before ever binding (a live daemon already on the socket, a port
// already bound), in which case that throw propagates normally.
export async function cmdDaemon(io: Io, paths: Paths, config: HobbyConfig): Promise<number> {
  await mkdir(paths.home, { recursive: true })
  await mkdir(paths.projectsDir, { recursive: true })

  const ctx = createDaemonContext({ paths, config })
  await reconcile(ctx)
  await startDaemon(ctx, { socketPath: paths.socketPath, apiPort: config.apiPort })
  io.out(`hobby daemon listening on ${paths.socketPath}`)
  await new Promise<void>(() => {
    // Deliberately never resolves; see the file comment above.
  })
  return 0
}

// The product's central promise: one command, one Postgres. Three calls
// (create the project, create its `postgres` resource named `primary`,
// fetch the connection string), because there is no single route that does
// all three; createResource's own createPostgres already blocks until
// Postgres is ready before returning (packages/pg/src/postgres.ts), which is
// what satisfies "waits for readiness" here without an extra start call.
export async function cmdNew(c: Ctx, positionals: string[], flags: Flags): Promise<number> {
  const name = positionals[0]
  if (name === undefined) {
    throw new UsageError('usage: hobby new <name>')
  }

  const { project } = await c.api.createProject(name)
  const { resource } = await c.api.createResource(project.name, { kind: 'postgres', name: 'primary' })
  const { connectionString } = await c.api.getConnection(resource.id)

  if (flags.json) {
    // Not one raw API response (no single route did all of this), but a
    // composite object whose every field is exactly what its own call
    // returned. Human output below reads only connectionString off this
    // same object, never a second source.
    c.io.out(JSON.stringify({ project, resource, connectionString }))
    return 0
  }

  c.io.out(connectionString)
  return 0
}

export async function cmdLs(c: Ctx, flags: Flags): Promise<number> {
  const { projects } = await c.api.listProjects()
  // GET /v1/projects alone has no resource state; "everything, with sleep
  // state" (docs/cli/CLAUDE.md) means fetching each project's detail too.
  // No single route already returns this, so --json prints this aggregated
  // array rather than one raw response body; see client.ts's ProjectsResponse
  // vs ProjectDetailResponse for why the split exists on the daemon side.
  const details = await Promise.all(projects.map((project) => c.api.getProject(project.name)))

  if (flags.json) {
    c.io.out(JSON.stringify(details))
    return 0
  }

  if (details.length === 0) {
    c.io.out('no projects yet. run `hobby new <name>` to create one.')
    return 0
  }

  for (const { project, resources } of details) {
    c.io.out(project.name)
    if (resources.length === 0) {
      c.io.out('  (no resources)')
      continue
    }
    for (const resource of resources) {
      c.io.out(`  ${renderResourceLine(resource)}`)
    }
  }
  return 0
}

export async function cmdPg(c: Ctx, positionals: string[], flags: Flags): Promise<number> {
  const sub = positionals[0]
  if (sub !== 'create') {
    throw new UsageError(`usage: hobby pg create --project <project> <name>${sub === undefined ? '' : ` (got: ${sub})`}`)
  }
  const name = positionals[1]
  const project = flagString(flags, 'project')
  if (project === undefined || name === undefined) {
    throw new UsageError('usage: hobby pg create --project <project> <name>')
  }

  const { resource } = await c.api.createResource(project, { kind: 'postgres', name })
  if (flags.json) {
    c.io.out(JSON.stringify({ resource }))
  } else {
    c.io.out(renderResourceLine(resource))
  }
  return 0
}

// Turns a postgres:// connection string into the libpq PG* environment
// variables psql itself already understands, undoing the encodeURIComponent
// that connectionString() in packages/pg/src/connstring.ts applied to the
// user and password segments when it built the string.
export function connectionEnv(connectionString: string): Record<string, string> {
  const url = new URL(connectionString)
  return {
    PGHOST: decodeURIComponent(url.hostname),
    PGPORT: url.port,
    PGUSER: decodeURIComponent(url.username),
    PGPASSWORD: decodeURIComponent(url.password),
    PGDATABASE: decodeURIComponent(url.pathname.replace(/^\//, '')),
  }
}

// `--json` here prints just the connection string, not the psql session:
// piping `hobby connect` output somewhere only makes sense before psql ever
// starts. Without --json, this execs psql; if psql is not on PATH, the
// connection string is still printed (so the human can paste it into
// whatever client they do have) and a clear line explains why nothing else
// happened, per the brief's explicit instruction not to fail silently
// there.
//
// The connection string is deliberately never passed as a psql argv
// element (e.g. `spawnSync('psql', [connectionString], ...)`), even though
// that looks like the obvious, simplest way to write this. A child
// process's full argv is readable by every other user on the box via
// `ps aux`, `ps -ef`, and /proc/<pid>/cmdline on Linux, so a URI in argv
// would hand the generated superuser password to anyone else logged into
// the same host on every ordinary `hobby connect`, not just some error
// path. Passing PGHOST/PGPORT/PGUSER/PGDATABASE/PGPASSWORD through the
// child's environment instead keeps the password out of anything
// process-listing tools can see. The rest of the environment (io.env) is
// inherited so the user's own psql settings (PAGER, PSQLRC, PGSSLMODE, and
// so on) still apply; only the five PG* connection variables are forced.
export async function cmdConnect(c: Ctx, positionals: string[], flags: Flags): Promise<number> {
  const target = positionals[0]
  if (target === undefined) {
    throw new UsageError('usage: hobby connect <target>')
  }
  const { resource } = await resolveTarget(c.api, target)
  const { connectionString } = await c.api.getConnection(resource.id)

  if (flags.json) {
    c.io.out(JSON.stringify({ connectionString }))
    return 0
  }

  const result = spawnSync('psql', [], {
    stdio: 'inherit',
    env: { ...c.io.env, ...connectionEnv(connectionString) },
  })
  if (result.error) {
    const err = result.error as NodeJS.ErrnoException
    if (err.code === 'ENOENT') {
      c.io.out(connectionString)
      c.io.err('psql was not found on PATH')
      return 1
    }
    throw err
  }
  return result.status ?? 1
}

async function cmdSleepWake(c: Ctx, verb: 'sleep' | 'wake', positionals: string[], flags: Flags): Promise<number> {
  const target = positionals[0]
  if (target === undefined) {
    throw new UsageError(`usage: hobby ${verb} <target>`)
  }
  const { resource } = await resolveTarget(c.api, target)
  // The API says start/stop because those are mechanical container
  // operations; the CLI says wake/sleep because that is the domain, per the
  // brief. This is the one place that translation happens.
  const result = verb === 'sleep' ? await c.api.stopResource(resource.id) : await c.api.startResource(resource.id)

  if (flags.json) {
    c.io.out(JSON.stringify(result))
  } else {
    c.io.out(renderResourceLine(result.resource))
  }
  return 0
}

export function cmdSleep(c: Ctx, positionals: string[], flags: Flags): Promise<number> {
  return cmdSleepWake(c, 'sleep', positionals, flags)
}

export function cmdWake(c: Ctx, positionals: string[], flags: Flags): Promise<number> {
  return cmdSleepWake(c, 'wake', positionals, flags)
}

export async function cmdLogs(c: Ctx, positionals: string[], flags: Flags): Promise<number> {
  const target = positionals[0]
  if (target === undefined) {
    throw new UsageError('usage: hobby logs <target> [--tail N]')
  }
  const { resource } = await resolveTarget(c.api, target)

  const tailRaw = flagString(flags, 'tail')
  let tail: number | undefined
  if (tailRaw !== undefined) {
    tail = Number(tailRaw)
    if (!Number.isFinite(tail) || tail <= 0) {
      throw new UsageError('--tail must be a positive number')
    }
  }

  const result = await c.api.getLogs(resource.id, tail)
  if (flags.json) {
    c.io.out(JSON.stringify(result))
  } else {
    c.io.out(result.logs)
  }
  return 0
}

// A bare project name deletes the whole project (DELETE /v1/projects/:name,
// which tears down every resource in it, best-effort, per routes.ts).
// `project/resource` deletes only that resource. This is a different split
// from resolveTarget's "ambiguous unless exactly one resource" rule used by
// sleep/wake/logs/connect: those verbs always need one specific resource to
// act on, but `rm blog` naming just the project is not ambiguous, it is a
// request to remove the project itself, resources and all.
export async function cmdRm(c: Ctx, positionals: string[], flags: Flags): Promise<number> {
  const target = positionals[0]
  if (target === undefined) {
    throw new UsageError('usage: hobby rm <target> [--yes]')
  }

  if (!flags.yes) {
    c.io.out(`type "${target}" to confirm deleting it, this cannot be undone:`)
    const typed = await c.io.readLine()
    if (typed.trim() !== target) {
      c.io.err('confirmation did not match, aborted')
      return 1
    }
  }

  const { project: projectName, resource: resourceName } = parseTarget(target)
  const result =
    resourceName === null
      ? await c.api.deleteProject(projectName)
      : await (async () => {
          const { resource } = await resolveTarget(c.api, target)
          return c.api.deleteResource(resource.id)
        })()

  if (flags.json) {
    c.io.out(JSON.stringify(result))
  } else {
    c.io.out(`deleted ${target}`)
  }
  return 0
}

// POST /v1/projects/:name/eject is a pure, non-destructive read (see
// task-4-report.md): it renders a compose file from real state but writes
// nothing and does not stop managing the project. This command mirrors that
// honestly: the compose YAML is the only thing on stdout in human mode, so
// `hobby eject blog > docker-compose.yml` works, and the data-directory
// listing plus a note that hobby is still managing this project go to
// stderr instead of polluting that redirect.
export async function cmdEject(c: Ctx, positionals: string[], flags: Flags): Promise<number> {
  const project = positionals[0]
  if (project === undefined) {
    throw new UsageError('usage: hobby eject <project>')
  }
  const result = await c.api.eject(project)

  if (flags.json) {
    c.io.out(JSON.stringify(result))
    return 0
  }

  c.io.out(result.compose)
  c.io.err('data directories:')
  for (const dir of result.dataDirs) {
    c.io.err(`  ${dir}`)
  }
  c.io.err(
    'this is a snapshot of current state; hobby is still managing this project. moving the data out and ' +
      'stopping management here is not yet automated, see docs/portability.'
  )
  return 0
}
