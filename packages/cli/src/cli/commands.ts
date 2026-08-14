// One function per verb. Every command takes the parsed positionals and
// flags for its own subcommand (main.ts owns dispatch and flag *parsing*;
// this file owns what each verb actually does) plus a Ctx carrying the
// pieces a command might need, and returns the process exit code directly,
// never process.exit. Errors are always thrown (HobbyError, UsageError, or
// a DaemonUnreachableError from client.ts) and handled in exactly one place,
// main.ts's handleError, so a command never has to decide its own exit code
// for a failure path.

import { spawn, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { chmod, mkdir } from 'node:fs/promises'
import { basename, join as joinPath, resolve as resolvePath } from 'node:path'
import {
  HobbyError,
  parseTarget,
  resolvePgdataPath,
  type HobbyConfig,
  type Paths,
  type Project,
} from '@hobby.sh/core'
import { createDaemonContext } from '../daemon/context.js'
import { runPreflight } from '../daemon/preflight.js'
import { reconcile } from '../daemon/reconcile.js'
import { acquireDaemonLock } from '../daemon/single-instance.js'
import { startDaemon } from '../daemon/server.js'
import { hasOperatorCredential, setOperatorPassword } from '../daemon/studio/auth.js'
import type { WireResource } from '../daemon/wire.js'
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

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

// Owner-only, on both ~/.hobby and ~/.hobby/projects. Everything under
// there is a secret or a database: state.db holds every resource's
// superuser password as plaintext JSON, studio-credential holds the
// operator hash, hobby.sock is the unauthenticated control plane, and
// projects/ holds the PGDATA directories themselves. Created without an
// explicit mode, these landed 0755 and every local user could read the lot.
// The socket and the credential file already reasoned this way; the
// directories holding them did not.
const HOME_DIR_MODE = 0o700

// mkdir's `mode` is masked by the process umask, and POSIX ignores it
// entirely for a directory that already exists, which is the case that
// matters most here: an install created by an earlier build already has a
// 0755 ~/.hobby, and only an explicit chmod fixes it. Both calls together
// make the mode true on a fresh install and on an upgrade alike.
async function ensurePrivateDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: HOME_DIR_MODE })
  await chmod(path, HOME_DIR_MODE)
}

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
export async function resolveTarget(api: Api, target: string): Promise<{ project: Project; resource: WireResource }> {
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
    return { project: detail.project, resource: detail.resources[0] as WireResource }
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
  await ensurePrivateDir(paths.home)
  await ensurePrivateDir(paths.projectsDir)

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
  await ensurePrivateDir(paths.home)
  await ensurePrivateDir(paths.projectsDir)

  // Before reconcile, not after. Reconcile inspects and starts containers, so
  // a second daemon that gets that far has already touched the first one's
  // resources before finding out it should not exist.
  const lock = acquireDaemonLock(paths.home)

  const ctx = createDaemonContext({ paths, config })
  try {
    await reconcile(ctx)
    await startDaemon(ctx, { socketPath: paths.socketPath, apiPort: config.apiPort, onShutdown: () => lock.release() })
  } catch (err) {
    lock.release()
    throw err
  }
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
// `hobby deploy [path]`: the one verb for putting code on the box.
//
// The kind is detected from what is in the directory rather than asked for,
// because the user already told us by what they wrote: a wrangler manifest
// means a Worker, a Dockerfile means a container. Both present is an error
// that asks which, rather than a guess, since guessing wrong means building
// the wrong thing and only finding out when it does not serve.
//
// Deliberately not a `git push` flow. That needs a receiving repository, a
// hook, and a build triggered by someone else's commit, none of which is one
// box's worth of complexity, and `hobby deploy` from the directory you are
// already standing in is the same number of keystrokes.
export type DeployKind = 'app' | 'worker'

// Only an app or a worker has a hostname; a postgres resource is reached on
// 5432 through the proxy and has none. Narrowed here rather than at each
// print site.
function hostnameOf(resource: WireResource): string {
  return resource.kind === 'app' || resource.kind === 'worker' ? resource.config.hostname : ''
}

// `AppConfig.image`/`WorkerConfig.image` are `string | null`
// (packages/core/src/types.ts's `ResourceConfigBase.image`, widened once
// `undeployed` became a real state nothing has built yet). A template
// literal stringifies `null` silently, with no compile error, which is
// exactly what cmdDeploy's create-new branch below used to do at this
// file's old line 308. Provably unreachable through cmdDeploy alone today
// (its create-new branch always supplies a real `source`, so
// createAppResource/createWorkerResource either build a real image or
// throw before this print is ever reached), but a defensive fix rather than
// a documented invariant is the right shape for output code: it costs
// nothing to be correct for a null it does not currently receive, and a
// future caller of this same branch is not a hypothetical, it is exactly
// the shape of mistake Task 8 already found two more instances of, in
// renderCompose's app and worker loops (packages/cli/src/daemon/routes.ts,
// both now guarded by `isDeployed`). The postgres loop in that same
// function was never at risk: `PostgresConfig.image` is narrowed to
// non-nullable `string` (types.ts:80), so comparing it to `null` does not
// even compile. Task 8 also found a Caddyfile bug in the same review, but a
// differently shaped one, not a fourth instance of this one: its caller was
// passing every app and worker resource, deployed or not, into
// `renderCaddyfile`, whose `hostname`/`hostPort` parameters are never null,
// so nothing there was a null reaching a template literal.
function imageLine(image: string | null): string {
  return image === null ? '(not built yet)' : image
}

export function detectDeployKind(files: { dockerfile: boolean; wrangler: boolean }): DeployKind {
  if (files.dockerfile && files.wrangler) {
    throw new UsageError(
      'this directory has both a Dockerfile and a wrangler manifest, so it is ambiguous. Pass --kind app or --kind worker.'
    )
  }
  if (files.wrangler) {
    return 'worker'
  }
  if (files.dockerfile) {
    return 'app'
  }
  throw new UsageError(
    'nothing to deploy here: expected a Dockerfile (for an app) or wrangler.toml / wrangler.jsonc (for a worker)'
  )
}

export interface DeployTarget {
  path: string
  project?: string
  name?: string
}

// `hobby deploy [path] --project <p> [--name n]`: ONE positional, the path,
// defaulting to the current directory. A second optional positional for the
// resource name cannot be disambiguated from the first (`hobby deploy site`
// could mean "deploy the directory named site" or "deploy here, calling it
// site", and nothing in the surrounding argv picks correctly either way),
// so the name is a flag with a derived default instead: `hobby deploy
// ./site` targets a resource called `site`, the same ergonomic Fly and
// Wrangler both use. `--name` overrides it explicitly.
//
// Exported and pure (positionals/flags in, a plain object out, no Ctx, no
// filesystem, no daemon) so this derivation, the one genuinely tricky part
// of `hobby deploy`'s argument shape, is directly testable; see
// packages/cli/test/parse.test.ts. When `path` is the default `.`, there is
// nothing to take a basename of without knowing the caller's own working
// directory, which this function deliberately never reads (that would make
// it depend on whatever directory happened to invoke the test, not just its
// arguments), so `name` comes back `undefined` and cmdDeploy below resolves
// that one case from `c.io.cwd`, the same testable cwd every other command
// in this file already goes through.
export function parseDeploy(positionals: string[], flags: Flags): DeployTarget {
  const path = positionals[0] ?? '.'
  const explicit = typeof flags['name'] === 'string' ? flags['name'] : undefined
  return {
    path,
    project: typeof flags['project'] === 'string' ? flags['project'] : undefined,
    name: explicit ?? (path === '.' ? undefined : basename(resolvePath(path))),
  }
}

function deployKindConflict(project: string, name: string, existingKind: string): UsageError {
  return new UsageError(
    `${project}/${name} is a ${existingKind}, and a deploy would replace it. Pick another name with --name, or remove it first.`
  )
}

export async function cmdDeploy(c: Ctx, positionals: string[], flags: Flags): Promise<number> {
  const parsed = parseDeploy(positionals, flags)
  const path = resolvePath(c.io.cwd, parsed.path)
  const projectName = parsed.project ?? basename(path)
  const name = parsed.name ?? basename(path)

  const portFlag = typeof flags['port'] === 'string' ? Number(flags['port']) : undefined
  if (portFlag !== undefined && !Number.isInteger(portFlag)) {
    throw new UsageError(`--port must be a whole number, got ${String(flags['port'])}`)
  }

  // A read, never a write: whether the project exists yet, and whether it
  // already holds a resource by this name, has to be known before anything
  // below decides whether to mutate anything. Actually creating a missing
  // project is deferred past every validation that can still fail (an
  // unrecognized --kind, a directory with neither a Dockerfile nor a
  // wrangler manifest), the same property the pre-existing code already
  // had: a failed `hobby deploy` must never leave an empty project behind
  // for the same reason cmdNew rolls one back on a failed first resource.
  let projectExists = true
  let existing: WireResource | undefined
  try {
    const detail = await c.api.getProject(projectName)
    existing = detail.resources.find((r) => r.name === name)
  } catch (err) {
    if (!(err instanceof HobbyError) || err.code !== 'project_not_found') {
      throw err
    }
    projectExists = false
  }

  // Checked before kind detection ever touches the filesystem: whatever is
  // in the directory, `hobby deploy` can only ever produce an app or a
  // worker, so a name already held by anything else (a postgres, today the
  // only other kind) is decidable without looking. This is what lets a
  // deploy onto a name held by a different kind refuse rather than silently
  // replacing it, per this task's own rule.
  if (existing !== undefined && existing.kind !== 'app' && existing.kind !== 'worker') {
    throw deployKindConflict(projectName, name, existing.kind)
  }

  const kindFlag = typeof flags['kind'] === 'string' ? flags['kind'] : undefined
  if (kindFlag !== undefined && kindFlag !== 'app' && kindFlag !== 'worker') {
    throw new UsageError(`unknown --kind: ${kindFlag}. Expected app or worker.`)
  }
  const kind =
    kindFlag ??
    detectDeployKind({
      dockerfile: existsSync(joinPath(path, 'Dockerfile')),
      wrangler: existsSync(joinPath(path, 'wrangler.toml')) || existsSync(joinPath(path, 'wrangler.jsonc')),
    })

  // The rarer half of the same rule, now that the deploy's own kind is
  // known: an app redeployed as though it were a worker, or the reverse,
  // from a name it does not own.
  if (existing !== undefined && existing.kind !== kind) {
    throw deployKindConflict(projectName, name, existing.kind)
  }

  // A project is created on first deploy rather than required up front. The
  // alternative, making the user run `hobby new` first, means two commands
  // for the thing CLAUDE.md promises takes one.
  if (!projectExists) {
    await c.api.createProject(projectName)
  }

  if (existing !== undefined) {
    const result = await c.api.deployResource(existing.id, { source: { path } })
    if (flags.json) {
      c.io.out(JSON.stringify({ resource: result.resource, image: result.image }, null, 2))
      return 0
    }
    c.io.out(`deployed ${projectName}/${name}`)
    c.io.out(`  image     ${result.image}`)
    c.io.out(`  url       https://${hostnameOf(result.resource)}`)
    c.io.out('')
    c.io.out('It is asleep. The first request wakes it.')
    return 0
  }

  const { resource } = await c.api.createResource(
    projectName,
    kind === 'worker'
      ? { kind: 'worker', name, source: { path } }
      : {
          kind: 'app',
          name,
          source: { path },
          ...(portFlag === undefined ? {} : { port: portFlag }),
        }
  )

  if (flags.json) {
    c.io.out(JSON.stringify({ resource }, null, 2))
    return 0
  }
  c.io.out(`deployed ${projectName}/${name}`)
  c.io.out(`  image     ${imageLine(resource.config.image)}`)
  c.io.out(`  url       https://${hostnameOf(resource)}`)
  c.io.out('')
  c.io.out('It is asleep. The first request wakes it.')
  return 0
}

export async function cmdNew(c: Ctx, positionals: string[], flags: Flags): Promise<number> {
  const name = positionals[0]
  if (name === undefined) {
    throw new UsageError('usage: hobby new <name> [--empty]')
  }

  const { project } = await c.api.createProject(name)

  // `--empty`: a project and nothing else. A project is a namespace holding
  // typed resources (root CLAUDE.md's Scope section), not a database with a
  // name, and this is the door to that: no postgres is created, so there is
  // nothing to roll back if this branch fails, because nothing past
  // createProject was attempted. `hobby new <name>` without the flag stays
  // exactly what it always was, below: the one-command ergonomic root
  // CLAUDE.md sells, and there is no reason to spend it.
  if (flags.empty === true) {
    if (flags.json) {
      c.io.out(JSON.stringify({ project }))
      return 0
    }
    c.io.out(`project ${project.name}`)
    c.io.out('no resources yet. add one with:')
    c.io.out(`  hobby create postgres primary --project ${project.name}`)
    c.io.out(`  hobby deploy ./path --project ${project.name}`)
    return 0
  }

  // Three calls, one promise. `hobby new blog` is the command CLAUDE.md's
  // "one command gives you a project with a Postgres in it" refers to, so a
  // half-finished result is not a partial success, it is a failure that has
  // to clean up after itself.
  //
  // Without this, a resource that failed to boot (an image still pulling past
  // the readiness timeout, a port that could not bind) left the project
  // behind, and the obvious next thing to type, the same command again, got
  // 409 name_taken. The user's way out was to work out that `hobby rm` was
  // needed on a project they never successfully created.
  //
  // Only ever rolls back a project this call created: createProject would
  // have failed with name_taken if it already existed, so there is no path
  // here that deletes someone's existing work. The resource never reached
  // ready, so what this removes is at most an empty cluster initdb made
  // moments ago.
  let resource
  try {
    ;({ resource } = await c.api.createResource(project.name, { kind: 'postgres', name: 'primary' }))
  } catch (err) {
    try {
      await c.api.deleteProject(project.name)
    } catch (cleanupErr) {
      // The original failure is the one worth reporting, so the cleanup
      // failure is reported alongside it rather than replacing it: the user
      // now has a project that neither works nor was removed, and needs to
      // know it is there.
      c.io.err(
        `could not roll back the half-created project ${project.name}: ${errorMessage(cleanupErr)}. ` +
          `remove it with: hobby rm ${project.name}`
      )
    }
    throw err
  }
  const { connectionString, tailnetConnectionString } = await c.api.getConnection(resource.id)

  if (flags.json) {
    // Not one raw API response (no single route did all of this), but a
    // composite object whose every field is exactly what its own call
    // returned. Human output below reads only connectionString off this
    // same object, never a second source.
    c.io.out(JSON.stringify({ project, resource, connectionString, tailnetConnectionString: tailnetConnectionString ?? null }))
    return 0
  }

  c.io.out(connectionString)
  // Labelled second line, never a bare second string: the first line stays
  // exactly what it always was so `hobby new blog | pbcopy` keeps grabbing
  // one usable URI.
  if (tailnetConnectionString != null) c.io.out(`tailnet: ${tailnetConnectionString}`)
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
    // A released project is still listed, because it is still here. Saying so
    // on the project line is the difference between "hobby forgot this" and
    // "hobby is deliberately not touching this", and only one of those is
    // true.
    // `!= null`, not `=== null`. This runs against whatever daemon is on the
    // socket, and a daemon built before releasedAt existed sends a project
    // with no such field at all: strict inequality against null read that
    // `undefined` as released and labelled every project on the box as handed
    // over. Loose null here is the one place it is the correct operator.
    c.io.out(project.releasedAt != null ? `${project.name}  (released, not managed)` : project.name)
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

export type CreatableKind = 'postgres' | 'app' | 'worker'

// One call to the one route (`POST /v1/projects/:name/resources`, body
// `{ kind, name }`, nothing else) and the same rendering either caller
// below would otherwise have had to repeat. Shared, not duplicated, because
// `hobby create <kind> <name>` and `hobby pg create <name>` reaching the
// same code with the same body is what keeps the CLI and MCP from silently
// diverging on this route, per root CLAUDE.md's "the daemon API is the only
// control surface" seam.
async function createResourceAndReport(
  c: Ctx,
  project: string,
  kind: CreatableKind,
  name: string,
  json: boolean
): Promise<number> {
  const { resource } = await c.api.createResource(project, { kind, name })
  if (json) {
    c.io.out(JSON.stringify({ resource }))
  } else {
    c.io.out(renderResourceLine(resource))
  }
  return 0
}

// `hobby create <postgres|app|worker> <name> --project <p>`: the general
// form for a resource with no code yet. Deliberately no `--port`: an app's
// port describes its code (what $PORT the process inside actually listens
// on), which does not exist until a deploy supplies it, so asking for one
// here would be asking the user to answer a question about a Dockerfile
// that has not been written.
export async function cmdCreate(c: Ctx, positionals: string[], flags: Flags): Promise<number> {
  const [kind, name] = positionals
  if (kind !== 'postgres' && kind !== 'app' && kind !== 'worker') {
    throw new UsageError('usage: hobby create <postgres|app|worker> <name> --project <project>')
  }
  if (typeof name !== 'string' || name.length === 0) {
    throw new UsageError('usage: hobby create <kind> <name> --project <project>')
  }
  const project = flagString(flags, 'project')
  if (project === undefined) {
    throw new UsageError('usage: hobby create <kind> <name> --project <project>')
  }
  return createResourceAndReport(c, project, kind, name, flags.json === true)
}

// `hobby pg create --project <p> <name>`: kept as the explicit form for
// anyone who prefers spelling out the kind, an alias for cmdCreate above
// rather than a second implementation of the same route.
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
  return createResourceAndReport(c, project, 'postgres', name, flags.json === true)
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
  const { connectionString, tailnetConnectionString } = await c.api.getConnection(resource.id)

  if (flags.json) {
    c.io.out(JSON.stringify({ connectionString, tailnetConnectionString: tailnetConnectionString ?? null }))
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
  const release = flags.release === true
  const result = await c.api.eject(project, { release })

  if (flags.json) {
    c.io.out(JSON.stringify(result))
    return 0
  }

  c.io.out(result.compose)
  c.io.err('data directories:')
  for (const dir of result.dataDirs) {
    c.io.err(`  ${dir}`)
  }
  // Each directory above is the postgres home directory the compose file
  // mounts, not PGDATA itself: postgres 18's image places the real data
  // directory in a subdirectory named after the major version (see
  // docs/decisions/0003's 2026-08-07 amendment). A stock `postgres` binary,
  // or pg_dump/pg_ctl run by hand outside Hobbyist, must point at that
  // subdirectory, not the directory listed above.
  c.io.err('a stock postgres binary or pg_ctl points at the subdirectory beneath each one, for example:')
  for (const dir of result.dataDirs) {
    c.io.err(`  ${resolvePgdataPath(dir)}`)
  }
  if (release) {
    c.io.err(
      `hobby has stopped acting on ${project} and deleted nothing. its databases are stopped, its records ` +
        'are still here, and the data directories above are untouched: the compose file on stdout starts ' +
        `the same data. run \`hobby adopt ${project}\` to take it back, after stopping that stack.`
    )
  } else {
    c.io.err(
      'this is a snapshot of current state; hobby is still managing this project. pass --release to hand ' +
        'it over: databases stopped and hobby out of the way, with every record and every byte kept.'
    )
  }
  return 0
}

// The other half of --release, and the reason --release is safe to type out of
// curiosity: nothing was deleted, so taking a project back is a state change
// rather than a restore.
export async function cmdAdopt(c: Ctx, positionals: string[], flags: Flags): Promise<number> {
  const project = positionals[0]
  if (project === undefined) {
    throw new UsageError('usage: hobby adopt <project>')
  }

  const result = await c.api.adopt(project)

  if (flags.json) {
    c.io.out(JSON.stringify(result))
    return 0
  }

  c.io.out(`hobby is managing ${project} again`)
  c.io.err(
    'its databases are still stopped. anything that connects will wake one, or run `hobby wake ' +
      `${project}\` now.`
  )
  return 0
}

// `hobby studio passwd`: the only way the operator credential (ADR 0008,
// packages/cli/src/daemon/studio/auth.ts) is ever set or changed. Deliberate
// design, not a shortcut:
//
// - Never a daemon route, and never called through c.api: existing shell
//   access on the box is the whole root of trust (ADR 0008 again), so this
//   calls setOperatorPassword directly against paths.home, the same local
//   state cmdInit and cmdDaemon already touch. It works with the daemon
//   stopped, running, or never started at all, because nothing here opens
//   the unix socket.
// - Never a command-line argument: only io.readLine() ever supplies the
//   password, twice, and neither prompt is echoed to the terminal (see
//   ReadLineOptions.silent in main.ts). A password living in argv is
//   readable by every other user on the box via `ps`, exactly the leak
//   cmdConnect's own comment describes closing for the connection string;
//   this command has no flag or positional that could carry one in the
//   first place, so there is no argv path to close, only one to never open.
export async function cmdStudioPasswd(io: Io, paths: Paths): Promise<number> {
  await ensurePrivateDir(paths.home)

  io.out('set the studio operator password. it is stored only on this box, in')
  io.out(`${paths.home}, and is never sent anywhere else.`)
  io.out('password:')
  const first = await io.readLine({ silent: true })
  io.out('confirm password:')
  const second = await io.readLine({ silent: true })

  if (first !== second) {
    io.err('passwords did not match, nothing was changed')
    return 1
  }

  // setOperatorPassword itself throws HobbyError('usage', ...) for an empty
  // password, which main.ts's handleError renders the same way any other
  // usage error is rendered; there is no separate empty-password check to
  // keep in sync with that one.
  await setOperatorPassword(paths, first)
  io.out('studio operator password set.')
  return 0
}

export type BrowserOpener = (url: string) => void

function browserOpenCommand(platform: NodeJS.Platform): { cmd: string; args: string[] } | null {
  if (platform === 'darwin') return { cmd: 'open', args: [] }
  if (platform === 'linux') return { cmd: 'xdg-open', args: [] }
  if (platform === 'win32') return { cmd: 'cmd', args: ['/c', 'start', ''] }
  // Every other platform (a headless VPS with no desktop at all, which is
  // squarely this project's audience per the root CLAUDE.md) has nothing
  // sensible to exec; cmdStudio below still prints the URL either way.
  return null
}

// Best-effort and asynchronous on purpose: `open`/`xdg-open` launch the
// browser and return immediately, but spawnSync would still block `hobby
// studio` until that child process itself exits, which on some platforms is
// only when the browser itself closes. detached + unref lets the CLI exit
// right after printing the URL regardless of what the browser process does.
// A missing launcher (no desktop environment, a bare VPS) is not an error:
// the URL was already printed, which is the fallback the brief asks for.
function defaultOpenBrowser(url: string): void {
  const command = browserOpenCommand(process.platform)
  if (command === null) {
    return
  }
  try {
    const child = spawn(command.cmd, [...command.args, url], { stdio: 'ignore', detached: true })
    child.on('error', () => {
      // No GUI to open a browser in, or the launcher is not on PATH: the URL
      // is already on stdout, so this is not fatal.
    })
    child.unref()
  } catch {
    // Same reasoning: spawn itself throwing is still not fatal here.
  }
}

// `hobby studio`: prints the URL to open and opens it when it can. Points
// straight at the daemon's own loopback listener (config.apiPort), not at a
// Caddy front door: Caddy is out of scope for this task (see the task
// report), and the daemon serves both the API and Studio's built bundle on
// that same port now (packages/cli/src/daemon/studio/routes.ts's
// createStudioApp). If Caddy is fronting this with TLS later, that changes
// the URL and is Caddy's task to update, not this one's.
export function cmdStudio(io: Io, paths: Paths, config: HobbyConfig, openBrowser: BrowserOpener = defaultOpenBrowser): number {
  const url = `http://127.0.0.1:${config.apiPort}`

  if (!hasOperatorCredential(paths)) {
    // Deliberately not the login page: a login attempt against a fresh
    // install can never succeed (routes.ts's loginHandler always throws
    // unauthorized when no credential is set, by design, so a failed login
    // never reveals whether one exists), so opening it here would just be a
    // confusing dead end. Naming the fix directly is what the brief asks
    // for instead of a page nobody can get past.
    io.err('no studio password has been set yet, so signing in could never succeed.')
    io.err('hint: run `hobby studio passwd`, then `hobby studio` again.')
    return 1
  }

  io.out(url)
  openBrowser(url)
  return 0
}
