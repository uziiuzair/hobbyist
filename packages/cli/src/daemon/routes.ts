// The exact route list from the task brief, dispatched by hand rather than
// through a framework (the global constraint is plain node:http, no web
// framework). Fixed, small and enumerable, a manual match is more legible
// here than a regex router would be, and it is the only place in the
// package that needs to know the URL shape at all.
//
// Every handler either returns a { status, body } pair or throws. dispatch
// never catches: handleRequest is the single place that turns a throw into
// a wire-shaped error response, so every route gets identical error
// handling for free and none of them can accidentally diverge from it.

import type { IncomingMessage, ServerResponse } from 'node:http'
import {
  DEFAULT_PORT_BIND,
  HobbyError,
  validateName,
  type PostgresResource,
  type Project,
  type Resource,
} from '@hobby.sh/core'
import { connectionString, createPostgres, runQuery } from '@hobby.sh/pg'
import { getOrCreateWake, type DaemonContext } from './context.js'
import { runPreflight } from './preflight.js'
import { toWireResource, toWireResources } from './wire.js'

interface RouteResult {
  status: number
  body: unknown
}

const MAX_BODY_BYTES = 64 * 1024
const DEFAULT_LOG_TAIL = 200

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    let settled = false

    const fail = (err: Error): void => {
      if (settled) return
      settled = true
      reject(err)
    }

    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        fail(new HobbyError('usage', 'request body too large', `limit is ${MAX_BODY_BYTES} bytes`))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })

    req.on('end', () => {
      if (settled) return
      if (chunks.length === 0) {
        settled = true
        resolve({})
        return
      }
      try {
        const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        settled = true
        resolve(parsed)
      } catch {
        fail(new HobbyError('usage', 'invalid JSON body', 'the request body must be valid JSON'))
      }
    })

    req.on('error', fail)
  })
}

function getProjectByNameOrThrow(ctx: DaemonContext, name: string): Project {
  const project = ctx.store.getProjectByName(name)
  if (project === null) {
    throw new HobbyError('project_not_found', `no project named ${name}`)
  }
  return project
}

function getResourceOrThrow(ctx: DaemonContext, id: string): Resource {
  const resource = ctx.store.getResource(id)
  if (resource === null) {
    throw new HobbyError('resource_not_found', `no resource with id ${id}`)
  }
  return resource
}

// The narrowing gate for the handful of routes that are genuinely
// Postgres-only: a connection string and an ad-hoc SQL query mean nothing
// for an app or a worker. Everything else in this file dispatches through
// the kind registry instead and never needs to know.
//
// `usage`, not `internal`: asking Studio for a connection string against an
// app is a reasonable mistake for a caller to make, and the message names
// the actual kind so the caller can see why.
function expectPostgres(resource: Resource, what: string): PostgresResource {
  if (resource.kind !== 'postgres') {
    throw new HobbyError(
      'usage',
      `resource ${resource.name} is a ${resource.kind}, and ${what} is only meaningful for a postgres resource`
    )
  }
  return resource
}

async function createProjectRoute(ctx: DaemonContext, req: IncomingMessage): Promise<Project> {
  const body = await readJsonBody(req)
  const name = isRecord(body) ? body['name'] : undefined
  if (typeof name !== 'string' || name.length === 0) {
    throw new HobbyError('usage', 'name is required', 'POST /v1/projects expects { "name": string }')
  }
  validateName(name)
  return ctx.store.createProject({ name, sleepAfterSeconds: ctx.config.sleepAfterSeconds })
}

async function getProjectRoute(ctx: DaemonContext, name: string): Promise<RouteResult> {
  const project = getProjectByNameOrThrow(ctx, name)
  const resources = ctx.store.listResources(project.id)
  return { status: 200, body: { project, resources: await toWireResources(ctx, resources) } }
}

// Best-effort teardown, same shape as destroyPostgres's own contract: every
// resource is deleted from the store regardless of whether its container or
// data directory actually came down cleanly (destroyPostgres guarantees
// that on its own), failures are collected rather than swallowed, and a
// single error naming all of them is thrown only after the project row
// itself is gone. Marking each resource `destroying` before tearing it down
// is what lets reconcile resume this exact operation if the daemon dies
// partway through it, see reconcile.ts.
async function deleteProjectRoute(ctx: DaemonContext, name: string): Promise<RouteResult> {
  const project = getProjectByNameOrThrow(ctx, name)
  const resources = ctx.store.listResources(project.id)
  const failures: string[] = []

  for (const resource of resources) {
    ctx.store.setResourceState(resource.id, 'destroying')
    try {
      await ctx.kinds.get(resource.kind).destroy(ctx, resource)
    } catch (err) {
      failures.push(`${resource.name}: ${errorMessage(err)}`)
    }
  }

  // The project's network goes with it. Nothing else ever removed one, so
  // every project ever created left a network behind on the box: harmless
  // individually, and a growing list in `docker network ls` that the user
  // cannot attribute to anything still running. Attempted after the
  // containers, because a network with an attached container cannot be
  // removed, and collected rather than thrown for the same reason as the
  // resource failures above.
  try {
    await ctx.runtime.removeNetwork(project.networkName)
  } catch (err) {
    failures.push(`remove network ${project.networkName}: ${errorMessage(err)}`)
  }

  ctx.store.deleteProject(project.id)

  if (failures.length > 0) {
    throw new HobbyError(
      'internal',
      `project ${name} was deleted, but ${failures.length} teardown step(s) did not complete cleanly: ${failures.join('; ')}`,
      'a container, network or data directory may still remain and may need manual cleanup'
    )
  }

  return { status: 200, body: { deleted: true } }
}

async function createResourceRoute(ctx: DaemonContext, req: IncomingMessage, projectName: string): Promise<Resource> {
  const project = getProjectByNameOrThrow(ctx, projectName)
  const body = await readJsonBody(req)
  const kind = isRecord(body) ? body['kind'] : undefined
  const name = isRecord(body) ? body['name'] : undefined

  if (kind !== 'postgres') {
    throw new HobbyError(
      'usage',
      `unsupported resource kind: ${String(kind)}`,
      'only "postgres" is supported in this milestone'
    )
  }
  if (typeof name !== 'string' || name.length === 0) {
    throw new HobbyError(
      'usage',
      'name is required',
      'POST /v1/projects/:name/resources expects { "kind": "postgres", "name": string }'
    )
  }

  return createPostgres(ctx, { project, name })
}

// The three lifecycle routes are kind-agnostic and were the last places in
// the daemon that named Postgres. `hobby rm`, `hobby sleep` and `hobby wake`
// now mean the same thing for a database, an app and a worker, which is what
// makes the wedge ("everything sleeps, everything wakes on demand") one
// mechanism rather than three.
async function destroyResourceRoute(ctx: DaemonContext, id: string): Promise<RouteResult> {
  const resource = getResourceOrThrow(ctx, id)
  ctx.store.setResourceState(resource.id, 'destroying')
  await ctx.kinds.get(resource.kind).destroy(ctx, resource)
  return { status: 200, body: { deleted: true } }
}

async function startResourceRoute(ctx: DaemonContext, id: string): Promise<RouteResult> {
  const resource = getResourceOrThrow(ctx, id)
  await ctx.kinds.get(resource.kind).start(ctx, resource)
  return { status: 200, body: { resource: await toWireResource(ctx, getResourceOrThrow(ctx, id)) } }
}

async function stopResourceRoute(ctx: DaemonContext, id: string): Promise<RouteResult> {
  const resource = getResourceOrThrow(ctx, id)
  await ctx.kinds.get(resource.kind).stop(ctx, resource)
  return { status: 200, body: { resource: await toWireResource(ctx, getResourceOrThrow(ctx, id)) } }
}

// Always rendered as though the client will reach it through the proxy
// (viaProxy: true), even though nothing in this task starts that proxy: the
// proxy's port is the one users are meant to keep using, wired or not, see
// packages/proxy/src/proxy.ts's ProxyDeps.database contract. Host is
// 127.0.0.1 because M1 only runs on one box the caller is already on;
// HobbyConfig has no field yet for an externally reachable host, and adding
// one is out of scope here.
function connectionRoute(ctx: DaemonContext, id: string): RouteResult {
  // Genuinely postgres-only, unlike the lifecycle routes above: there is no
  // such thing as a connection string for an app or a worker, and an app's
  // reachable address is its hostname, served over HTTP. Answered with
  // `usage` rather than `internal` because asking for one is a reasonable
  // mistake for a caller to make, not a bug in the daemon.
  const resource = expectPostgres(getResourceOrThrow(ctx, id), 'a connection string')
  const project = ctx.store.getProject(resource.projectId)
  if (project === null) {
    throw new HobbyError('internal', `resource ${id} has no owning project (project ${resource.projectId} is gone)`)
  }
  const value = connectionString(project, resource, {
    host: '127.0.0.1',
    proxyPort: ctx.config.proxyPort,
    viaProxy: true,
  })
  return { status: 200, body: { connectionString: value } }
}

async function logsRoute(ctx: DaemonContext, id: string, url: URL): Promise<RouteResult> {
  const resource = getResourceOrThrow(ctx, id)
  const tailParam = url.searchParams.get('tail')
  const parsedTail = tailParam === null ? Number.NaN : Number(tailParam)
  const tail = Number.isFinite(parsedTail) && parsedTail > 0 ? Math.floor(parsedTail) : DEFAULT_LOG_TAIL
  const logs = await ctx.runtime.logs(resource.config.containerName, { tail })
  return { status: 200, body: { logs } }
}

// A plain, literal rendering of what containerSpec (packages/pg/src/postgres.ts)
// actually asked Docker to create, not an aspiration: image, container name,
// the real generated credentials, the real host port and the real data
// directory. This is deliberately the whole implementation for this task:
// no side effects, nothing stopped, nothing deleted, no files written to
// disk. Real `hobby eject` (moving the daemon out of the way entirely) is
// portability/'s job and is not built here, see the task report.
function renderCompose(resources: PostgresResource[]): string {
  const lines: string[] = ['services:']
  for (const resource of resources) {
    const cfg = resource.config
    lines.push(`  ${resource.name}:`)
    lines.push(`    image: ${cfg.image}`)
    // Deliberately no container_name. Pinning it to the name Hobbyist uses
    // means the emitted file cannot start while Hobbyist still manages this
    // project, which is exactly the state eject leaves you in today. Verified
    // against real Docker: compose refuses with a name conflict, and the whole
    // point of eject is that the result stands on its own. Letting compose
    // derive the name costs nothing and makes the file genuinely independent.
    lines.push('    restart: unless-stopped')
    lines.push('    environment:')
    lines.push(`      POSTGRES_USER: ${cfg.superuser}`)
    // The second, deliberate place the real password crosses the wire (see
    // wire.ts's own file comment): a docker-compose.yml with no working
    // password in it cannot start Postgres, which would make `hobby eject`
    // (CLAUDE.md's "you can always leave" promise, priority one of three)
    // hand back a file that lies about being able to stand alone. This is
    // not the resource-payload leak Item 1 closes, it is eject's entire
    // reason to exist.
    lines.push(`      POSTGRES_PASSWORD: ${cfg.password}`)
    lines.push(`      POSTGRES_DB: ${cfg.database}`)
    lines.push('    ports:')
    // With the same explicit loopback bind the daemon itself publishes this
    // container with (packages/core/src/docker.ts's buildCreateArgs, and
    // DEFAULT_PORT_BIND for why). This function's whole contract is that it
    // is a literal rendering of what Hobbyist actually asked Docker to
    // create, so a bare "25555:5432" here would hand the departing user a
    // compose file that publishes their database on every interface when
    // Hobbyist never did, at exactly the moment they stop having Hobbyist
    // to notice it for them.
    lines.push(`      - "${DEFAULT_PORT_BIND}:${cfg.hostPort}:5432"`)
    lines.push('    volumes:')
    // The postgres home directory, not PGDATA itself: postgres 18's image
    // refuses to start when the bind mount lands directly at
    // /var/lib/postgresql/data (see docs/decisions/0003's 2026-08-07
    // amendment). A compose file mounted at the old path would hand a
    // departing user a stack that exits 1 on `docker compose up`, which
    // would break eject's whole reason to exist.
    lines.push(`      - "${cfg.dataDir}:/var/lib/postgresql"`)
  }
  return `${lines.join('\n')}\n`
}

function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value)
}

// Studio's Tables, Sql and Schema views (packages/studio/src/api.ts's
// runQuery) all rest on this one route. Waking happens through
// getOrCreateWake(ctx), the exact same idempotent, single-flight function
// the wake-on-connect proxy itself uses (see context.ts's own comment):
// a sleeping resource is woken and this call waits for real readiness
// (startPostgres never resolves early, see packages/pg/src/postgres.ts)
// before the query is ever attempted, which is what makes Studio's waking
// banner honest rather than theatrical. A resource already `running` skips
// the wake entirely, the same guard the proxy's own handleStartup uses.
//
// params is always passed straight through to runQuery, which hands it to
// the driver's own parameterized query path; this function never touches
// the SQL string itself.
async function queryRoute(ctx: DaemonContext, req: IncomingMessage, id: string): Promise<RouteResult> {
  const resource = expectPostgres(getResourceOrThrow(ctx, id), 'running SQL')
  const body = await readJsonBody(req)
  const sql = isRecord(body) ? body['sql'] : undefined
  const rawParams = isRecord(body) ? body['params'] : undefined

  if (typeof sql !== 'string' || sql.length === 0) {
    throw new HobbyError(
      'usage',
      'sql is required',
      'POST /v1/resources/:id/query expects { "sql": string, "params"?: unknown[] }'
    )
  }
  if (rawParams !== undefined && !isUnknownArray(rawParams)) {
    throw new HobbyError(
      'usage',
      'params must be an array',
      'POST /v1/resources/:id/query expects { "sql": string, "params"?: unknown[] }'
    )
  }
  const params = rawParams ?? []

  if (resource.state !== 'running') {
    await getOrCreateWake(ctx)(resource.id)
  }

  // The resource may have been replaced or re-configured by the wake above
  // (it was not, in practice, startPostgres never touches config, but
  // re-reading is what the proxy's own handleStartup does after a wake and
  // matching that is cheap insurance against relying on a config snapshot
  // that raced a concurrent change).
  const ready = expectPostgres(getResourceOrThrow(ctx, id), 'running SQL')
  // A query is activity, exactly as much as a proxy connection is, and the
  // hibernator has to hear about it from here because nothing else will:
  // Studio's Tables, Sql and Schema views never open a proxy connection.
  // Marked before the query runs so a hibernator tick that starts while a
  // long query is in flight already sees the resource as active, and again
  // in the finally so the idle threshold is measured from when the query
  // finished rather than from when it started. The finally also covers a
  // failed query: a statement that errored is still someone using this
  // database right now.
  ctx.activity.touch(ready.id)
  try {
    const result = await runQuery(ready.config, sql, params)
    return { status: 200, body: result }
  } finally {
    ctx.activity.touch(ready.id)
  }
}

// Two calls in one route, and what `release` does NOT do is the design.
//
// Without `release` this is a pure read: a compose file rendered from real
// state, nothing written, nothing stopped, the project still managed. That
// stays the default, because the common use is looking at the file.
//
// With `release`, hobby stops acting on the project and keeps every record of
// it. Containers are stopped, the rows stay, the config stays, the credentials
// stay, the data directory is untouched, the network stays. The project is
// marked released and from then on hobby will not wake it, hibernate it, or
// reconcile it, because whatever the user started from that compose file now
// owns the data directory and two Postgres processes on one PGDATA is
// corruption. `hobby adopt` clears the mark and takes it back.
//
// An earlier version deleted the project instead. That was wrong for a reason
// worth writing down: --release is a flag someone types once, out of
// curiosity, on a project they care about, and if their export turns out to be
// botched there was no way back. Handing something over and destroying the
// only record of it are different operations, and only one of them is what
// this verb means. Deleting is what `hobby rm` is for, and it asks first.
//
// The compose file is still rendered before anything else runs, because it is
// rendered from the store rows, credentials included, and it is the artifact
// the whole call exists to produce.
async function ejectRoute(ctx: DaemonContext, name: string, release: boolean): Promise<RouteResult> {
  const project = getProjectByNameOrThrow(ctx, name)
  const resources = ctx.store.listResources(project.id)
  // Only postgres resources are rendered today. Emitting compose services for
  // `app` and `worker` is M8 and M9 respectively (see
  // docs/compute/specs/2026-08-10-phase-2-compute-design.md), and ADR 0007 is
  // explicit that a kind which cannot be ejected does not ship. Filtering
  // rather than throwing keeps eject working for the database half of a mixed
  // project; the count of skipped resources is reported so nobody reads an
  // incomplete compose file as a complete one.
  const postgresResources = resources.filter((r) => r.kind === 'postgres')
  const notEjectable = resources.filter((r) => r.kind !== 'postgres').map((r) => `${r.name} (${r.kind})`)
  const body = {
    compose: renderCompose(postgresResources),
    dataDirs: postgresResources.map((resource) => resource.config.dataDir),
    released: release,
    notEjectable,
  }

  if (!release) {
    return { status: 200, body }
  }

  // Stopped, not removed. A stopped container holds no port and no data
  // directory, so the compose file can start cleanly beside it, and leaving it
  // in place is what makes `hobby adopt` a state change rather than a rebuild.
  const failures: string[] = []
  for (const resource of resources) {
    if (resource.state !== 'running') continue
    try {
      await ctx.kinds.get(resource.kind).stop(ctx, resource)
    } catch (err) {
      failures.push(`${resource.name}: ${errorMessage(err)}`)
    }
  }

  ctx.store.setProjectReleased(project.id, new Date())

  if (failures.length > 0) {
    throw new HobbyError(
      'internal',
      `project ${name} is released, but ${failures.length} of its databases did not stop cleanly: ${failures.join('; ')}`,
      'nothing was deleted. Stop the container by hand before starting the compose file, so two postgres processes cannot open the same data directory'
    )
  }

  return { status: 200, body }
}

// The other direction. Nothing to rebuild and nothing to restore: the rows
// never went anywhere, so taking a project back is one column changing.
function adoptRoute(ctx: DaemonContext, name: string): RouteResult {
  const project = getProjectByNameOrThrow(ctx, name)
  if (project.releasedAt == null) {
    throw new HobbyError(
      'conflict',
      `project ${name} was not released`,
      'hobby is already managing it'
    )
  }
  ctx.store.setProjectReleased(project.id, null)
  return { status: 200, body: { project: ctx.store.getProject(project.id) } }
}

async function dispatch(ctx: DaemonContext, req: IncomingMessage): Promise<RouteResult> {
  const method = req.method ?? 'GET'
  const url = new URL(req.url ?? '/', 'http://localhost')
  const segments = url.pathname.split('/').filter((segment) => segment.length > 0)

  if (segments[0] !== 'v1') {
    throw new HobbyError('usage', `unknown route: ${method} ${url.pathname}`)
  }

  if (method === 'GET' && segments.length === 2 && segments[1] === 'health') {
    return { status: 200, body: { status: 'ok' } }
  }

  if (method === 'GET' && segments.length === 2 && segments[1] === 'preflight') {
    return { status: 200, body: await runPreflight(ctx) }
  }

  if (segments[1] === 'projects') {
    if (segments.length === 2) {
      if (method === 'GET') return { status: 200, body: { projects: ctx.store.listProjects() } }
      if (method === 'POST') return { status: 201, body: { project: await createProjectRoute(ctx, req) } }
    }

    if (segments.length === 3) {
      const name = decodeURIComponent(segments[2] as string)
      if (method === 'GET') return await getProjectRoute(ctx, name)
      if (method === 'DELETE') return deleteProjectRoute(ctx, name)
    }

    if (segments.length === 4 && method === 'POST' && segments[3] === 'resources') {
      const name = decodeURIComponent(segments[2] as string)
      const resource = await createResourceRoute(ctx, req, name)
      return { status: 201, body: { resource: await toWireResource(ctx, resource) } }
    }

    if (segments.length === 4 && method === 'POST' && segments[3] === 'eject') {
      const name = decodeURIComponent(segments[2] as string)
      // Opt-in by an explicit query parameter: the destructive reading of a
      // verb is never the one a bare request gets.
      return await ejectRoute(ctx, name, url.searchParams.get('release') === 'true')
    }

    if (segments.length === 4 && method === 'POST' && segments[3] === 'adopt') {
      const name = decodeURIComponent(segments[2] as string)
      return adoptRoute(ctx, name)
    }
  }

  if (segments[1] === 'resources') {
    if (segments.length === 3) {
      const id = decodeURIComponent(segments[2] as string)
      if (method === 'GET') {
        return { status: 200, body: { resource: await toWireResource(ctx, getResourceOrThrow(ctx, id)) } }
      }
      if (method === 'DELETE') return destroyResourceRoute(ctx, id)
    }

    if (segments.length === 4) {
      const id = decodeURIComponent(segments[2] as string)
      const action = segments[3]
      if (method === 'POST' && action === 'start') return startResourceRoute(ctx, id)
      if (method === 'POST' && action === 'stop') return stopResourceRoute(ctx, id)
      if (method === 'GET' && action === 'connection') return connectionRoute(ctx, id)
      if (method === 'GET' && action === 'logs') return logsRoute(ctx, id, url)
      if (method === 'POST' && action === 'query') return queryRoute(ctx, req, id)
    }
  }

  throw new HobbyError('usage', `unknown route: ${method} ${url.pathname}`, 'see docs/cli/specs for the route list')
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(payload)
}

// The single place an unknown throw is turned into `internal` and logged
// with its stack. Every route above either returns a value or throws a
// HobbyError; anything else reaching here is, by definition, a bug, not an
// expected failure the caller can act on, so its detail is logged for
// whoever runs the daemon and never repeated back to the client.
function toHobbyError(err: unknown): HobbyError {
  if (err instanceof HobbyError) {
    return err
  }
  const detail = err instanceof Error ? (err.stack ?? err.message) : String(err)
  console.error(`daemon: unexpected error: ${detail}`)
  return new HobbyError('internal', 'internal error')
}

export async function handleRequest(ctx: DaemonContext, req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const result = await dispatch(ctx, req)
    sendJson(res, result.status, result.body)
  } catch (err) {
    const hobbyErr = toHobbyError(err)
    sendJson(res, hobbyErr.httpStatus, hobbyErr.toWire())
  }
}
