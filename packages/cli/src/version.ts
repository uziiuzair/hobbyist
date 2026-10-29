// The one place the CLI's own version is read, for `hobby version` and for
// the daemon's `GET /v1/health` body, which is how a client on another
// machine (ADR 0018) learns what it is talking to. Read from this package's
// package.json at load time rather than stamped by a build step, because
// there is no build step beyond tsc here (bin/hobby.js loads dist directly),
// and a constant somebody has to remember to bump alongside package.json is
// a constant that drifts.
//
// The relative path is from the compiled location, dist/src/version.js, two
// directories below the package root.

import { createRequire } from 'node:module'

const requireFromHere = createRequire(import.meta.url)
const pkg = requireFromHere('../../package.json') as { version?: unknown }

export const CLI_VERSION: string = typeof pkg.version === 'string' ? pkg.version : 'unknown'
