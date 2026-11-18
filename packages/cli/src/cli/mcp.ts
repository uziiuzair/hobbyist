// `hobby mcp`: the supported way to run the MCP server (issue #128). It runs
// under whatever runtime runs `hobby` (bun from install.sh, node from a
// checkout), so there is no second launcher to install and no `node` on
// PATH to depend on.
//
// @hobby.sh/mcp depends on this package (it builds its tools on the Api in
// client.ts), so this package cannot depend on it back: that would be a
// cycle in both package.json and the tsc project references. The server is
// loaded with a dynamic import of a specifier held in a variable, which tsc
// does not resolve, so the dependency exists only at run time, only for
// this one verb, and resolves through the workspace's node_modules exactly
// as `@hobby.sh/cli` resolves from the MCP package. A separate `hobby-mcp`
// shim from install.sh would also work, but it would be a second launcher
// for every install path to keep in step, and `hobby mcp` is the name a
// client config wants to hold anyway.
//
// Transport: the unix socket only, never the remote from `hobby login`.
// ADR 0018 says MCP "is unaffected and stays on the socket", so an active
// remote is named on stderr and otherwise ignored. stdout belongs to the
// MCP protocol from the moment this verb starts, so nothing here writes to
// io.out.

import type { Readable, Writable } from 'node:stream'
import { HobbyError } from '@hobby.sh/core'

// The slice of @hobby.sh/mcp this verb uses, declared here because the
// package is deliberately not a type-level dependency.
export interface McpModule {
  runStdioServer(opts: { socketPath: string; stdin?: Readable; stdout?: Writable }): Promise<{ closed: Promise<void> }>
}

export type McpLoader = () => Promise<McpModule>

const MCP_PACKAGE = '@hobby.sh/mcp'

export const loadMcpModule: McpLoader = async () => {
  const specifier: string = MCP_PACKAGE
  let mod: unknown
  try {
    mod = await import(specifier)
  } catch (err) {
    const code = (err as { code?: unknown } | null)?.code
    if (code === 'ERR_MODULE_NOT_FOUND' || code === 'MODULE_NOT_FOUND') {
      throw new HobbyError(
        'internal',
        `the MCP server package (${MCP_PACKAGE}) is not installed next to this CLI`,
        'run `hobby update`, or `npm run build` in a checkout, so packages/mcp is built'
      )
    }
    throw err
  }
  const run = (mod as { runStdioServer?: unknown }).runStdioServer
  if (typeof run !== 'function') {
    throw new HobbyError('internal', `${MCP_PACKAGE} does not export runStdioServer; it is older than this CLI`, 'run `hobby update`')
  }
  return mod as McpModule
}

export interface McpCommandOptions {
  socketPath: string
  // The URL of the active `hobby login` remote, or null.
  remoteUrl: string | null
  err: (s: string) => void
  load?: McpLoader
  stdin?: Readable
  stdout?: Writable
}

// Resolves with the exit code once the client hangs up.
export async function cmdMcp(opts: McpCommandOptions): Promise<number> {
  if (opts.remoteUrl !== null) {
    opts.err(
      `note: hobby mcp serves this machine's daemon over its unix socket, not ${opts.remoteUrl}. ` +
        'to drive that box from an agent, run hobby mcp on it (over ssh, for example).'
    )
  }
  const mod = await (opts.load ?? loadMcpModule)()
  const handle = await mod.runStdioServer({ socketPath: opts.socketPath, stdin: opts.stdin, stdout: opts.stdout })
  await handle.closed
  return 0
}
