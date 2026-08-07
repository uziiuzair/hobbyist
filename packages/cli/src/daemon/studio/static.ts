// Serves Studio's built bundle (packages/studio/dist, produced by
// `npm run build -w @hobby.sh/studio`) as static files, with an SPA fallback
// to index.html so a browser reload against a client-side hash route
// (packages/studio/src/lib/router.ts) still gets served rather than 404ing.
//
// This handler is deliberately reachable with no session, and that is not an
// oversight: Studio ships as one bundle. App.tsx statically imports every
// view (Login, Projects, Project, Tables, Sql, Schema, see
// packages/studio/src/App.tsx), there is no separate login-only chunk, so
// the login screen cannot render at all unless the whole bundle has already
// loaded before any session exists. The bundle itself carries no secret:
// every real read or write still goes through /v1/ or /studio/, which stay
// behind the exact same session gate they always have (see routes.ts's own
// handle()). This module never touches ctx.store, ctx.runtime or anything
// else a session is meant to protect; it only ever reads files out of one
// directory.
//
// Wired onto the loopback TCP listener only (server.ts's startDaemon, via
// createStudioApp in routes.ts). The unix socket never imports this file at
// all: it is the CLI and MCP surface, not Studio's, per routes.ts's own file
// header.

import { createReadStream, existsSync, statSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { dirname, extname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

// Nothing in this monorepo publishes @hobby.sh/cli standalone yet (the root
// CLAUDE.md's asset table: the @hobby.sh/* npm namespace is owned, nothing
// is published there). Today the daemon and Studio's built bundle are always
// sibling packages in the same checkout: packages/cli/dist/src/daemon/studio
// (this file, once compiled) and packages/studio/dist are five directories
// apart. That is what this resolves, by construction, from this module's own
// compiled location rather than from cwd (which the daemon has no control
// over: see cmdDaemon in cli/commands.ts). HOBBY_STUDIO_DIST overrides this
// for any layout that is not that, including tests, which point it at a
// small fixture directory rather than a real Vite build.
function defaultStudioDistDir(): string {
  const here = dirname(fileURLToPath(import.meta.url))
  return resolve(here, '..', '..', '..', '..', '..', 'studio', 'dist')
}

export function resolveStudioDistDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.HOBBY_STUDIO_DIST
  return override !== undefined && override.length > 0 ? resolve(override) : defaultStudioDistDir()
}

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
}

function contentTypeFor(path: string): string {
  return CONTENT_TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream'
}

// The only check that is actually correct here, and it is a check on the
// OUTPUT, not the input. Scanning the request path for literal ".." segments
// looks sufficient and is not: the caller passes already-normalized segments
// (routes.ts's pathSegments, which parses through WHATWG URL, so a raw ".."
// or a raw "%2e%2e" segment can never survive to reach this function, see
// that file's own comment on the bypass this already closed once). What can
// still reach here is a single segment that, once THIS function's own
// decodeURIComponent runs, turns into something containing "/" or "..": for
// example the literal segment text "a%2f..%2fb", which the URL parser leaves
// alone (it is not itself a dot-segment, so URL's own dot-segment removal
// never touches it) and which decodes here to "a/../b". Resolving the full
// candidate path and then checking it is still inside distRoot catches that
// case and every other encoding trick, because it does not matter how a path
// got constructed, only where it ends up.
function resolveWithinDist(distRoot: string, segments: string[]): string | null {
  const decoded = segments.map((segment) => {
    try {
      return decodeURIComponent(segment)
    } catch {
      return segment
    }
  })
  const candidate = resolve(distRoot, ...decoded)
  const rootWithSep = distRoot.endsWith(sep) ? distRoot : `${distRoot}${sep}`
  if (candidate !== distRoot && !candidate.startsWith(rootWithSep)) {
    return null
  }
  return candidate
}

function sendFile(res: ServerResponse, filePath: string): void {
  res.writeHead(200, { 'content-type': contentTypeFor(filePath) })
  createReadStream(filePath).pipe(res)
}

// The SPA fallback: index.html at distRoot, served whenever the requested
// path is not a real file under dist. packages/studio/src/lib/router.ts is
// hash-based specifically so this is correct with no history-mode rewrite
// rule to write (see that file's own comment): every real navigation target
// a browser ever requests by pathname is "/", the fragment (#/projects/blog)
// never reaches the server at all. This still matters for a bare reload at
// "/" and for any unrecognized path, so it is implemented rather than
// assumed away.
function sendIndex(res: ServerResponse, distRoot: string): boolean {
  const indexPath = join(distRoot, 'index.html')
  if (!existsSync(indexPath) || !statSync(indexPath).isFile()) {
    return false
  }
  sendFile(res, indexPath)
  return true
}

// Serves Studio's built bundle for a GET request whose normalized segments
// are neither /v1/... nor /studio/...: routes.ts's handle() has already
// tried both of those and is the only caller. Always sends a response and
// returns true, except for a non-GET method, which this never touches at
// all (there is nothing meaningful to serve a POST from a static directory,
// and returning false lets the caller decide, the same way router.dispatch's
// own false return works).
export function serveStudioStatic(
  req: IncomingMessage,
  res: ServerResponse,
  segments: string[],
  distRoot: string
): boolean {
  if ((req.method ?? 'GET') !== 'GET') {
    return false
  }

  const candidate = resolveWithinDist(distRoot, segments)
  if (candidate !== null && existsSync(candidate) && statSync(candidate).isFile()) {
    sendFile(res, candidate)
    return true
  }

  if (sendIndex(res, distRoot)) {
    return true
  }

  // Only reachable when even index.html is missing, i.e. `npm run build -w
  // @hobby.sh/studio` has never been run against this checkout. A 404 here
  // is honest about that rather than hanging or 500ing.
  res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
  res.end('studio has not been built: run `npm run build -w @hobby.sh/studio`')
  return true
}
