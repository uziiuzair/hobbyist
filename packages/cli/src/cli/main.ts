// The command surface's entry point. `run` parses argv, dispatches to one
// function per verb in commands.ts, and returns an exit code; it never
// touches process.exit, process.stdout, process.stderr or process.stdin
// directly; everything crosses the Io boundary, which is what makes this
// file testable without a real terminal. `main` is the only thing in this
// package allowed to call process.exit, and it is the only thing that
// constructs a real, process-backed Io.

import { createInterface } from 'node:readline/promises'
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
  cmdWake,
  UsageError,
  type Ctx,
  type Flags,
} from './commands.js'
import { EXIT_DAEMON_UNREACHABLE, EXIT_OPERATION_FAILED, EXIT_USAGE, exitCodeForError } from './exit.js'

export interface Io {
  out(s: string): void
  err(s: string): void
  env: NodeJS.ProcessEnv
  cwd: string
  // Reads one line from stdin. Used only by `rm`'s confirmation prompt, per
  // the brief's explicit instruction to read through Io rather than
  // process.stdin directly, so it can be faked in a test.
  readLine(): Promise<string>
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
        const { positionals, flags } = parseArgs(rest, { bool: ['json'] })
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

function realReadLine(): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  return rl.question('').finally(() => rl.close())
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
