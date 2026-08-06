// The public surface of @hobby.sh/cli. Later tasks (the MCP server) import
// from here, never from packages/cli/src/daemon or packages/cli/src/cli
// files directly.

export * from './daemon/context.js'
export * from './daemon/server.js'
export * from './daemon/reconcile.js'
export * from './daemon/preflight.js'

// The command surface (task 5): run/main is the CLI's own entry point
// (bin/hobby.js calls main directly, not through this barrel, to avoid a
// needless extra hop), exported here too because a later consumer (the MCP
// server, task 5's sibling) wraps these same verbs and should never have to
// reimplement the daemon client or the exit-code table to do it.
// main.js re-exports UsageError and Flags from commands.js already (see
// that file), so commands.js's own members are re-exported by name here
// rather than with `export *`, which would otherwise collide on those two
// identifiers.
export * from './cli/main.js'
export * from './cli/exit.js'
export * from './cli/client.js'
export {
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
  connectionEnv,
  resolveTarget,
  type Ctx,
} from './cli/commands.js'
export * from './cli/output.js'
