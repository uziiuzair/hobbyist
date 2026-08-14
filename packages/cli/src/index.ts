// The public surface of @hobby.sh/cli. Later tasks (the MCP server) import
// from here, never from packages/cli/src/daemon or packages/cli/src/cli
// files directly.

export * from './daemon/context.js'
export * from './daemon/server.js'
export * from './daemon/reconcile.js'
export * from './daemon/preflight.js'
export * from './daemon/hibernator.js'
export * from './daemon/caddy.js'
export * from './daemon/wire.js'

// Studio's server side (task 10): the operator credential, sessions, and
// the route-mounting/gate machinery the loopback TCP listener uses (see
// daemon/server.ts). Exported here, not just used internally, because
// `hobby studio passwd` is a CLI verb owned by packages/cli/src/cli (a
// different task) and must call setOperatorPassword from this same public
// surface rather than reaching into daemon/studio directly; see the task
// report for the exact call it needs to make.
export * from './daemon/studio/auth.js'
export * from './daemon/studio/session.js'
export * from './daemon/studio/routes.js'
export * from './daemon/studio/static.js'

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
  cmdCreate,
  cmdDaemon,
  cmdDeploy,
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
  connectionEnv,
  resolveTarget,
  type BrowserOpener,
  type Ctx,
} from './cli/commands.js'
export * from './cli/output.js'
