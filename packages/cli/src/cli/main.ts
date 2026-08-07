// The command surface's entry point. `run` parses argv, dispatches to one
// function per verb in commands.ts, and returns an exit code; it never
// touches process.exit, process.stdout, process.stderr or process.stdin
// directly; everything crosses the Io boundary, which is what makes this
// file testable without a real terminal. `main` is the only thing in this
// package allowed to call process.exit, and it is the only thing that
// constructs a real, process-backed Io.

import { resolveConfig, resolvePaths, HobbyError } from '@hobby.sh/core'
import { createApi, DaemonUnreachableError } from './client.js'
import {
  cmdConnect,
  cmdDaemon,
  cmdEject,
  cmdInit,
  cmdLogs,
  cmdLs,
  cmdNew,
  cmdPg,
  cmdRm,
  cmdSleep,
  cmdStudio,
  cmdStudioPasswd,
  cmdWake,
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
  flags: Record<string, string | boolean>
}

export interface FlagSpec {
  bool?: string[]
  value?: string[]
}

// A hand-written parser, not a library, per the global constraint (no CLI
// framework). Each verb declares which flags it accepts as boolean
// (--json, --yes: present or absent, never take a value) or as
// value-taking (--project, --tail: always consume the next token, or the
// text after `=`). Anything starting with `--` that is not declared throws
// UsageError, which main.ts's dispatch maps to exit 2; there is no silent
// fallthrough for an unrecognized flag.
export function parseArgs(args: string[], spec: FlagSpec): ParsedArgs {
  const boolFlags = new Set(spec.bool ?? [])
  const valueFlags = new Set(spec.value ?? [])
  const positionals: string[] = []
  const flags: Record<string, string | boolean> = {}

  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string
    if (!arg.startsWith('--')) {
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

    throw new UsageError(`unknown flag: --${name}`)
  }

  return { positionals, flags }
}

function printHelp(io: Io): void {
  io.out('hobby: your postgres, your box, their convenience')
  io.out('')
  io.out('usage:')
  io.out('  hobby init                          prepare the host, check the filesystem')
  io.out('  hobby daemon                         run the daemon in the foreground')
  io.out('  hobby new <name>                     project + postgres + connection string')
  io.out('  hobby ls                             everything, with sleep state')
  io.out('  hobby pg create --project <p> <name> the explicit form, for a second database')
  io.out('  hobby connect <target>                open psql against it')
  io.out('  hobby sleep <target>                  put it to sleep')
  io.out('  hobby wake <target>                   wake it back up')
  io.out('  hobby logs <target> [--tail N]        tail its logs')
  io.out('  hobby rm <target> [--yes]              destroy, with confirmation')
  io.out('  hobby eject <project>                 emit docker-compose.yml plus data')
  io.out('  hobby eject <project> --release       the same, and stop managing it')
  io.out('  hobby studio passwd                   set the studio operator password')
  io.out('  hobby studio                          print the studio URL and open it')
  io.out('')
  io.out('<target> is `project` when the project has one resource, `project/resource` otherwise.')
  io.out('every command that returns data supports --json.')
}

function handleError(err: unknown, io: Io): number {
  if (err instanceof DaemonUnreachableError) {
    io.err(err.message)
    io.err('hint: is the daemon running? try `hobby init` then `hobby daemon`.')
    return EXIT_DAEMON_UNREACHABLE
  }
  if (err instanceof HobbyError) {
    io.err(err.message)
    if (err.hint !== undefined) {
      io.err(`hint: ${err.hint}`)
    }
    return exitCodeForError(err.code)
  }
  if (err instanceof UsageError) {
    io.err(err.message)
    return EXIT_USAGE
  }
  io.err(err instanceof Error ? err.message : String(err))
  return EXIT_OPERATION_FAILED
}

export async function run(argv: string[], io: Io): Promise<number> {
  try {
    const [cmd, ...rest] = argv

    if (cmd === undefined) {
      printHelp(io)
      return EXIT_USAGE
    }
    if (cmd === '-h' || cmd === '--help') {
      printHelp(io)
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
    if (cmd === 'studio') {
      const sub = rest[0]
      if (sub === 'passwd') {
        parseArgs(rest.slice(1), {})
        return await cmdStudioPasswd(io, paths)
      }
      if (sub !== undefined) {
        throw new UsageError(`unknown studio subcommand: ${sub}`)
      }
      parseArgs(rest, {})
      return cmdStudio(io, paths, config)
    }

    const api = createApi(paths.socketPath)
    const ctx: Ctx = { io, api, paths, config }

    switch (cmd) {
      case 'new': {
        const { positionals, flags } = parseArgs(rest, { bool: ['json'] })
        return await cmdNew(ctx, positionals, flags)
      }
      case 'ls': {
        const { flags } = parseArgs(rest, { bool: ['json'] })
        return await cmdLs(ctx, flags)
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
        const { positionals, flags } = parseArgs(rest, { bool: ['json'] })
        return await cmdSleep(ctx, positionals, flags)
      }
      case 'wake': {
        const { positionals, flags } = parseArgs(rest, { bool: ['json'] })
        return await cmdWake(ctx, positionals, flags)
      }
      case 'logs': {
        const { positionals, flags } = parseArgs(rest, { bool: ['json'], value: ['tail'] })
        return await cmdLogs(ctx, positionals, flags)
      }
      case 'rm': {
        const { positionals, flags } = parseArgs(rest, { bool: ['json', 'yes'] })
        return await cmdRm(ctx, positionals, flags)
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
    return handleError(err, io)
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
