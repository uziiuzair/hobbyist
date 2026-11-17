// `hobby import <project>`: the client half of POST /v1/import
// (packages/cli/src/daemon/import.ts has the design).
//
// The source connection string is a credential, so it is never a positional
// argument: an argument lands in shell history, in `ps` output for every
// user on the machine while the command runs, and in whatever terminal
// recorder is watching. It comes from exactly one of three places, resolved
// here, on the client, so that a CLI logged in to a remote box (ADR 0018)
// reads the file or variable on the machine the person is typing at:
//
//   stdin             the default; a hidden prompt on a terminal, or a pipe
//                     (`pbpaste | hobby import blog`, `op read ... | hobby import blog`)
//   --from-file PATH  the whole file, trimmed: a file you wrote with chmod 600
//   --from-env NAME   the value of one environment variable, by name
//
// resolveImportSource is shared with the MCP server (packages/mcp), which
// offers the file and variable forms and never a literal string, so a model
// driving it never has to see the password. Nothing here ever prints the
// value, and no error quotes it: a message names the variable or the path.

import { readFile } from 'node:fs/promises'
import { HobbyError } from '@hobby.sh/core'
import type { ImportReport } from '../daemon/import.js'
import { formatBytes } from './output.js'
import type { Ctx, Flags } from './commands.js'
import { UsageError } from './commands.js'

// Environment variable names as POSIX shells accept them.
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

export interface SourceReference {
  fromEnv?: string
  fromFile?: string
}

export async function resolveImportSource(
  ref: SourceReference,
  env: NodeJS.ProcessEnv,
  readStdin: (() => Promise<string>) | null
): Promise<string> {
  if (ref.fromEnv !== undefined && ref.fromFile !== undefined) {
    throw new HobbyError('usage', 'give the source one way: --from-env or --from-file, not both')
  }
  if (ref.fromEnv !== undefined) {
    if (!ENV_NAME.test(ref.fromEnv)) {
      throw new HobbyError('usage', 'the environment variable name is not a valid name', 'pass the name, for example NEON_DATABASE_URL, not its value')
    }
    const value = env[ref.fromEnv]
    if (value === undefined || value.trim().length === 0) {
      throw new HobbyError('usage', `the environment variable ${ref.fromEnv} is not set or is empty`)
    }
    return value.trim()
  }
  if (ref.fromFile !== undefined) {
    let text: string
    try {
      text = await readFile(ref.fromFile, 'utf8')
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? 'unreadable'
      throw new HobbyError('usage', `could not read the source file ${ref.fromFile} (${code})`)
    }
    if (text.trim().length === 0) {
      throw new HobbyError('usage', `the source file ${ref.fromFile} is empty`)
    }
    return text.trim()
  }
  if (readStdin === null) {
    throw new HobbyError('usage', 'no source given', 'name a file or an environment variable that holds the connection string')
  }
  const line = (await readStdin()).trim()
  if (line.length === 0) {
    throw new HobbyError('usage', 'no source connection string on stdin', 'pipe it in, or use --from-file or --from-env')
  }
  return line
}

function list(value: Flags[string] | undefined): string[] {
  if (value === undefined || value === true || value === false) return []
  return Array.isArray(value) ? value : [value]
}

function stringFlag(flags: Flags, name: string): string | undefined {
  const value = flags[name]
  if (value === true) throw new UsageError(`--${name} needs a value`)
  return typeof value === 'string' ? value : undefined
}

export async function cmdImport(c: Ctx, positionals: string[], flags: Flags): Promise<number> {
  const project = positionals[0]
  if (project === undefined) {
    throw new UsageError(
      'usage: hobby import <project> [--from-file <path> | --from-env <NAME>] [--resource <name>] [--schema <s>...] [--exclude-schema <s>...] [--strict]'
    )
  }
  if (positionals.length > 1) {
    // Deliberately does not echo what was given: it is probably the
    // connection string, and it is already in this shell's history.
    throw new UsageError(
      'hobby import takes the connection string from stdin, --from-file or --from-env, never as an argument, ' +
        'because an argument lands in shell history and the process list. if you just typed one, it is in your shell history now: ' +
        'remove it from there and consider rotating that password'
    )
  }
  const fromEnv = stringFlag(flags, 'from-env')
  const fromFile = stringFlag(flags, 'from-file')
  const resource = stringFlag(flags, 'resource')
  const source = await resolveImportSource(
    { ...(fromEnv === undefined ? {} : { fromEnv }), ...(fromFile === undefined ? {} : { fromFile }) },
    c.io.env,
    async () => {
      c.io.err('source connection string (input hidden, one line):')
      return await c.io.readLine({ silent: true })
    }
  )
  const schemas = list(flags['schema'])
  const excludeSchemas = list(flags['exclude-schema'])
  if (!flags.json) {
    c.io.err(`importing into ${project}${resource === undefined ? '' : `/${resource}`}: dumping and restoring, this can take a while`)
  }
  const { import: report } = await c.api.importDatabase({
    project,
    source,
    ...(resource === undefined ? {} : { resource }),
    ...(schemas.length > 0 ? { schemas } : {}),
    ...(excludeSchemas.length > 0 ? { excludeSchemas } : {}),
    ...(flags.strict === true ? { strict: true } : {}),
  })
  if (flags.json) {
    c.io.out(JSON.stringify({ import: report }))
  } else {
    for (const line of renderImportReport(report)) c.io.out(line)
  }
  // Like pg_restore itself: a restore that skipped something is not a
  // clean success, though the data that did restore is there.
  return report.restore.errors > 0 ? 1 : 0
}

export function renderImportReport(report: ImportReport): string[] {
  const lines: string[] = []
  const created = report.created === null ? '' : ` (new ${report.created})`
  lines.push(`imported into ${report.project}/${report.resource}${created} in ${(report.durationMs / 1000).toFixed(1)}s`)
  lines.push(
    `  from      ${report.source.host}${report.source.database === null ? '' : `/${report.source.database}`}, PostgreSQL ${report.source.serverVersion}` +
      (report.source.bytes === null ? '' : `, ${formatBytes(report.source.bytes)}`)
  )
  lines.push(`  with      pg_dump ${report.pgDumpMajor} from ${report.image}`)
  lines.push(`  copied    ${report.tables} tables, about ${report.rows} rows, ${formatBytes(report.targetBytes)} on disk (dump ${formatBytes(report.dumpBytes)})`)
  if (report.extensions.copied.length > 0) {
    lines.push(`  ext       ${report.extensions.copied.join(', ')}`)
  }
  for (const ext of report.extensions.notCopied) {
    lines.push(`  not ext   ${ext.name} (schema ${ext.schema}${ext.shipped ? '' : ', not shipped by this image'})`)
  }
  if (report.restore.errors > 0) {
    lines.push(`  errors    ${report.restore.errors} from pg_restore:`)
    for (const message of report.restore.messages) lines.push(`    ${message}`)
  }
  for (const warning of report.warnings) lines.push(`warning: ${warning}`)
  return lines
}
