// The command surface's entry point. `run` parses argv, dispatches to one
// function per verb in commands.ts, and returns an exit code; it never
// touches process.exit, process.stdout, process.stderr or process.stdin
// directly; everything crosses the Io boundary, which is what makes this
// file testable without a real terminal. `main` is the only thing in this
// package allowed to call process.exit, and it is the only thing that
// constructs a real, process-backed Io.

import { resolveConfig, resolvePaths, HobbyError } from '@hobby.sh/core'
import { createApi, createRemoteClient, DaemonUnreachableError } from './client.js'
import { activeRemote, type RemoteCredential } from './remote.js'
import {
  cmdConnect,
  cmdDaemon,
  cmdAdopt,
  cmdBranch,
  cmdCreate,
  cmdCron,
  cmdDeploy,
  cmdEject,
  cmdEnv,
  cmdInit,
  cmdLink,
  cmdLogin,
  cmdLogout,
  cmdLogs,
  cmdLs,
  cmdRemote,
  cmdToken,
  cmdUpdate,
  cmdNew,
  cmdPg,
  cmdPin,
  cmdQueue,
  cmdRm,
  cmdSleep,
  cmdSnapshot,
  cmdStudio,
  cmdStudioPasswd,
  cmdUnpin,
  cmdVersion,
  cmdWake,
  errorEnvelope,
  UsageError,
  type Ctx,
  type Flags,
} from './commands.js'
import { EXIT_DAEMON_UNREACHABLE, EXIT_OPERATION_FAILED, EXIT_USAGE, exitCodeForError } from './exit.js'

export interface ReadLineOptions {
  // Never echoes what is typed back to the terminal, and is the only mode
  // `hobby studio passwd` (commands.ts's cmdStudioPasswd) ever asks for: the
  // operator credential must never appear on screen, in scrollback, or in a
  // terminal-recording tool, the same class of leak `hobby connect` already
  // closed for argv (see cmdConnect's own comment on why a connection string
  // never becomes a psql argv element). realReadLine below is the only
  // implementation that has to honor this; a fake Io in a test can ignore it
  // entirely, since a test never has a real terminal to echo onto.
  silent?: boolean
}

export interface Io {
  out(s: string): void
  err(s: string): void
  env: NodeJS.ProcessEnv
  cwd: string
  // Reads one line from stdin. Used by `rm`'s confirmation prompt and by
  // `studio passwd`'s two password prompts, per the brief's explicit
  // instruction to read through Io rather than process.stdin directly, so
  // both can be faked in a test.
  readLine(opts?: ReadLineOptions): Promise<string>
}

export interface ParsedArgs {
  positionals: string[]
  flags: Record<string, string | boolean | string[]>
}

export interface FlagSpec {
  bool?: string[]
  value?: string[]
  // Repeatable value flags: `--env A=1 --env B=2` collects ['A=1', 'B=2'].
  // A value flag given twice keeps the last one, which is the wrong answer
  // for a flag whose whole point is being given many times.
  multi?: string[]
}

// A hand-written parser, not a library, per the global constraint (no CLI
// framework). Each verb declares which flags it accepts as boolean
// (--json, --yes: present or absent, never take a value) or as
// value-taking (--project, --tail: always consume the next token, or the
// text after `=`). Anything starting with `--` that is not declared throws
// UsageError, which main.ts's dispatch maps to exit 2; there is no silent
// fallthrough for an unrecognized flag.
//
// Single-dash tokens are flags too (issue #97): `hobby logs -h` used to
// send `-h` to the daemon as a target, and `hobby ls -j` ignored `-j`. The
// only short flag is `-h`, an alias for `--help`; every other `-x` is an
// unknown flag. A negative number (`-5`) stays a positional, since it is a
// value and nothing here declares short flags that could collide with one.
export function parseArgs(args: string[], spec: FlagSpec): ParsedArgs {
  const boolFlags = new Set(spec.bool ?? [])
  const valueFlags = new Set(spec.value ?? [])
  const multiFlags = new Set(spec.multi ?? [])
  const positionals: string[] = []
  const flags: Record<string, string | boolean | string[]> = {}

  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string
    if (!arg.startsWith('--')) {
      if (arg.length > 1 && arg.startsWith('-') && !/^-\d/.test(arg)) {
        if (arg === '-h') {
          flags.help = true
          continue
        }
        throw new UsageError(`unknown flag: ${arg}`)
      }
      positionals.push(arg)
      continue
    }

    const eqIndex = arg.indexOf('=')
    const name = eqIndex === -1 ? arg.slice(2) : arg.slice(2, eqIndex)

    if (boolFlags.has(name)) {
      if (eqIndex !== -1) {
        throw new UsageError(`--${name} does not take a value`)
      }
      flags[name] = true
      continue
    }

    if (valueFlags.has(name)) {
      if (eqIndex !== -1) {
        flags[name] = arg.slice(eqIndex + 1)
        continue
      }
      const next = args[i + 1]
      if (next === undefined) {
        throw new UsageError(`--${name} requires a value`)
      }
      flags[name] = next
      i++
      continue
    }

    if (multiFlags.has(name)) {
      let value: string
      if (eqIndex !== -1) {
        value = arg.slice(eqIndex + 1)
      } else {
        const next = args[i + 1]
        if (next === undefined) {
          throw new UsageError(`--${name} requires a value`)
        }
        value = next
        i++
      }
      const existing = flags[name]
      flags[name] = Array.isArray(existing) ? [...existing, value] : [value]
      continue
    }

    throw new UsageError(`unknown flag: --${name}`)
  }

  return { positionals, flags }
}

// One row per usage line of `hobby --help`: the verb it belongs to, the
// invocation, and what it does. A table rather than a run of io.out calls
// because `hobby <verb> --help` and `hobby help <verb>` (issue #96) print the
// rows for one verb, and a second copy of the text per verb would drift from
// the first. site/scripts/check-cli-reference.mjs parses the verb column out
// of this source to check the CLI reference page documents every verb, so
// the shape of each row (`['verb', 'hobby verb ...', '...']`) is load-bearing.
const USAGE: ReadonlyArray<readonly [verb: string, usage: string, what: string]> = [
  ['init', 'hobby init', 'prepare the host, check the filesystem'],
  ['daemon', 'hobby daemon', 'run the daemon in the foreground'],
  ['new', 'hobby new <name>', 'project + postgres + connection string'],
  ['new', 'hobby new <name> --empty', 'a project with nothing in it'],
  ['new', 'hobby new <name> --pin', 'born pinned: never auto-sleeps'],
  ['ls', 'hobby ls', 'everything, with sleep state'],
  ['branch', 'hobby branch <project> <name>', 'a new project from a copy of its data, unpinned'],
  ['branch', 'hobby branch ... --allow-pause', 'accept pausing a pinned, awake source'],
  ['deploy', 'hobby deploy [path]', 'build a Dockerfile here and serve it'],
  ['deploy', 'hobby deploy [path] --database <r>', 'the same, bound to a sibling database'],
  ['deploy', 'hobby deploy [path] --env-file <f>', 'the same, with variables from a dotenv file'],
  ['deploy', 'hobby deploy [path] --env K=V', 'the same, with one variable (repeatable)'],
  ['deploy', 'hobby deploy [path] --project <p> --name <n>', 'pick the project and resource name'],
  ['deploy', 'hobby deploy [path] --kind app|worker', 'when the directory holds both kinds of config'],
  ['deploy', 'hobby deploy <root> --dockerfile <f> --name <n>', 'an app from a monorepo: root as context, one Dockerfile each'],
  ['deploy', 'hobby deploy [path] --build-arg K=V', 'a docker build argument (repeatable)'],
  ['deploy', 'hobby deploy <dir> --context <root>', 'a worker inside a workspace: install from the root'],
  ['deploy', 'hobby deploy [path] --verbose', 'the same, printing the build output when it succeeds too'],
  ['create', 'hobby create <kind> <name> --project <p>', 'a resource with no code yet'],
  ['env', 'hobby env set <target> K=V...', 'set variables on an app or worker, applied on its next wake'],
  ['env', 'hobby env set <target> --env-file <f>', 'the same, from a dotenv file'],
  ['env', 'hobby env ls <target>', 'its variable names (never the values)'],
  ['env', 'hobby env unset <target> K...', 'remove variables'],
  ['pg', 'hobby pg create --project <p> <name>', 'the explicit form, for a second database'],
  ['connect', 'hobby connect <target>', 'open psql against it'],
  ['sleep', 'hobby sleep <target> [--force]', 'put it to sleep; --force ends open sessions and in-flight work'],
  ['wake', 'hobby wake <target>', 'wake it back up'],
  ['pin', 'hobby pin <project>', 'never auto-sleep this project'],
  ['unpin', 'hobby unpin <project> [--sleep-after N]', 'auto-sleep it again'],
  ['logs', 'hobby logs <target> [--tail N]', 'tail its logs'],
  ['rm', 'hobby rm <target> [--yes]', 'destroy, with confirmation'],
  ['eject', 'hobby eject <project>', 'emit docker-compose.yml plus data'],
  ['eject', 'hobby eject <project> --release', 'the same, and stop managing it'],
  ['adopt', 'hobby adopt <project>', 'manage a released project again'],
  ['snapshot', 'hobby snapshot <project> [--allow-pause]', 'a local snapshot, everything quiesced'],
  ['snapshot', 'hobby snapshot <project> --online', 'postgres-only projects: no pause, pg_basebackup'],
  ['snapshot', 'hobby snapshot ls <project>', 'its snapshots, newest first'],
  ['snapshot', 'hobby snapshot restore <project> <id> [--as <name>]', 'into a new project, original untouched'],
  ['snapshot', 'hobby snapshot restore <project> <id> --in-place [--yes]', 'replace its data, old data kept until it works'],
  ['snapshot', 'hobby snapshot rm <project> <id> [--yes]', 'delete one, with confirmation'],
  ['queue', 'hobby queue ls [project]', 'list queues, with depth and consumer'],
  ['queue', 'hobby queue create <name> --project <p>', 'a queue with no consumer bound yet'],
  ['queue', 'hobby queue peek <target> [--limit n]', 'the oldest messages, without leasing them'],
  ['queue', 'hobby queue send <target> <json>', 'enqueue one message'],
  ['queue', 'hobby queue purge <target>', 'delete every message, with confirmation'],
  ['queue', 'hobby queue rm <target> [--yes]', 'destroy the queue, with confirmation'],
  ['queue', 'hobby queue set <target> --retention <seconds>', 'change how long messages are kept'],
  ['cron', 'hobby cron ls [project]', 'worker cron triggers, with next and last firing'],
  ['login', 'hobby login <url>', 'connect this machine to a box'],
  ['logout', 'hobby logout [url]', 'forget a box'],
  ['remote', 'hobby remote ls', 'which boxes this machine knows'],
  ['link', 'hobby link <project>', 'point this directory at a project'],
  ['token', 'hobby token create <name>', 'a token for another machine'],
  ['token', 'hobby token ls', 'tokens this box has issued'],
  ['token', 'hobby token rm <name>', 'revoke one'],
  ['update', 'hobby update', 'update to the latest release'],
  ['update', 'hobby update --check', 'say whether one is available, change nothing'],
  ['studio', 'hobby studio passwd', 'set the studio operator password'],
  ['studio', 'hobby studio', 'print the studio URL and open it'],
  ['version', 'hobby version', 'this CLI and the daemon it talks to'],
  ['help', 'hobby help [verb]', 'this, or one verb in detail'],
]

const USAGE_COLUMN = 52

function usageLine(usage: string, what: string): string {
  return `  ${usage.padEnd(USAGE_COLUMN)} ${what}`
}

function printConventions(io: Io): void {
  io.out('<target> is `project` when the project has one resource, `project/resource` otherwise.')
  io.out('in a directory linked with `hobby link`, a verb given no target acts on the linked project,')
  io.out('and a bare name is tried first as one of its resources.')
  io.out('every command that returns data supports --json. every verb accepts --help.')
}

function printHelp(io: Io): void {
  io.out('hobby: your postgres, your box, their convenience')
  io.out('')
  io.out('usage:')
  for (const [, usage, what] of USAGE) {
    io.out(usageLine(usage, what))
  }
  io.out('')
  printConventions(io)
}

export function knownVerbs(): string[] {
  return [...new Set(USAGE.map(([verb]) => verb))]
}

// `hobby <verb> --help`, `hobby <verb> -h` and `hobby help <verb>`: the rows
// for that one verb, and the conventions. An unknown verb is the same
// UsageError the dispatcher raises, so `hobby bogus --help` and `hobby bogus`
// disagree on nothing but the help text.
function printVerbHelp(io: Io, verb: string): void {
  const rows = USAGE.filter(([v]) => v === verb)
  if (rows.length === 0) {
    throw new UsageError(`unknown command: ${verb}`)
  }
  io.out('usage:')
  for (const [, usage, what] of rows) {
    io.out(usageLine(usage, what))
  }
  io.out('')
  printConventions(io)
}

function isHelpFlag(arg: string): boolean {
  return arg === '--help' || arg === '-h'
}

// Under --json the error is one JSON line on stderr in the daemon API's own
// envelope, `{"error":{"code","message","hint"}}` (HobbyError.toWire,
// packages/core/src/errors.ts), so a script parses failures the same way
// it parses the daemon's (issue #109). The exit code is unchanged either
// way. `json` is whether `--json` appears anywhere in argv rather than the
// verb's parsed flag, because the error may be the parse itself.
function handleError(err: unknown, io: Io, json: boolean): number {
  if (err instanceof DaemonUnreachableError) {
    const hint = 'is the daemon running? try `hobby init` then `hobby daemon`.'
    if (json) {
      io.err(errorEnvelope('daemon_unreachable', err.message, hint))
    } else {
      io.err(err.message)
      io.err(`hint: ${hint}`)
    }
    return EXIT_DAEMON_UNREACHABLE
  }
  if (err instanceof HobbyError) {
    if (json) {
      io.err(JSON.stringify(err.toWire()))
    } else {
      io.err(err.message)
      if (err.hint !== undefined) {
        io.err(`hint: ${err.hint}`)
      }
    }
    return exitCodeForError(err.code)
  }
  if (err instanceof UsageError) {
    io.err(json ? errorEnvelope('usage', err.message) : err.message)
    return EXIT_USAGE
  }
  const message = err instanceof Error ? err.message : String(err)
  io.err(json ? errorEnvelope('internal', message) : message)
  return EXIT_OPERATION_FAILED
}

export async function run(argv: string[], io: Io): Promise<number> {
  const json = argv.includes('--json')
  // Set inside the try once the local-only verbs are out of the way, and
  // read by the catch below to explain a rejected token (issue #113).
  let remote: RemoteCredential | null = null
  try {
    const [argv0, ...rest] = argv
    // `--version` is the spelling every other CLI answers to, so it is an
    // alias for the verb (issue #96).
    const cmd = argv0 === '--version' ? 'version' : argv0

    if (cmd === undefined) {
      printHelp(io)
      return EXIT_USAGE
    }
    if (cmd === '-h' || cmd === '--help') {
      printHelp(io)
      return 0
    }
    if (cmd === 'help') {
      const verb = rest[0]
      if (verb === undefined) {
        printHelp(io)
      } else {
        printVerbHelp(io, verb)
      }
      return 0
    }
    // Before the verb's own parseArgs, which would otherwise throw `unknown
    // flag: --help` for every verb (issue #96). Exact tokens only, so a
    // positional that merely contains the text is untouched.
    if (rest.some(isHelpFlag)) {
      printVerbHelp(io, cmd)
      return 0
    }

    const paths = resolvePaths(io.env)
    const config = resolveConfig({ env: io.env, cwd: io.cwd })

    // init and daemon never construct an Api: init has nothing to talk to
    // yet (see cmdInit's file comment in commands.ts), and daemon is the
    // thing that will eventually listen on that socket, not a client of it.
    if (cmd === 'init') {
      const { flags } = parseArgs(rest, { bool: ['json'] })
      return await cmdInit(io, paths, config, Boolean(flags.json))
    }
    if (cmd === 'daemon') {
      parseArgs(rest, {})
      return await cmdDaemon(io, paths, config)
    }
    // studio passwd never talks to the daemon (setOperatorPassword writes
    // straight to paths.home, see auth.ts), and bare `studio` only needs
    // paths and config to build the URL and check whether a credential
    // exists. Neither belongs after the api client is constructed, same
    // reasoning as init and daemon above.
    // Talk to no daemon: login is how a credential is obtained in the first
    // place, and logout and remote only touch local files.
    if (cmd === 'login') {
      const { positionals, flags } = parseArgs(rest, { bool: ['json'], value: ['name'] })
      return await cmdLogin(io, paths, positionals, flags)
    }
    if (cmd === 'logout') {
      const { positionals, flags } = parseArgs(rest, { bool: ['json'] })
      return cmdLogout(io, paths, positionals, flags)
    }
    if (cmd === 'remote') {
      const { positionals, flags } = parseArgs(rest, { bool: ['json'] })
      return cmdRemote(io, paths, positionals, flags)
    }

    // Local by definition: both manage this box's own files and neither
    // should ever be reachable with a token from another machine.
    // Read here, before the two verbs below, because both are local-only
    // operations that used to run silently against this machine while
    // every other verb went to the remote (issue #112).
    remote = activeRemote(paths, io.env)

    if (cmd === 'token') {
      const { positionals, flags } = parseArgs(rest, { bool: ['json'] })
      if (remote !== null) {
        const sub = positionals.join(' ')
        throw new HobbyError(
          'usage',
          `token management is local to the box that holds the tokens, and you are logged in to ${remote.url}`,
          `run \`hobby token ${sub}\` on that box, or \`hobby logout\` to manage this machine's tokens`
        )
      }
      return await cmdToken(io, paths, positionals, flags)
    }
    if (cmd === 'update') {
      const { flags } = parseArgs(rest, { bool: ['json', 'check'] })
      return await cmdUpdate(io, paths, flags)
    }

    if (cmd === 'studio') {
      // The subcommand is the first positional, not the first token, so
      // `hobby studio --json` is the verb with a flag rather than "unknown
      // studio subcommand: --json" (issue #109). passwd accepts --json and
      // prints nothing for it: it has no data, only a prompt.
      const { positionals, flags } = parseArgs(rest, { bool: ['json'] })
      const sub = positionals[0]
      if (sub === 'passwd') {
        if (positionals.length > 1) {
          throw new UsageError(`usage: hobby studio passwd (got: ${positionals.slice(1).join(' ')})`)
        }
        return await cmdStudioPasswd(io, paths)
      }
      if (sub !== undefined) {
        throw new UsageError(`unknown studio subcommand: ${sub}`)
      }
      return cmdStudio(io, paths, config, undefined, Boolean(flags.json), remote?.url ?? null)
    }

    // ADR 0018: the same Api over either transport. A configured remote wins;
    // with none, this is the unix socket exactly as before, so a local install
    // behaves identically to how it always has.
    const api = remote === null ? createApi(paths.socketPath) : createApi(createRemoteClient(remote.url, remote.token))
    const ctx: Ctx = { io, api, paths, config }

    switch (cmd) {
      case 'version': {
        const { flags } = parseArgs(rest, { bool: ['json'] })
        return await cmdVersion(ctx, flags)
      }
      case 'new': {
        const { positionals, flags } = parseArgs(rest, { bool: ['json', 'empty', 'pin'] })
        return await cmdNew(ctx, positionals, flags)
      }
      case 'branch': {
        const { positionals, flags } = parseArgs(rest, { bool: ['json', 'allow-pause'] })
        return await cmdBranch(ctx, positionals, flags)
      }
      case 'ls': {
        const { flags } = parseArgs(rest, { bool: ['json'] })
        return await cmdLs(ctx, flags)
      }
      case 'create': {
        const { positionals, flags } = parseArgs(rest, { bool: ['json'], value: ['project'] })
        return await cmdCreate(ctx, positionals, flags)
      }
      case 'pg': {
        const { positionals, flags } = parseArgs(rest, { bool: ['json'], value: ['project'] })
        return await cmdPg(ctx, positionals, flags)
      }
      case 'connect': {
        const { positionals, flags } = parseArgs(rest, { bool: ['json'] })
        return await cmdConnect(ctx, positionals, flags)
      }
      case 'sleep': {
        const { positionals, flags } = parseArgs(rest, { bool: ['json', 'force'] })
        return await cmdSleep(ctx, positionals, flags)
      }
      case 'wake': {
        const { positionals, flags } = parseArgs(rest, { bool: ['json'] })
        return await cmdWake(ctx, positionals, flags)
      }
      case 'pin': {
        const { positionals, flags } = parseArgs(rest, { bool: ['json'] })
        return await cmdPin(ctx, positionals, flags)
      }
      case 'unpin': {
        const { positionals, flags } = parseArgs(rest, { bool: ['json'], value: ['sleep-after'] })
        return await cmdUnpin(ctx, positionals, flags)
      }
      case 'logs': {
        const { positionals, flags } = parseArgs(rest, { bool: ['json'], value: ['tail'] })
        return await cmdLogs(ctx, positionals, flags)
      }
      case 'rm': {
        const { positionals, flags } = parseArgs(rest, { bool: ['json', 'yes'] })
        return await cmdRm(ctx, positionals, flags)
      }
      case 'deploy': {
        const { positionals, flags } = parseArgs(rest, {
          bool: ['json', 'verbose'],
          value: ['project', 'name', 'port', 'kind', 'database', 'env-file', 'dockerfile', 'context'],
          multi: ['env', 'build-arg'],
        })
        return await cmdDeploy(ctx, positionals, flags)
      }
      case 'cron': {
        const { positionals, flags } = parseArgs(rest, { bool: ['json'] })
        return await cmdCron(ctx, positionals, flags)
      }
      case 'env': {
        // One parseArgs for set / ls / unset, as `queue` and `snapshot` do:
        // cmdEnv reads the subcommand from the positionals.
        const { positionals, flags } = parseArgs(rest, { bool: ['json'], value: ['env-file'] })
        return await cmdEnv(ctx, positionals, flags)
      }
      case 'link': {
        const { positionals, flags } = parseArgs(rest, { bool: ['json'] })
        return await cmdLink(ctx, positionals, flags)
      }
      case 'adopt': {
        const { positionals, flags } = parseArgs(rest, { bool: ['json'] })
        return await cmdAdopt(ctx, positionals, flags)
      }
      case 'queue': {
        // One parseArgs call covering every `hobby queue <verb>` subcommand's
        // flags, the same shape `pg` already uses for its own `create`
        // subcommand: cmdQueue (commands.ts) reads positionals[0] as the verb
        // and dispatches from there, so this file does not need to know the
        // subcommand list to parse its flags.
        const { positionals, flags } = parseArgs(rest, {
          bool: ['json', 'yes'],
          value: ['project', 'limit', 'retention'],
        })
        return await cmdQueue(ctx, positionals, flags)
      }
      case 'snapshot': {
        // One parseArgs for every `hobby snapshot` shape, as `queue` does
        // above: cmdSnapshot (commands.ts) reads the subcommand from the
        // positionals. --in-place and --allow-pause are separate gates on
        // purpose: one says "replace my data", the other says "stopping a
        // pinned project is fine", and neither implies the other. --online
        // says "stop nothing", which is why it and --allow-pause refuse each
        // other (cmdSnapshotTake).
        const { positionals, flags } = parseArgs(rest, {
          bool: ['json', 'yes', 'in-place', 'allow-pause', 'online'],
          value: ['as'],
        })
        return await cmdSnapshot(ctx, positionals, flags)
      }
      case 'eject': {
        // --release is its own gate and there is no confirmation prompt, a
        // deliberate difference from `rm --yes`. Nothing is deleted: the data
        // directories survive and the compose file that restarts them is on
        // stdout in the same breath. A prompt would also have to be written to
        // stdout, straight into `hobby eject blog --release > docker-compose.yml`.
        const { positionals, flags } = parseArgs(rest, { bool: ['json', 'release'] })
        return await cmdEject(ctx, positionals, flags)
      }
      default: {
        io.err(`unknown command: ${cmd}`)
        printHelp(io)
        return EXIT_USAGE
      }
    }
  } catch (err) {
    // A revoked or expired token used to surface as a bare "authentication
    // required" (issue #113). Name the box and the way back in.
    if (remote !== null && err instanceof HobbyError && err.code === 'unauthorized') {
      return handleError(
        new HobbyError(
          'unauthorized',
          `${remote.url} rejected this machine's token (revoked on that box, or never valid there)`,
          `run \`hobby login ${remote.url}\` again to get a new one, or \`hobby logout\` to stop using that box`
        ),
        io,
        json
      )
    }
    return handleError(err, io, json)
  }
}

// Reads one line from a real terminal with local echo turned off: raw mode,
// so the tty driver never prints what is typed, and this function assembles
// the line itself one keystroke at a time instead of letting the terminal
// do it. Backspace edits the in-memory buffer; Ctrl+C aborts the same way a
// normal readline prompt would (SIGINT-like exit), rather than leaving raw
// mode engaged on the user's shell.
function readHiddenLine(): Promise<string> {
  return new Promise((resolve) => {
    const stdin = process.stdin
    let buf = ''

    const cleanup = (): void => {
      stdin.removeListener('data', onData)
      stdin.setRawMode?.(false)
      stdin.pause()
    }

    const onData = (chunk: Buffer): void => {
      for (const ch of chunk.toString('utf8')) {
        if (ch === '\n' || ch === '\r') {
          cleanup()
          process.stdout.write('\n')
          resolve(buf)
          return
        }
        if (ch === '\u0003') {
          // Ctrl+C: leave the terminal exactly as readline would on the
          // same key, rather than exiting with raw mode still engaged.
          cleanup()
          process.stdout.write('\n')
          process.exit(EXIT_OPERATION_FAILED)
        }
        if (ch === '\u007f' || ch === '\b') {
          buf = buf.slice(0, -1)
          continue
        }
        buf += ch
      }
    }

    stdin.setRawMode?.(true)
    stdin.resume()
    stdin.setEncoding('utf8')
    stdin.on('data', onData)
  })
}

// silent is only ever honored when connected to a real terminal: raw mode
// requires a tty, and piped input (a script, a test, `printf pw | hobby
// studio passwd`) has no echo to suppress in the first place.
//
// Both this and readHiddenLine above read process.stdin directly rather than
// through node:readline, and that is deliberate, not an avoidance of a
// standard library. `hobby studio passwd` needs two sequential reads in one
// process, and node's readline.Interface does not actually support that
// safely once stdin is not an interactive terminal: over a piped stream, all
// of stdin's bytes typically arrive in a single 'data' event, and readline
// eagerly turns every complete line it finds in that event into a 'line'
// event as it is parsed, independent of whether a question() call is
// currently awaiting one. question() attaches a ONE-TIME 'line' listener
// only for the duration of that call; a second line that readline already
// emitted before the second question() was ever called is gone, since
// nothing was listening for it at the moment it fired, and the second call
// then hangs forever (verified against this exact reproduction: piping two
// lines to two sequential `readline.createInterface(...).question()` calls,
// even reusing one interface, silently loses the second line every time).
// The buffer below is not layered on top of readline at all, so this
// failure mode does not exist: a line is only ever handed to a caller that
// actually asked for one, however many callers ask, in whatever order their
// bytes actually arrive.
const stdinState = {
  buffer: '',
  ended: false,
  attached: false,
  pending: [] as Array<(line: string) => void>,
}

function attachStdinBuffering(): void {
  if (stdinState.attached) {
    return
  }
  stdinState.attached = true
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', (chunk: string) => {
    stdinState.buffer += chunk
    drainPendingLineRequests()
  })
  process.stdin.on('end', () => {
    stdinState.ended = true
    drainPendingLineRequests()
  })
  process.stdin.resume()
}

function drainPendingLineRequests(): void {
  while (stdinState.pending.length > 0) {
    const newlineIndex = stdinState.buffer.indexOf('\n')
    if (newlineIndex === -1) {
      if (!stdinState.ended) {
        return
      }
      // EOF with no trailing newline: hand back whatever is left, once,
      // same as readline's own behavior on a final unterminated line.
      const resolve = stdinState.pending.shift()
      if (resolve === undefined) {
        return
      }
      const line = stdinState.buffer
      stdinState.buffer = ''
      resolve(line)
      continue
    }
    let line = stdinState.buffer.slice(0, newlineIndex)
    if (line.endsWith('\r')) {
      line = line.slice(0, -1)
    }
    stdinState.buffer = stdinState.buffer.slice(newlineIndex + 1)
    const resolve = stdinState.pending.shift()
    if (resolve === undefined) {
      return
    }
    resolve(line)
  }
}

// A real terminal in canonical (non-raw) mode already line-buffers and
// echoes on its own: the OS driver only delivers a 'data' event once Enter
// is pressed, with the typed line already in it, which is exactly what
// `rm`'s confirmation prompt wants (visible input, real backspace editing,
// no reason to reimplement either). Piped input arrives the same way this
// function is written to handle regardless: whatever bytes show up,
// whenever they show up, split into lines and handed out in order.
function readBufferedLine(): Promise<string> {
  attachStdinBuffering()
  return new Promise((resolve) => {
    stdinState.pending.push(resolve)
    drainPendingLineRequests()
  })
}

function realReadLine(opts?: ReadLineOptions): Promise<string> {
  if (opts?.silent === true && process.stdin.isTTY === true) {
    return readHiddenLine()
  }
  return readBufferedLine()
}

// The only function in this package that calls process.exit. Builds the
// one real, process-backed Io and hands it to run().
export function main(argv: string[]): void {
  const io: Io = {
    out(s: string): void {
      process.stdout.write(`${s}\n`)
    },
    err(s: string): void {
      process.stderr.write(`${s}\n`)
    },
    env: process.env,
    cwd: process.cwd(),
    readLine: realReadLine,
  }

  run(argv, io)
    .then((code) => process.exit(code))
    .catch((err: unknown) => {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`)
      process.exit(EXIT_OPERATION_FAILED)
    })
}

export { UsageError }
export type { Flags } from './commands.js'
