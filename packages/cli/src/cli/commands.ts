// One function per verb. Every command takes the parsed positionals and
// flags for its own subcommand (main.ts owns dispatch and flag *parsing*;
// this file owns what each verb actually does) plus a Ctx carrying the
// pieces a command might need, and returns the process exit code directly,
// never process.exit. Errors are always thrown (HobbyError, UsageError, or
// a DaemonUnreachableError from client.ts) and handled in exactly one place,
// main.ts's handleError, so a command never has to decide its own exit code
// for a failure path.

import { spawn, spawnSync } from 'node:child_process'
import { hostname } from 'node:os'
import { existsSync } from 'node:fs'
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { basename, join as joinPath, resolve as resolvePath } from 'node:path'
import {
  DEFAULT_POSTGRES_NAME,
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
import { issueToken, readTokens, revokeToken } from '../daemon/studio/tokens.js'
import type { WireResource } from '../daemon/wire.js'
import { createRemoteClient, DaemonUnreachableError, type Api, type IgnoredKey } from './client.js'
import { CLI_VERSION } from '../version.js'
import { forgetRemote, listRemotes, saveRemote } from './remote.js'
import { exitCodeForError } from './exit.js'
import {
  branchCopyNote,
  hostNetworkingWarning,
  proxyBindNote,
  reflinkWarning,
  renderDuration,
  renderPreflight,
  renderQueueLine,
  renderQueueMessageLine,
  renderQueueTuningLine,
  renderResourceLine,
  renderSnapshotLine,
} from './output.js'

// Io is defined in main.ts, which owns run() and is the file the brief
// names for the exported signature `run(argv, io)`; imported here as a
// type only, so this does not create a runtime circular dependency between
// the two files (main.ts imports these command functions at runtime).
import type { Io } from './main.js'

export type Flags = Record<string, string | boolean | string[]>

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

function flagList(flags: Flags, name: string): string[] {
  const value = flags[name]
  return Array.isArray(value) ? value : []
}

// The positional a target-taking verb was given, or the project this
// directory is linked to when it was given none (issue #98). `hobby link`
// has always printed "commands run from here default to that project", and
// until this every verb but `create` ignored the link. With neither, the
// verb's own usage line, unchanged.
function targetOrLinked(c: Ctx, positionals: string[], usage: string): string {
  const target = positionals[0] ?? c.config.project ?? undefined
  if (target === undefined) {
    throw new UsageError(usage)
  }
  return target
}

// Resolves a CLI target (`project` or `project/resource`) to exactly one
// resource. Ambiguity, per the spec, is an error listing the candidates,
// never a guess: a bare project name with more than one resource throws
// `ambiguous_target`, the same ErrorCode the daemon uses for this exact
// situation, so it maps through exit.ts identically regardless of which
// side of the socket noticed it.
//
// `linked` is the project this directory is linked to (`hobby link`, ADR
// 0018), or null. In a linked directory a bare name is tried first as a
// resource OF the linked project, so `hobby logs web` next to a hobby.json
// pointing at `blog` means `blog/web` (issue #98: before this it meant "the
// project named web", which did not exist, and the link was useless for
// every verb but create). Only when the linked project has no resource by
// that name does the bare name fall through to its original meaning, a
// project. A `project/resource` target never consults the link: the slash
// already said everything.
export async function resolveTarget(
  api: Api,
  target: string,
  linked: string | null = null
): Promise<{ project: Project; resource: WireResource }> {
  const { project: projectName, resource: resourceName } = parseTarget(target)

  if (resourceName === null && linked !== null && linked !== projectName) {
    const linkedDetail = await api.getProject(linked)
    const inLinked = linkedDetail.resources.find((r) => r.name === projectName)
    if (inLinked !== undefined) {
      return { project: linkedDetail.project, resource: inLinked }
    }
  }

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

// The queue-scoped sibling of resolveTarget above, for `hobby queue peek /
// send / purge / rm / set`, all of which take a target that must resolve to
// one queue, never any other kind. A bare project name disambiguates against
// the project's QUEUES only, not every resource in it: a project holding one
// postgres and one queue is not ambiguous for these commands, because a
// postgres was never a candidate answer to "which queue do you mean". A
// `project/name` target that names something real but not a queue is a
// distinct error from "no such resource", because the resource is there, it
// is just the wrong kind for this command.
export async function resolveQueueTarget(
  api: Api,
  target: string
): Promise<{ project: Project; resource: WireResource }> {
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
    if (resource.kind !== 'queue') {
      throw new HobbyError('usage', `${projectName}/${resourceName} is a ${resource.kind}, not a queue`)
    }
    return { project: detail.project, resource }
  }

  const queues = detail.resources.filter((r) => r.kind === 'queue')
  if (queues.length === 0) {
    throw new HobbyError('resource_not_found', `project ${projectName} has no queues`)
  }
  if (queues.length === 1) {
    return { project: detail.project, resource: queues[0] as WireResource }
  }
  throw new HobbyError(
    'ambiguous_target',
    `project ${projectName} has more than one queue: ${queues.map((r) => r.name).join(', ')}`,
    `specify project/queue, for example ${projectName}/${queues[0]?.name}`
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

  const hostNetworkingIssue = hostNetworkingWarning(report)
  if (hostNetworkingIssue !== null) {
    io.err(hostNetworkingIssue)
  }

  io.err(proxyBindNote(config.proxyHost, config.proxyTls?.hostname ?? null))

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

const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/

// The dotenv subset `hobby deploy --env-file` reads: `KEY=VALUE` per line,
// blank lines and `#` comments skipped, an optional `export ` prefix, and
// one matching pair of surrounding quotes stripped from the value. Only the
// first `=` splits, so a value may contain more of them (a connection string
// with query parameters, a base64 secret with padding). No interpolation and
// no escape handling: `$OTHER` and `\n` arrive in the container exactly as
// written, which is the least surprising thing a file of secrets can do.
//
// Exported and pure (text in, a map out, no filesystem) so the format is
// directly testable; see packages/cli/test/parse.test.ts. A bad key names
// its line, because a 28-line file with one typo is otherwise a hunt.
export function parseEnvFile(text: string): Record<string, string> {
  const env: Record<string, string> = {}
  const lines = text.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const line = (lines[i] as string).trim()
    if (line.length === 0 || line.startsWith('#')) {
      continue
    }
    const body = line.startsWith('export ') ? line.slice('export '.length).trimStart() : line
    const eq = body.indexOf('=')
    if (eq === -1) {
      throw new UsageError(`env file line ${i + 1}: expected KEY=VALUE`)
    }
    const key = body.slice(0, eq).trim()
    if (!ENV_KEY.test(key)) {
      throw new UsageError(
        `env file line ${i + 1}: ${JSON.stringify(key)} is not a valid variable name (letters, digits and _, not starting with a digit)`
      )
    }
    let value = body.slice(eq + 1).trim()
    if (value.length >= 2) {
      const first = value[0]
      if ((first === '"' || first === "'") && value[value.length - 1] === first) {
        value = value.slice(1, -1)
      }
    }
    env[key] = value
  }
  return env
}

// `K=V` arguments, from `hobby deploy --env K=V` and `hobby env set <target>
// K=V...`. Same key rule and same first-`=` split as parseEnvFile, no
// quote stripping: the shell already did that.
export function parseEnvAssignments(assignments: string[]): Record<string, string> {
  const env: Record<string, string> = {}
  for (const assignment of assignments) {
    const eq = assignment.indexOf('=')
    if (eq === -1) {
      throw new UsageError(`expected KEY=VALUE, got ${JSON.stringify(assignment)}`)
    }
    const key = assignment.slice(0, eq)
    if (!ENV_KEY.test(key)) {
      throw new UsageError(
        `${JSON.stringify(key)} is not a valid variable name (letters, digits and _, not starting with a digit)`
      )
    }
    env[key] = assignment.slice(eq + 1)
  }
  return env
}

// Every source of variables a deploy or `hobby env set` accepts, merged in
// the order a user would expect to win: an explicit `--env K=V` beats the
// same key in `--env-file`. Undefined when neither was given, which the
// callers read as "keep what is there".
async function envFromFlags(c: Ctx, flags: Flags): Promise<Record<string, string> | undefined> {
  let env: Record<string, string> | undefined
  const envFileFlag = flagString(flags, 'env-file')
  if (envFileFlag !== undefined) {
    const envPath = resolvePath(c.io.cwd, envFileFlag)
    if (!existsSync(envPath)) {
      throw new UsageError(`--env-file: no such file ${envPath}`)
    }
    env = parseEnvFile(await readFile(envPath, 'utf8'))
  }
  const assignments = flagList(flags, 'env')
  if (assignments.length > 0) {
    env = { ...(env ?? {}), ...parseEnvAssignments(assignments) }
  }
  return env
}

function deployKindConflict(project: string, name: string, existingKind: string): UsageError {
  return new UsageError(
    `${project}/${name} is a ${existingKind}, and a deploy would replace it. Pick another name with --name, or remove it first.`
  )
}

// A count and never the values: an env file is where the secrets live, and
// terminal scrollback and CI logs are where they leak.
function printEnvCount(c: Ctx, env: Record<string, string> | undefined, source?: string): void {
  if (env === undefined) {
    return
  }
  const count = Object.keys(env).length
  c.io.out(`  env       ${count} ${count === 1 ? 'variable' : 'variables'}${source === undefined ? '' : ` (from ${source})`}`)
}

// The wrangler convention for local secrets: a dotenv file beside the
// manifest, gitignored, that `wrangler dev` reads and `wrangler deploy`
// does not. Here it is read on deploy, because this box is where the
// worker runs (issue #74).
const DEV_VARS = '.dev.vars'

// Every wrangler key the daemon read and did not act on, one line each,
// where the user is looking. The spec promised "every ignored key printed
// at deploy time" and the daemon kept the promise only to its own stderr
// (issue #76). A redeploy prints them again: the manifest is re-read every
// time, and a key added since the last deploy is news.
function printIgnored(c: Ctx, ignored: IgnoredKey[] | undefined): void {
  for (const entry of ignored ?? []) {
    c.io.out(`  ignoring  ${entry.key}: ${entry.reason}`)
  }
}

export async function cmdDeploy(c: Ctx, positionals: string[], flags: Flags): Promise<number> {
  const parsed = parseDeploy(positionals, flags)
  const path = resolvePath(c.io.cwd, parsed.path)
  // --project, then the linked project, then the directory's own name. The
  // middle step is issue #98: `hobby link blog; hobby deploy` used to create
  // a brand new project named after the directory, which is the one thing a
  // user who just linked the directory cannot have meant.
  const projectName = parsed.project ?? c.config.project ?? basename(path)
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

  // Read on this machine and sent as a JSON map, so it behaves the same
  // against a remote daemon (ADR 0018) as against a local one: the file
  // never has to exist on the box. Read before anything below mutates, so a
  // missing or malformed file leaves no empty project behind.
  let env = await envFromFlags(c, flags)
  let envSource: string | undefined

  const kindFlag = typeof flags['kind'] === 'string' ? flags['kind'] : undefined
  if (kindFlag !== undefined && kindFlag !== 'app' && kindFlag !== 'worker') {
    throw new UsageError(`unknown --kind: ${kindFlag}. Expected app or worker.`)
  }
  // --dockerfile names a file relative to [path], which is the build
  // context (issue #146): a monorepo deploys each of its apps from the root
  // with its own Dockerfile, which the single `<path>/Dockerfile` check
  // could not express. --build-arg is repeatable and persisted with the
  // source, so a redeploy rebuilds with the same values. --context is the
  // worker-side answer to the same problem (issue #147): the directory
  // holding the manifest stays [path], and the install runs from the root.
  const dockerfileFlag = flagString(flags, 'dockerfile')
  const buildArgs = parseEnvAssignments(flagList(flags, 'build-arg'))
  const contextFlag = flagString(flags, 'context')
  const kind =
    kindFlag ??
    detectDeployKind({
      dockerfile: existsSync(joinPath(path, dockerfileFlag ?? 'Dockerfile')),
      wrangler: existsSync(joinPath(path, 'wrangler.toml')) || existsSync(joinPath(path, 'wrangler.jsonc')),
    })
  if (kind === 'worker' && (dockerfileFlag !== undefined || Object.keys(buildArgs).length > 0)) {
    throw new UsageError('--dockerfile and --build-arg are for apps. A worker is built from its wrangler manifest.')
  }
  if (kind === 'app' && contextFlag !== undefined) {
    throw new UsageError(
      '--context is for workers. For an app, [path] is the build context: pass the root as the path and --dockerfile for the file.'
    )
  }
  const context = contextFlag === undefined ? undefined : resolvePath(c.io.cwd, contextFlag)
  // Only what was given goes on the wire, so a redeploy that names neither
  // keeps the Dockerfile, build args and context the resource was last
  // built with (readSourceInput, packages/cli/src/daemon/routes.ts).
  const source = {
    path,
    ...(dockerfileFlag === undefined ? {} : { dockerfile: dockerfileFlag }),
    ...(Object.keys(buildArgs).length === 0 ? {} : { buildArgs }),
    ...(context === undefined ? {} : { context }),
  }

  // The rarer half of the same rule, now that the deploy's own kind is
  // known: an app redeployed as though it were a worker, or the reverse,
  // from a name it does not own.
  if (existing !== undefined && existing.kind !== kind) {
    throw deployKindConflict(projectName, name, existing.kind)
  }

  // An app deploy reads the Dockerfile and nothing else. A wrangler manifest
  // sitting beside it (reachable only with an explicit --kind app, since
  // detectDeployKind refuses the pair otherwise) is not read, including its
  // `vars`, and saying so is the difference between "hobby forgot" and
  // "hobby is deliberately not touching this" (issue #152). On stderr so
  // `--json` stdout stays the object.
  if (kind === 'app' && (existsSync(joinPath(path, 'wrangler.toml')) || existsSync(joinPath(path, 'wrangler.jsonc')))) {
    c.io.err('note: the wrangler manifest beside this Dockerfile is not read for an app; its vars do not reach the container. Use --env-file.')
  }

  // A worker with no explicit variables on the command line takes its
  // secrets from a `.dev.vars` beside the manifest when there is one, the
  // file wrangler itself reads for local runs. Explicit flags win over it
  // rather than merging, so what was sent is exactly one thing the user can
  // name. Plain `[vars]` still come from the manifest at start, under these.
  if (env === undefined && kind === 'worker' && existsSync(joinPath(path, DEV_VARS))) {
    env = parseEnvFile(await readFile(joinPath(path, DEV_VARS), 'utf8'))
    envSource = DEV_VARS
  }

  // A project is created on first deploy rather than required up front. The
  // alternative, making the user run `hobby new` first, means two commands
  // for the thing CLAUDE.md promises takes one.
  if (!projectExists) {
    await c.api.createProject(projectName)
  }

  if (existing !== undefined) {
    // `env` omitted keeps whatever the app already has; sent, it replaces
    // the whole set (deployApp, packages/app/src/app.ts).
    const result = await c.api.deployResource(existing.id, {
      source,
      ...(env === undefined ? {} : { env }),
    })
    if (flags.json) {
      c.io.out(JSON.stringify({ resource: result.resource, image: result.image, ignored: result.ignored ?? [] }, null, 2))
      return 0
    }
    c.io.out(`deployed ${projectName}/${name}`)
    c.io.out(`  image     ${result.image}`)
    c.io.out(`  url       https://${hostnameOf(result.resource)}`)
    printEnvCount(c, env, envSource)
    printIgnored(c, result.ignored)
    c.io.out('')
    c.io.out('It is asleep. The first request wakes it.')
    return 0
  }

  // --database binds a sibling postgres, which is how an app gets DATABASE_URL
  // (packages/app/src/app.ts's resolveDatabaseUrl). The daemon route has always
  // accepted databaseResourceId and the CLI had no way to send it, so an app
  // could not be pointed at its own project's database without editing state
  // by hand.
  let databaseResourceId: string | undefined
  const databaseFlag = flagString(flags, 'database')
  if (databaseFlag !== undefined) {
    const { resource: database } = await resolveTarget(
      c.api,
      databaseFlag.includes('/') ? databaseFlag : `${projectName}/${databaseFlag}`
    )
    if (database.kind !== 'postgres') {
      throw new UsageError(`--database must name a postgres resource, and ${databaseFlag} is a ${database.kind}`)
    }
    databaseResourceId = database.id
  }

  const { resource, ignored } = await c.api.createResource(
    projectName,
    kind === 'worker'
      ? {
          kind: 'worker',
          name,
          source,
          ...(databaseResourceId === undefined ? {} : { databaseResourceId }),
          ...(env === undefined ? {} : { env }),
        }
      : {
          kind: 'app',
          name,
          source,
          ...(portFlag === undefined ? {} : { port: portFlag }),
          ...(databaseResourceId === undefined ? {} : { databaseResourceId }),
          ...(env === undefined ? {} : { env }),
        }
  )

  if (flags.json) {
    c.io.out(JSON.stringify({ resource, ignored: ignored ?? [] }, null, 2))
    return 0
  }
  c.io.out(`deployed ${projectName}/${name}`)
  c.io.out(`  image     ${imageLine(resource.config.image)}`)
  c.io.out(`  url       https://${hostnameOf(resource)}`)
  printEnvCount(c, env, envSource)
  printIgnored(c, ignored)
  c.io.out('')
  c.io.out('It is asleep. The first request wakes it.')
  return 0
}

// `hobby env set|ls|unset`: variables and secrets on an app or a worker
// after it exists (issue #74), over POST /v1/resources/:id/env. Values are
// never printed by any of the three, and `ls` reads key names off the
// redacted wire config, so the CLI has no path that could print one.
//
// The target follows the link like every other target verb (targetOrLinked):
// `hobby env set K=V` in a linked directory is the common case, and it is
// told apart from `hobby env set <target> K=V` by the first argument
// containing an `=`, which no target can.
const ENV_USAGE = 'usage: hobby env set <target> K=V... [--env-file <f>] | hobby env ls <target> | hobby env unset <target> K...'

function envTargetAndRest(c: Ctx, args: string[], takesTarget: (arg: string) => boolean): { target: string; rest: string[] } {
  const first = args[0]
  if (first !== undefined && takesTarget(first)) {
    return { target: first, rest: args.slice(1) }
  }
  return { target: targetOrLinked(c, [], ENV_USAGE), rest: args }
}

async function resolveEnvTarget(c: Ctx, target: string): Promise<{ project: Project; resource: WireResource }> {
  const found = await resolveTarget(c.api, target, c.config.project)
  if (found.resource.kind !== 'app' && found.resource.kind !== 'worker') {
    throw new UsageError(`${target} is a ${found.resource.kind}, and only an app or a worker has environment variables to set`)
  }
  return found
}

function printEnvOutcome(c: Ctx, label: string, keys: string[], stopped: boolean): void {
  c.io.out(label)
  for (const key of keys) {
    c.io.out(`  ${key}`)
  }
  c.io.out(
    stopped
      ? 'It was running and has been stopped. The next request wakes it with the new values.'
      : 'Applied on its next wake.'
  )
}

export async function cmdEnvSet(c: Ctx, args: string[], flags: Flags): Promise<number> {
  const { target, rest } = envTargetAndRest(c, args, (arg) => !arg.includes('='))
  const fromFlags = await envFromFlags(c, flags)
  const fromArgs = parseEnvAssignments(rest)
  const set = { ...(fromFlags ?? {}), ...fromArgs }
  if (Object.keys(set).length === 0) {
    throw new UsageError('hobby env set: nothing to set. Pass K=V arguments or --env-file <f>.')
  }
  const { project, resource } = await resolveEnvTarget(c, target)
  const result = await c.api.setEnv(resource.id, { set })
  if (flags.json) {
    c.io.out(JSON.stringify({ set: Object.keys(set).sort(), keys: result.keys, stopped: result.stopped }))
    return 0
  }
  const count = Object.keys(set).length
  printEnvOutcome(c, `set ${count} ${count === 1 ? 'variable' : 'variables'} on ${project.name}/${resource.name}:`, Object.keys(set).sort(), result.stopped)
  return 0
}

export async function cmdEnvUnset(c: Ctx, args: string[], flags: Flags): Promise<number> {
  // `hobby env unset <target> K...` or, linked, `hobby env unset K...`: with
  // two or more arguments the first is the target; with one and a link,
  // it is a key.
  const { target, rest } =
    args.length >= 2 || (c.config.project ?? null) === null
      ? envTargetAndRest(c, args, () => true)
      : { target: targetOrLinked(c, [], ENV_USAGE), rest: args }
  if (rest.length === 0) {
    throw new UsageError('hobby env unset: name at least one variable to remove')
  }
  const { project, resource } = await resolveEnvTarget(c, target)
  const result = await c.api.setEnv(resource.id, { unset: rest })
  if (flags.json) {
    c.io.out(JSON.stringify({ unset: rest, keys: result.keys, stopped: result.stopped }))
    return 0
  }
  printEnvOutcome(c, `unset ${rest.length} ${rest.length === 1 ? 'variable' : 'variables'} on ${project.name}/${resource.name}:`, rest, result.stopped)
  return 0
}

export async function cmdEnvLs(c: Ctx, args: string[], flags: Flags): Promise<number> {
  const target = targetOrLinked(c, args, ENV_USAGE)
  const { project, resource } = await resolveEnvTarget(c, target)
  const env = (resource.config as { env?: Record<string, string> }).env ?? {}
  const keys = Object.keys(env).sort()
  // A worker also has the manifest's own [vars], which are its too, read
  // from the file on every deploy. Listed apart, because `hobby env unset`
  // cannot remove one of those: the file is where it lives.
  const vars =
    resource.kind === 'worker'
      ? Object.keys((resource.config as { manifest?: { vars?: Record<string, string> } | null }).manifest?.vars ?? {}).sort()
      : []

  if (flags.json) {
    c.io.out(JSON.stringify({ keys, ...(resource.kind === 'worker' ? { vars } : {}) }))
    return 0
  }
  if (keys.length === 0) {
    c.io.out(`${project.name}/${resource.name} has no variables set`)
  } else {
    c.io.out(`${project.name}/${resource.name}:`)
    for (const key of keys) {
      c.io.out(`  ${key}`)
    }
  }
  if (vars.length > 0) {
    c.io.out(`from [vars] in its wrangler config (change the file and redeploy):`)
    for (const key of vars) {
      c.io.out(`  ${key}`)
    }
  }
  c.io.out('values are never printed. Set one again to change it.')
  return 0
}

export async function cmdEnv(c: Ctx, positionals: string[], flags: Flags): Promise<number> {
  const [sub, ...rest] = positionals
  switch (sub) {
    case 'set':
      return cmdEnvSet(c, rest, flags)
    case 'unset':
      return cmdEnvUnset(c, rest, flags)
    case 'ls':
      return cmdEnvLs(c, rest, flags)
    default:
      throw new UsageError(sub === undefined ? ENV_USAGE : `unknown env subcommand: ${sub}\n${ENV_USAGE}`)
  }
}

// `hobby cron ls [project]`: every worker schedule, with when it next fires
// and how the last firing went (issue #75). Shaped like `hobby queue ls`:
// one project when named (or linked), every project with at least one
// schedule otherwise.
export async function cmdCronLs(c: Ctx, positionals: string[], flags: Flags): Promise<number> {
  const projectArg = positionals[0] ?? c.config.project ?? undefined
  const projectNames =
    projectArg !== undefined ? [projectArg] : (await c.api.listProjects()).projects.map((p) => p.name)

  const results: Array<{ project: string; crons: Awaited<ReturnType<Api['listCrons']>>['crons'] }> = []
  for (const name of projectNames) {
    const { crons } = await c.api.listCrons(name)
    if (projectArg === undefined && crons.length === 0) {
      continue
    }
    results.push({ project: name, crons })
  }

  if (flags.json) {
    c.io.out(JSON.stringify(projectArg !== undefined ? (results[0] ?? { project: projectArg, crons: [] }) : { projects: results }))
    return 0
  }
  if (results.length === 0 || results.every((r) => r.crons.length === 0)) {
    c.io.out(projectArg === undefined ? 'no worker declares a cron trigger' : `no worker in ${projectArg} declares a cron trigger`)
    return 0
  }
  for (const { crons } of results) {
    for (const entry of crons) {
      const last =
        entry.lastAt === null
          ? 'not yet'
          : `${entry.lastAt}${entry.lastOutcome === null || entry.lastOutcome.outcome === 'ok' ? '' : ` (${entry.lastOutcome.outcome})`}`
      c.io.out(`${entry.worker}  ${JSON.stringify(entry.cron)}  next ${entry.nextAt}  last ${last}`)
    }
  }
  return 0
}

export async function cmdCron(c: Ctx, positionals: string[], flags: Flags): Promise<number> {
  const [sub, ...rest] = positionals
  if (sub === 'ls' || sub === undefined) {
    return cmdCronLs(c, rest, flags)
  }
  throw new UsageError(`unknown cron subcommand: ${sub}\nusage: hobby cron ls [project]`)
}

export async function cmdNew(c: Ctx, positionals: string[], flags: Flags): Promise<number> {
  const name = positionals[0]
  if (name === undefined) {
    throw new UsageError('usage: hobby new <name> [--empty] [--pin]')
  }

  // `--pin`: born pinned awake, for the project that must never cold-start
  // (a production database on a box whose other projects all sleep).
  // Omitting the field, not sending a number, keeps the daemon's config
  // default in charge of the unpinned case.
  const { project } = await c.api.createProject(name, flags.pin === true ? null : undefined)

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
    ;({ resource } = await c.api.createResource(project.name, { kind: 'postgres', name: DEFAULT_POSTGRES_NAME }))
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
  const { connectionString, tailnetConnectionString, publicConnectionString } = await c.api.getConnection(resource.id)

  if (flags.json) {
    // Not one raw API response (no single route did all of this), but a
    // composite object whose every field is exactly what its own call
    // returned. Human output below reads only connectionString off this
    // same object, never a second source.
    c.io.out(
      JSON.stringify({
        project,
        resource,
        connectionString,
        tailnetConnectionString: tailnetConnectionString ?? null,
        publicConnectionString: publicConnectionString ?? null,
      })
    )
    return 0
  }

  c.io.out(connectionString)
  // Labelled second line, never a bare second string: the first line stays
  // exactly what it always was so `hobby new blog | pbcopy` keeps grabbing
  // one usable URI.
  if (tailnetConnectionString != null) c.io.out(`tailnet: ${tailnetConnectionString}`)
  if (publicConnectionString != null) c.io.out(`public: ${publicConnectionString}`)
  return 0
}

// `hobby branch <source> <name>`: a new project whose postgres resources
// start from a clone of the source's data (POST /v1/projects/:name/branch;
// packages/cli/src/daemon/branch.ts has the whole story). `branch` rather
// than `clone` or `fork`, because it is the word Neon and the roadmap both
// use, and the root CLAUDE.md names Phase 1.5 "copy-on-write branching".
//
// Unlike cmdNew, this prints no connection string. A branch keeps the
// source's password (a clone of PGDATA carries its roles with it), so the
// string is one the user already has, apart from the port, and `hobby
// connect <name>` is the one place a credential is handed out on purpose.
export async function cmdBranch(c: Ctx, positionals: string[], flags: Flags): Promise<number> {
  const [source, name] = positionals
  if (source === undefined || name === undefined || positionals.length > 2) {
    throw new UsageError('usage: hobby branch <source-project> <new-project> [--allow-pause]')
  }

  const result = await c.api.branchProject(source, name, { allowPause: flags['allow-pause'] === true })

  if (flags.json) {
    c.io.out(JSON.stringify(result))
  } else {
    c.io.out(`branched ${source} into ${result.project.name}: asleep until something connects, and not pinned`)
    for (const resource of result.resources) {
      c.io.out(`  ${renderResourceLine(resource)}`)
    }
    if (result.paused.length > 0 && result.pausedMs !== null) {
      c.io.out(`${source} was paused for ${result.pausedMs}ms while ${result.paused.join(', ')} was cloned`)
    }
    c.io.out(`connect with: hobby connect ${result.project.name}`)
  }

  // stderr in both modes, so --json stays one parseable object on stdout
  // and neither of these can be lost in it.
  if (result.clone === 'copy') {
    c.io.err(branchCopyNote())
  }
  for (const failure of result.resumeFailures) {
    c.io.err(`${source} did not come back after the clone: ${failure}. try \`hobby wake ${source}\``)
  }
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

// --project, or the project this directory is linked to (ADR 0018), in that
// order. An explicit flag always wins, so a linked directory never silently
// overrides what someone typed.
function projectFrom(c: Ctx, flags: Flags): string | undefined {
  return flagString(flags, 'project') ?? c.config.project ?? undefined
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
  const project = projectFrom(c, flags)
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
  const project = projectFrom(c, flags)
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
  const target = targetOrLinked(c, positionals, 'usage: hobby connect <target>')
  const { resource } = await resolveTarget(c.api, target, c.config.project)
  const { connectionString, tailnetConnectionString, publicConnectionString } = await c.api.getConnection(resource.id)

  if (flags.json) {
    c.io.out(
      JSON.stringify({
        connectionString,
        tailnetConnectionString: tailnetConnectionString ?? null,
        publicConnectionString: publicConnectionString ?? null,
      })
    )
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
  const target = targetOrLinked(c, positionals, `usage: hobby ${verb} <target>`)
  const { resource } = await resolveTarget(c.api, target, c.config.project)
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

function renderSleepPolicyLine(project: Project): string {
  return project.sleepAfterSeconds === null
    ? `project ${project.name}: pinned awake, never sleeps`
    : `project ${project.name}: sleeps after ${project.sleepAfterSeconds}s idle`
}

// `hobby pin <project>` and `hobby unpin <project> [--sleep-after N]`: the
// CLI face of POST /v1/projects/:name/sleep-policy. "Pinned" is the
// hibernator's own word for a null threshold (hibernator.ts checks it
// before anything else), so the verb teaches the model rather than adding a
// second vocabulary. Sleep and wake act on a resource right now; pin and
// unpin set what the hibernator is allowed to do from now on. Different
// tense, different verb.
export async function cmdPin(c: Ctx, positionals: string[], flags: Flags): Promise<number> {
  const name = targetOrLinked(c, positionals, 'usage: hobby pin <project>')
  const result = await c.api.setSleepPolicy(name, null)

  if (flags.json) {
    c.io.out(JSON.stringify(result))
  } else {
    c.io.out(renderSleepPolicyLine(result.project))
  }
  return 0
}

export async function cmdUnpin(c: Ctx, positionals: string[], flags: Flags): Promise<number> {
  const name = targetOrLinked(c, positionals, 'usage: hobby unpin <project> [--sleep-after <seconds>]')
  const raw = flagString(flags, 'sleep-after')
  let sleepAfterSeconds: number
  if (raw === undefined) {
    // No flag: fall back to the box-wide default the project would have been
    // created with. If that default is itself null, the box is configured to
    // never sleep anything, and silently writing null here would make unpin
    // a no-op that reports success; asking for an explicit value is the
    // honest move. `== null` on purpose: a config that never resolved the
    // field (a partial test config) must land here too, not send undefined
    // over the wire.
    if (c.config.sleepAfterSeconds == null) {
      throw new UsageError(
        'this box has no default idle threshold (sleepAfterSeconds is null in config), so pass one: hobby unpin <project> --sleep-after <seconds>'
      )
    }
    sleepAfterSeconds = c.config.sleepAfterSeconds
  } else {
    sleepAfterSeconds = Number(raw)
    if (!Number.isInteger(sleepAfterSeconds) || sleepAfterSeconds <= 0) {
      throw new UsageError('--sleep-after must be a positive whole number of seconds')
    }
  }
  const result = await c.api.setSleepPolicy(name, sleepAfterSeconds)

  if (flags.json) {
    c.io.out(JSON.stringify(result))
  } else {
    c.io.out(renderSleepPolicyLine(result.project))
  }
  return 0
}

export async function cmdLogs(c: Ctx, positionals: string[], flags: Flags): Promise<number> {
  const target = targetOrLinked(c, positionals, 'usage: hobby logs <target> [--tail N]')
  const { resource } = await resolveTarget(c.api, target, c.config.project)

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
  } else if (result.kept !== undefined) {
    c.io.out(`deleted ${target} from hobby. it was released, so nothing on disk was touched: ${result.kept} is still there`)
  } else {
    c.io.out(`deleted ${target}`)
  }
  return 0
}

// ---------------------------------------------------------------------------
// `hobby queue <verb>`. Every one of these is a thin client of the routes
// added alongside them in packages/cli/src/daemon/routes.ts: nothing here
// opens a queue's sqlite database, per root CLAUDE.md's "the daemon API is
// the only control surface".
// ---------------------------------------------------------------------------

// `hobby queue ls [project]`: with a project, one call; without one, every
// project that has at least one queue, mirroring cmdLs's own "everything"
// shape but narrowed to this kind. A project with zero queues is left out of
// the unscoped listing rather than printed with an empty body: cmdLs shows
// "(no resources)" for every project because that view IS the inventory of
// projects, but `hobby queue ls` with no argument is answering "where are my
// queues", and a project that has none is not part of that answer.
export async function cmdQueueLs(c: Ctx, positionals: string[], flags: Flags): Promise<number> {
  const projectArg = positionals[0]
  const projectNames =
    projectArg !== undefined ? [projectArg] : (await c.api.listProjects()).projects.map((p) => p.name)

  const results: Array<{ project: string; queues: Awaited<ReturnType<Api['listQueues']>>['queues'] }> = []
  for (const name of projectNames) {
    const { queues } = await c.api.listQueues(name)
    if (projectArg === undefined && queues.length === 0) {
      continue
    }
    results.push({ project: name, queues })
  }

  if (flags.json) {
    c.io.out(JSON.stringify(results))
    return 0
  }

  if (results.length === 0) {
    c.io.out('no queues yet. run `hobby queue create <name> --project <p>` to create one.')
    return 0
  }

  for (const { project, queues } of results) {
    c.io.out(project)
    for (const entry of queues) {
      c.io.out(`  ${renderQueueLine(entry)}`)
      const tuning = renderQueueTuningLine(entry)
      if (tuning !== null) {
        c.io.out(`      ${tuning}`)
      }
    }
  }
  return 0
}

// `hobby queue create <name> --project <p>`: the same shape as `hobby create
// <kind> <name> --project <p>` (cmdCreate above), not target syntax, because
// there is nothing yet to disambiguate against. A retention override is
// deliberately not a flag here: `hobby queue set <target> --retention <n>`
// is the one place that value is ever written, so there is exactly one code
// path to check when Cloudflare's bounds change rather than two.
export async function cmdQueueCreate(c: Ctx, positionals: string[], flags: Flags): Promise<number> {
  const name = positionals[0]
  if (typeof name !== 'string' || name.length === 0) {
    throw new UsageError('usage: hobby queue create <name> --project <project>')
  }
  const project = projectFrom(c, flags)
  if (project === undefined) {
    throw new UsageError('usage: hobby queue create <name> --project <project>')
  }
  const { resource } = await c.api.createQueue(project, name)
  if (flags.json) {
    c.io.out(JSON.stringify({ resource }))
  } else {
    c.io.out(renderResourceLine(resource))
  }
  return 0
}

// `hobby queue peek <target> [--limit n]`: read-only, ordered oldest first.
// Never leases, so a message shown here is still exactly as deliverable to a
// real consumer afterward as it was before this ran (packages/queue/src/broker.ts's
// peek(), which never touches lease_id).
export async function cmdQueuePeek(c: Ctx, positionals: string[], flags: Flags): Promise<number> {
  const target = positionals[0]
  if (target === undefined) {
    throw new UsageError('usage: hobby queue peek <target> [--limit n]')
  }
  const limitRaw = flagString(flags, 'limit')
  let limit: number | undefined
  if (limitRaw !== undefined) {
    limit = Number(limitRaw)
    if (!Number.isInteger(limit) || limit <= 0) {
      throw new UsageError('--limit must be a positive whole number')
    }
  }

  const { resource } = await resolveQueueTarget(c.api, target)
  const { messages } = await c.api.peekQueue(resource.id, limit)

  if (flags.json) {
    c.io.out(JSON.stringify({ messages }))
    return 0
  }
  if (messages.length === 0) {
    c.io.out('(empty)')
    return 0
  }
  for (const message of messages) {
    c.io.out(renderQueueMessageLine(message))
  }
  return 0
}

// `hobby queue send <target> <json>`: one message, parsed client-side so a
// malformed payload is a UsageError naming the text the user actually typed,
// rather than a 400 from the daemon that echoes it back through a second
// layer of JSON escaping.
export async function cmdQueueSend(c: Ctx, positionals: string[], flags: Flags): Promise<number> {
  const [target, json] = positionals
  if (target === undefined || json === undefined) {
    throw new UsageError('usage: hobby queue send <target> <json>')
  }
  let value: unknown
  try {
    value = JSON.parse(json)
  } catch {
    throw new UsageError(`the message is not valid JSON: ${json}`)
  }

  const { resource } = await resolveQueueTarget(c.api, target)
  const result = await c.api.sendMessage(resource.id, { body: value })

  if (flags.json) {
    c.io.out(JSON.stringify(result))
  } else {
    c.io.out(`sent ${result.id}`)
  }
  return 0
}

// `hobby queue purge <target>`: irreversible, and reachable by tab
// completion the same way `wrangler queues purge` is, which is exactly why
// it borrows that command's own confirmation shape rather than a bespoke
// one: the queue's own name (not the raw target string, and not the project
// name a bare target might have been) has to be typed back, because that is
// the identity actually being destroyed. `--yes` skips it for scripting, the
// same escape hatch cmdRm already offers for the identical reason.
export async function cmdQueuePurge(c: Ctx, positionals: string[], flags: Flags): Promise<number> {
  const target = positionals[0]
  if (target === undefined) {
    throw new UsageError('usage: hobby queue purge <target> [--yes]')
  }
  const { resource } = await resolveQueueTarget(c.api, target)

  if (!flags.yes) {
    c.io.out(`type "${resource.name}" to confirm purging it, this cannot be undone:`)
    const typed = await c.io.readLine()
    if (typed.trim() !== resource.name) {
      c.io.err('confirmation did not match, aborted')
      return 1
    }
  }

  const result = await c.api.purgeQueue(resource.id)
  if (flags.json) {
    c.io.out(JSON.stringify(result))
  } else {
    c.io.out(`purged ${result.purged} message(s) from ${resource.name}`)
  }
  return 0
}

// `hobby queue rm <target> [--yes]`: the same typed-name confirmation as
// `hobby rm` (cmdRm above), scoped to a resolved queue, over the exact same
// DELETE /v1/resources/:id route `hobby rm` itself uses. That route's own
// binding refusal (routes.ts's destroyResourceRoute) is what actually
// protects a bound queue; this command adds nothing but the queue-only
// target resolution and a queue-flavoured confirmation prompt.
export async function cmdQueueRm(c: Ctx, positionals: string[], flags: Flags): Promise<number> {
  const target = positionals[0]
  if (target === undefined) {
    throw new UsageError('usage: hobby queue rm <target> [--yes]')
  }
  const { resource } = await resolveQueueTarget(c.api, target)

  if (!flags.yes) {
    c.io.out(`type "${resource.name}" to confirm deleting it, this cannot be undone:`)
    const typed = await c.io.readLine()
    if (typed.trim() !== resource.name) {
      c.io.err('confirmation did not match, aborted')
      return 1
    }
  }

  const result = await c.api.deleteResource(resource.id)
  if (flags.json) {
    c.io.out(JSON.stringify(result))
  } else {
    c.io.out(`deleted ${resource.name}`)
  }
  return 0
}

// `hobby queue set <target> --retention <seconds>`: the only thing this
// verb can change today. Bounds are enforced server-side (routes.ts's
// setRetentionRoute, against packages/queue/src/broker.ts's
// MIN/MAX_RETENTION_SECONDS) and reported as a HobbyError naming them; this
// command's own check only rejects a non-integer before making a call that
// would fail anyway, it never re-clamps or re-validates the range itself, so
// there is exactly one place the bounds live.
export async function cmdQueueSet(c: Ctx, positionals: string[], flags: Flags): Promise<number> {
  const target = positionals[0]
  if (target === undefined) {
    throw new UsageError('usage: hobby queue set <target> --retention <seconds>')
  }
  const retentionRaw = flagString(flags, 'retention')
  if (retentionRaw === undefined) {
    throw new UsageError('usage: hobby queue set <target> --retention <seconds>')
  }
  const retentionSeconds = Number(retentionRaw)
  if (!Number.isInteger(retentionSeconds)) {
    throw new UsageError('--retention must be a whole number of seconds')
  }

  const { resource } = await resolveQueueTarget(c.api, target)
  const result = await c.api.setRetention(resource.id, retentionSeconds)

  if (flags.json) {
    c.io.out(JSON.stringify(result))
  } else {
    // Echo the value that was set (issue #170), not the generic resource
    // line, which said "jobs  queue  running" and left the user to trust
    // that something changed.
    const applied = result.resource.kind === 'queue' ? result.resource.config.retentionSeconds : retentionSeconds
    c.io.out(`${result.resource.name}  retention ${renderDuration(applied)}`)
  }
  return 0
}

// `hobby queue <ls|create|peek|send|purge|rm|set> ...`: one dispatcher, the
// same shape cmdPg already uses for its own `create` subcommand, so main.ts
// parses this command's flags once (covering every subcommand's flags) and
// hands positionals[0] off as the verb.
export async function cmdQueue(c: Ctx, positionals: string[], flags: Flags): Promise<number> {
  const [sub, ...rest] = positionals
  switch (sub) {
    case 'ls':
      return cmdQueueLs(c, rest, flags)
    case 'create':
      return cmdQueueCreate(c, rest, flags)
    case 'peek':
      return cmdQueuePeek(c, rest, flags)
    case 'send':
      return cmdQueueSend(c, rest, flags)
    case 'purge':
      return cmdQueuePurge(c, rest, flags)
    case 'rm':
      return cmdQueueRm(c, rest, flags)
    case 'set':
      return cmdQueueSet(c, rest, flags)
    default:
      throw new UsageError(
        `usage: hobby queue <ls|create|peek|send|purge|rm|set> ...${sub === undefined ? '' : ` (got: ${sub})`}`
      )
  }
}

// POST /v1/projects/:name/eject is a pure, non-destructive read (see
// task-4-report.md): it renders a compose file from real state and does not
// stop managing the project. This command mirrors that honestly: the
// compose YAML is the only thing on stdout in human mode, so
// `hobby eject blog > docker-compose.yml` still works, and the
// data-directory listing plus a note that hobby is still managing this
// project go to stderr instead of polluting that redirect. The one thing
// that does land on disk unasked is a queue's backlog, written to
// ./queues/<name>.jsonl: unlike a compose file, there is nowhere else for a
// departing user to redirect it to, and CLAUDE.md's "you can always leave"
// does not get an exception for messages just because they are awkward to
// hand over.
export async function cmdEject(c: Ctx, positionals: string[], flags: Flags): Promise<number> {
  const project = targetOrLinked(c, positionals, 'usage: hobby eject <project>')
  const release = flags.release === true
  const result = await c.api.eject(project, { release })

  if (flags.json) {
    c.io.out(JSON.stringify(result))
    return 0
  }

  // Written before anything is printed, same reasoning as the daemon side
  // (routes.ts's ejectRoute comment): a queue's backlog is user data, and
  // the compose comment above `services:` already promises these files
  // exist at this exact path once someone has read that far. Every queue in
  // the project gets a file here, including one with zero messages
  // (result.queues always carries `count: 0` rather than omitting it), so a
  // missing file can only ever mean "this project has no queue named that."
  const queues = result.queues ?? []
  if (queues.length > 0) {
    await mkdir(resolvePath(c.io.cwd, 'queues'), { recursive: true })
    for (const queue of queues) {
      await writeFile(resolvePath(c.io.cwd, 'queues', `${queue.name}.jsonl`), queue.jsonl, 'utf8')
    }
  }

  c.io.out(result.compose)
  if (queues.length > 0) {
    c.io.err("queue backlogs (hobby's broker is not part of the compose file; see the comment at its top):")
    for (const queue of queues) {
      c.io.err(`  queues/${queue.name}.jsonl (${queue.count} message${queue.count === 1 ? '' : 's'})`)
    }
    c.io.err('')
  }
  // A queue-only project has no data directory to list (issue #169), so the
  // two headings below would otherwise print with nothing under them.
  if (result.dataDirs.length > 0) {
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
  }
  if (release) {
    c.io.err(
      `hobby has stopped acting on ${project} and deleted nothing. its databases are stopped, its records ` +
        'are still here, and the data directories above are untouched: the compose file on stdout starts ' +
        `the same data. run \`hobby adopt ${project}\` to take it back, after stopping that stack.`
    )
  } else {
    c.io.err(
      `this is a preview: hobby is still managing ${project}, and the file mounts its live data directories ` +
        'in place, so every service is behind the compose profile "hobby-released" and `docker compose up` ' +
        'starts nothing from it. pass --release to hand the project over: databases stopped, hobby out of the ' +
        'way, every record and every byte kept, and a file that is meant to be started.'
    )
  }
  return 0
}

// The other half of --release, and the reason --release is safe to type out of
// curiosity: nothing was deleted, so taking a project back is a state change
// rather than a restore.
export async function cmdAdopt(c: Ctx, positionals: string[], flags: Flags): Promise<number> {
  const project = targetOrLinked(c, positionals, 'usage: hobby adopt <project>')

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

// ---------------------------------------------------------------------------
// `hobby snapshot`. Thin clients of the snapshot routes in
// packages/cli/src/daemon/routes.ts, which are thin themselves: the
// machinery is packages/cli/src/daemon/snapshots.ts (ADR 0016).
//
//   hobby snapshot <project> [--allow-pause]
//   hobby snapshot ls <project>
//   hobby snapshot restore <project> <id> [--as <name> | --in-place] [--allow-pause] [--yes]
//   hobby snapshot rm <project> <id> [--yes]
//
// The subcommand words are matched before a project name is, the same shape
// `hobby queue` has, so a project literally named `ls`, `restore` or `rm`
// cannot be snapshotted from this verb. validateName allows those names;
// the API route takes any name and is the way round it.
// ---------------------------------------------------------------------------

// The id is resolved inside the project the caller named rather than taken
// on trust. Ids are install-unique and the daemon could resolve one alone
// (findSnapshot, snapshots.ts), but a restore over the wrong project is not
// an error anyone should be able to make by pasting the wrong line from
// `hobby snapshot ls`, and naming the project is also what gives the
// in-place confirmation prompt something meaningful to ask for.
async function snapshotOfProject(c: Ctx, project: string, id: string): Promise<void> {
  const { snapshots } = await c.api.listSnapshots(project)
  if (!snapshots.some((snapshot) => snapshot.snapshotId === id)) {
    throw new HobbyError(
      'resource_not_found',
      `no snapshot ${id} of project ${project}`,
      `run \`hobby snapshot ls ${project}\` to see what exists`
    )
  }
}

export async function cmdSnapshotTake(c: Ctx, positionals: string[], flags: Flags): Promise<number> {
  if (positionals.length > 1) {
    throw new UsageError('usage: hobby snapshot <project> [--online | --allow-pause]')
  }
  const project = targetOrLinked(c, positionals, 'usage: hobby snapshot <project> [--online | --allow-pause]')
  const online = flags.online === true
  const allowPause = flags['allow-pause'] === true
  // Refused here as well as by the daemon (takeSnapshotRoute), so the
  // mistake costs no round trip and reads as a usage line rather than an
  // API error.
  if (online && allowPause) {
    throw new UsageError('--online and --allow-pause cannot be combined: --online pauses nothing, so there is no pause to allow')
  }
  const result = await c.api.takeSnapshot(project, { allowPause, online })

  if (flags.json) {
    c.io.out(JSON.stringify(result))
    return 0
  }

  const count = result.snapshot.resources.length
  c.io.out(
    `snapshot ${result.snapshot.snapshotId} of ${project}: ${count} resource${count === 1 ? '' : 's'}, ` +
      `${result.snapshot.clone === 'reflink' ? 'reflink clone' : 'full copy'}${online ? ', online (nothing paused)' : ''}`
  )
  c.io.out(`  ${result.dir}`)
  // Said once, here, because it is the one visible difference an online
  // snapshot makes later: the restored database's first start replays WAL
  // from backup_label before it answers (basebackupPostgres, basebackup.ts).
  const backedUp = result.snapshot.resources.filter((resource) => resource.method === 'basebackup')
  if (backedUp.length > 0) {
    c.io.out(
      `  copied running with pg_basebackup: ${backedUp.map((resource) => resource.name).join(', ')}. ` +
        'a restore of it runs recovery on its first start'
    )
  }
  // Truthful about what resume did, from the store: a resource that did not
  // come back is `failed` in this list, and the snapshot is still good.
  for (const resource of result.resources) {
    if (resource.state === 'failed') {
      c.io.err(`${resource.name} did not start again after the snapshot. \`hobby logs ${project}/${resource.name}\` may say why`)
    }
  }
  // ADR 0016, "Consequences accepted": the limits are stated where the
  // snapshot is taken, not left for the worst day.
  c.io.err(
    'a local snapshot, on the same disk as the project: it covers a bad migration or a mistake, not losing this disk. ' +
      `restore it with \`hobby snapshot restore ${project} ${result.snapshot.snapshotId}\``
  )
  return 0
}

export async function cmdSnapshotLs(c: Ctx, positionals: string[], flags: Flags): Promise<number> {
  const project = targetOrLinked(c, positionals, 'usage: hobby snapshot ls <project>')
  const result = await c.api.listSnapshots(project)
  if (flags.json) {
    c.io.out(JSON.stringify(result))
    return 0
  }
  if (result.snapshots.length === 0) {
    c.io.out(`no snapshots of ${project}. take one with \`hobby snapshot ${project}\``)
    return 0
  }
  for (const snapshot of result.snapshots) {
    c.io.out(renderSnapshotLine(snapshot))
  }
  return 0
}

// Restore semantics, in full, because this is the verb run on the worst day:
//
// - Default, and with --as <name>: into a NEW project (`<project>-restored`
//   unless named). Nothing existing is touched and the original may keep
//   running. The new project's resources are all asleep and wake on first
//   use like anything else. Worker Durable Object state is carried across
//   under the new resource ids (renameDurableObjectDirs, snapshots.ts).
// - --in-place: REPLACES the project's data with the snapshot's, keeping its
//   resource ids, ports and connection strings, so nothing pointed at it has
//   to change. The project is stopped for the swap and whatever was running
//   is started again on the restored data. The data it replaces is set aside,
//   not deleted, until everything that was running has come back on the
//   restored data; if something does not, it stays on disk and its path is
//   printed. Refused when the project's resources have changed since the
//   snapshot (restore with --as instead), and data only: code is whatever was
//   last deployed, not what was deployed when the snapshot was taken.
//   Asks for the project name to be typed unless --yes.
// - --allow-pause: needed only to stop a pinned project that has something
//   running (in place only; a restore into a new project stops nothing).
export async function cmdSnapshotRestore(c: Ctx, positionals: string[], flags: Flags): Promise<number> {
  const [project, id] = positionals
  const usage = 'usage: hobby snapshot restore <project> <id> [--as <name> | --in-place] [--allow-pause] [--yes]'
  if (project === undefined || id === undefined || positionals.length > 2) {
    throw new UsageError(usage)
  }
  const as = flagString(flags, 'as')
  const inPlace = flags['in-place'] === true
  if (inPlace && as !== undefined) {
    throw new UsageError(`--as and --in-place cannot be combined. ${usage}`)
  }

  await snapshotOfProject(c, project, id)

  if (inPlace && !flags.yes) {
    c.io.out(`type "${project}" to confirm replacing its data with snapshot ${id}:`)
    const typed = await c.io.readLine()
    if (typed.trim() !== project) {
      c.io.err('confirmation did not match, aborted')
      return 1
    }
  }

  const result = await c.api.restoreSnapshot(id, {
    ...(as !== undefined ? { as } : {}),
    ...(inPlace ? { inPlace: true } : {}),
    allowPause: flags['allow-pause'] === true,
  })

  if (flags.json) {
    c.io.out(JSON.stringify(result))
    return result.restartFailures.length > 0 ? 1 : 0
  }

  if (inPlace) {
    c.io.out(`restored ${project} in place from snapshot ${id}`)
  } else {
    c.io.out(`restored snapshot ${id} into new project ${result.project.name}. ${project} is untouched`)
  }
  for (const resource of result.resources) {
    c.io.out(`  ${renderResourceLine(resource)}`)
  }
  for (const failure of result.restartFailures) {
    c.io.err(`did not start on the restored data: ${failure}`)
  }
  if (result.preRestoreDir !== null) {
    c.io.err(`the data this restore replaced is kept at ${result.preRestoreDir}. delete it once you are sure it is not needed`)
  }
  // Exit 1 when something that was running did not come back: the data is
  // restored, but a script checking $? should not read this as all clear.
  return result.restartFailures.length > 0 ? 1 : 0
}

export async function cmdSnapshotRm(c: Ctx, positionals: string[], flags: Flags): Promise<number> {
  const [project, id] = positionals
  if (project === undefined || id === undefined || positionals.length > 2) {
    throw new UsageError('usage: hobby snapshot rm <project> <id> [--yes]')
  }
  await snapshotOfProject(c, project, id)

  if (!flags.yes) {
    c.io.out(`type "${id}" to confirm deleting this snapshot, this cannot be undone:`)
    const typed = await c.io.readLine()
    if (typed.trim() !== id) {
      c.io.err('confirmation did not match, aborted')
      return 1
    }
  }

  const result = await c.api.deleteSnapshot(id)
  if (flags.json) {
    c.io.out(JSON.stringify(result))
  } else {
    c.io.out(`deleted snapshot ${id}`)
  }
  return 0
}

export async function cmdSnapshot(c: Ctx, positionals: string[], flags: Flags): Promise<number> {
  const [first, ...rest] = positionals
  switch (first) {
    case undefined:
      throw new UsageError('usage: hobby snapshot <project> | ls <project> | restore <project> <id> | rm <project> <id>')
    case 'ls':
      return cmdSnapshotLs(c, rest, flags)
    case 'restore':
      return cmdSnapshotRestore(c, rest, flags)
    case 'rm':
      return cmdSnapshotRm(c, rest, flags)
    default:
      return cmdSnapshotTake(c, positionals, flags)
  }
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

// `hobby studio`: prints the URL to open and opens it when it can. When
// Caddy is fronting Studio (config.caddyEnabled, plus a configured
// config.caddyStudioHost, see startDaemon's addRoute call in
// packages/cli/src/daemon/server.ts), that public host is the address that
// actually works from anywhere, so it wins. Otherwise this points straight
// at the daemon's own loopback listener (config.apiPort): the daemon serves
// both the API and Studio's built bundle on that same port
// (packages/cli/src/daemon/studio/routes.ts's createStudioApp).
export function cmdStudio(io: Io, paths: Paths, config: HobbyConfig, openBrowser: BrowserOpener = defaultOpenBrowser): number {
  const url =
    config.caddyEnabled && config.caddyStudioHost !== null
      ? `https://${config.caddyStudioHost}`
      : `http://127.0.0.1:${config.apiPort}`

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

// --- remote access (ADR 0018) ---------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

// `hobby login <url>`: exchange the operator password for a token and store it.
//
// The password is read through Io.readLine with silent: true, the same path
// `hobby studio passwd` uses, so it never appears on screen, in scrollback, or
// in a terminal recording, and never becomes an argv element any process list
// can read.
export async function cmdLogin(
  io: Io,
  paths: Paths,
  positionals: string[],
  flags: Flags
): Promise<number> {
  const raw = positionals[0]
  if (raw === undefined) {
    throw new UsageError('usage: hobby login <url>')
  }

  let url: URL
  try {
    url = new URL(raw.includes('://') ? raw : `https://${raw}`)
  } catch {
    throw new UsageError(`not a url: ${raw}`)
  }
  const origin = url.origin

  const name = flagString(flags, 'name') ?? `${hostname()}-${Date.now().toString(36)}`

  io.err(`password for ${origin}: `)
  const password = await io.readLine({ silent: true })
  if (password.length === 0) {
    throw new HobbyError('usage', 'no password given')
  }

  // Unauthenticated by definition: this is the call that gets the credential,
  // so it goes through a transport with no token attached.
  const anon = createRemoteClient(origin, '')
  const res = await anon.request('POST', '/studio/token', { password, name })

  if (res.status === 401) {
    throw new HobbyError('unauthorized', 'invalid credentials', 'the password is the one set by `hobby studio passwd` on that box')
  }
  if (res.status >= 400) {
    throw new HobbyError('internal', `login failed with status ${res.status}`)
  }

  const token = isRecord(res.body) ? res.body['token'] : undefined
  if (typeof token !== 'string') {
    throw new HobbyError('internal', 'the daemon did not return a token')
  }

  saveRemote(paths, { url: origin, token, name, addedAt: new Date().toISOString() })

  if (flags.json === true) {
    io.out(JSON.stringify({ url: origin, name }))
  } else {
    io.out(`logged in to ${origin} as ${name}`)
    io.out('every command now runs against that box. `hobby logout` to stop.')
  }
  return 0
}

// `hobby logout [url]`: forget a remote. The token stays valid on the box
// until it is revoked there, and this says so rather than implying otherwise.
export function cmdLogout(io: Io, paths: Paths, positionals: string[]): number {
  const forgotten = forgetRemote(paths, positionals[0] ?? null)
  if (forgotten === null) {
    io.err('not logged in to anything')
    return 1
  }
  io.out(`forgot ${forgotten}`)
  io.out(`the token is still valid on that box. revoke it there with \`hobby token rm\` if it should not be.`)
  return 0
}

export function cmdRemote(io: Io, paths: Paths, positionals: string[], flags: Flags): number {
  const sub = positionals[0] ?? 'ls'
  if (sub !== 'ls') {
    throw new UsageError(`unknown remote subcommand: ${sub}`)
  }
  const { current, remotes } = listRemotes(paths)
  if (flags.json === true) {
    io.out(JSON.stringify({ current, remotes: remotes.map((r) => ({ url: r.url, name: r.name, addedAt: r.addedAt })) }))
    return 0
  }
  if (remotes.length === 0) {
    io.out('no remotes. `hobby login <url>` to add one.')
    return 0
  }
  for (const r of remotes) {
    io.out(`${r.url === current ? '*' : ' '} ${r.url}  ${r.name}`)
  }
  return 0
}

// `hobby link <project>`: write the project name into the hobby.json this
// directory resolves to, so commands below it stop needing --project.
//
// The file written is the one resolveConfig already reads by walking up from
// cwd (packages/core/src/config.ts), which is the same file that carries
// proxyHost and the rest. One project file, not a second one.
export async function cmdLink(
  c: Ctx,
  positionals: string[],
  flags: Flags
): Promise<number> {
  const name = positionals[0]
  if (name === undefined) {
    throw new UsageError('usage: hobby link <project>')
  }

  // Fail if the project is not there, rather than writing a file that points
  // at nothing and letting the next command produce the confusing error.
  await c.api.getProject(name)

  const target = joinPath(c.io.cwd, 'hobby.json')
  let existing: Record<string, unknown> = {}
  if (existsSync(target)) {
    try {
      const parsed: unknown = JSON.parse(await readFile(target, 'utf8'))
      if (isRecord(parsed)) existing = parsed
    } catch {
      throw new HobbyError('usage', `${target} is not valid json`, 'fix or remove it, then run this again')
    }
  }

  existing['project'] = name
  await writeFile(target, `${JSON.stringify(existing, null, 2)}\n`)

  if (flags.json === true) {
    c.io.out(JSON.stringify({ project: name, file: target }))
  } else {
    c.io.out(`${target} now points at ${name}`)
    c.io.out('commands run from here default to that project: deploy goes into it, and a verb given no target acts on it.')
  }
  return 0
}

// `hobby token create|ls|rm`: the box side of ADR 0018. Deliberately local
// only, reached through the unix socket, so tokens are minted by someone with
// shell access on the box rather than by anyone holding an existing token.
export async function cmdToken(
  io: Io,
  paths: Paths,
  positionals: string[],
  flags: Flags
): Promise<number> {
  const sub = positionals[0]

  if (sub === 'create') {
    const name = positionals[1]
    if (name === undefined) {
      throw new UsageError('usage: hobby token create <name>')
    }
    const token = await issueToken(paths, name)
    if (flags.json === true) {
      io.out(JSON.stringify({ name, token }))
    } else {
      io.out(token)
      io.err('')
      io.err('this is the only time it is shown. store it now.')
      io.err(`on the other machine: hobby login <url>, or set it directly.`)
    }
    return 0
  }

  if (sub === 'ls' || sub === undefined) {
    const tokens = readTokens(paths)
    if (flags.json === true) {
      io.out(JSON.stringify(tokens.map(({ name, createdAt, tail }) => ({ name, createdAt, tail }))))
      return 0
    }
    if (tokens.length === 0) {
      io.out('no tokens. `hobby token create <name>` to make one.')
      return 0
    }
    for (const t of tokens) {
      io.out(`${t.name}  ...${t.tail}  ${t.createdAt}`)
    }
    return 0
  }

  if (sub === 'rm') {
    const name = positionals[1]
    if (name === undefined) {
      throw new UsageError('usage: hobby token rm <name>')
    }
    if (!revokeToken(paths, name)) {
      throw new HobbyError('resource_not_found', `no token named ${name}`, 'run `hobby token ls` to see them')
    }
    io.out(`revoked ${name}`)
    io.out('any machine holding it is locked out immediately.')
    return 0
  }

  throw new UsageError(`usage: hobby token <create|ls|rm> ... (got: ${sub})`)
}

// `hobby update`: fetch the newest release and rebuild in place.
//
// Deliberately a thin wrapper over the checkout rather than a downloader of
// binaries. install.sh already knows how to build and install a launcher, and
// scripts/web-install.sh already knows how to move a checkout forward, so this
// reuses both instead of inventing a third path that can drift from them.
//
// Runs against tags, not main. Someone typing `hobby update` is asking for the
// newest release, and main is whatever was merged an hour ago.
// `hobby version [--json]`: this binary's version, and the daemon's if one
// answers (issue #96). Two numbers, not one, because ADR 0018 lets this CLI
// talk to a box it was not installed on, and a bug report that says "alpha.4"
// has to say which side. An unreachable daemon is `null`, not an error: the
// question "what version am I running" has an answer without one. A daemon
// older than GET /v1/version answers it with `usage` (unknown route), which
// is reported as "older than this CLI" rather than as a failure.
export async function cmdVersion(c: Ctx, flags: Flags): Promise<number> {
  let daemon: string | null = null
  let reachable = false
  try {
    const res = await c.api.version()
    reachable = true
    daemon = res.version
  } catch (err) {
    if (err instanceof HobbyError && err.code === 'usage') {
      reachable = true
    } else if (!(err instanceof DaemonUnreachableError)) {
      throw err
    }
  }

  if (flags.json) {
    c.io.out(JSON.stringify({ cli: CLI_VERSION, daemon, daemonReachable: reachable }))
    return 0
  }
  c.io.out(`hobby   ${CLI_VERSION}`)
  if (!reachable) {
    c.io.out('daemon  not reachable')
  } else if (daemon === null) {
    c.io.out('daemon  older than this CLI (it has no /v1/version route)')
  } else {
    c.io.out(`daemon  ${daemon}`)
  }
  return 0
}

export async function cmdUpdate(io: Io, paths: Paths, flags: Flags): Promise<number> {
  const src = process.env.HOBBY_SRC_DIR ?? joinPath(paths.home, 'src')

  if (!existsSync(joinPath(src, '.git'))) {
    throw new HobbyError(
      'usage',
      `${src} is not a checkout, so there is nothing to update`,
      'if you installed somewhere else, set HOBBY_SRC_DIR to it'
    )
  }

  const git = (args: string[]): string => {
    const res = spawnSync('git', ['-C', src, ...args], { encoding: 'utf8' })
    if (res.status !== 0) {
      const verb = args.find((arg) => !arg.startsWith('-') && arg !== 'versionsort.suffix=-') ?? args[0]
      throw new HobbyError('internal', `git ${verb} failed`, (res.stderr || '').trim() || undefined)
    }
    return (res.stdout || '').trim()
  }

  const before = git(['rev-parse', '--short', 'HEAD'])

  io.err('==> Fetching releases')
  // --force because the remote decides what a tag points at. Without it, a tag
  // that was moved (a release re-cut before anyone had it) makes fetch refuse
  // with "would clobber existing tag" and update dies for a reason the user
  // cannot act on. Measured: retagging a release broke update on a box holding
  // the old ref.
  git(['fetch', '--tags', '--force', '--quiet', 'origin'])

  // Sorted by version, newest last, so this picks the highest tag rather than
  // the most recently created one. versionsort.suffix=- is what makes a
  // pre-release sort BEFORE its final: without it git's version sort puts
  // v0.1.0-alpha.10 after v0.1.0, and the first box on a final release would
  // have been "updated" back onto an alpha (issue #134).
  const tags = git(['-c', 'versionsort.suffix=-', 'tag', '--list', 'v*', '--sort=v:refname'])
    .split('\n')
    .filter((t) => t.length > 0)
  const latest = tags[tags.length - 1]
  if (latest === undefined) {
    throw new HobbyError('internal', 'no release tags found', 'the remote has no v* tags to update to')
  }

  // Not through git(): --exact-match exits nonzero on any commit that is not a
  // tag, which is a normal state (a box moved to main by hand), not an error.
  // Throwing here made update unusable from exactly the checkouts that most
  // needed moving back onto a release.
  const described = spawnSync('git', ['-C', src, 'describe', '--tags', '--exact-match'], { encoding: 'utf8' })
  const current = described.status === 0 ? (described.stdout || '').trim() : null
  if (current === latest) {
    io.out(`already on ${latest}`)
    return 0
  }

  if (flags['check'] === true) {
    io.out(latest)
    return 0
  }

  // Tracked modifications only. `bun install` leaves an untracked bun.lock in
  // every built checkout, so counting untracked files here made update refuse
  // on any box that had ever been built, which is all of them. A checkout
  // cannot lose an untracked file anyway; if one collides with a path the new
  // tag adds, git says so itself.
  //
  // Refuse rather than discard: a checkout with local edits is someone's work,
  // even under ~/.hobby/src.
  if (git(['status', '--porcelain', '--untracked-files=no']).length > 0) {
    throw new HobbyError(
      'conflict',
      `${src} has uncommitted changes`,
      'commit or stash them, then run this again'
    )
  }

  io.err(`==> Updating to ${latest}`)
  git(['checkout', '--quiet', latest])

  io.err('==> Rebuilding')
  const build = spawnSync(joinPath(src, 'install.sh'), [], { stdio: 'inherit', cwd: src, env: process.env })
  if (build.status !== 0) {
    // The checkout has already moved, so say so: leaving someone believing
    // they are still on the old version would be worse than the failure.
    throw new HobbyError(
      'internal',
      'the rebuild failed',
      `the checkout is now at ${latest}. Fix the error above and run ${src}/install.sh again.`
    )
  }

  io.out(`updated ${before} -> ${latest}`)
  io.out('restart the daemon for it to take effect.')
  return 0
}
