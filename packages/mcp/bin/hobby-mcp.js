#!/usr/bin/env node
// The `hobby-mcp` binary. Deliberately not compiled TypeScript, same as
// packages/cli/bin/hobby.js: a thin, plain-JS shim outside src/test (so tsc
// never sees it) that loads the compiled server and connects it over
// stdio. Filesystem permissions on the unix socket are the whole
// authentication story here; there is no flag or env var this shim needs
// to parse.

import { runStdioServer } from '../dist/src/server.js'

runStdioServer().catch((err) => {
  process.stderr.write(`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`)
  process.exitCode = 1
})
