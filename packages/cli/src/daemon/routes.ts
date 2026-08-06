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
  HobbyError,
  validateName,
  type Project,
  type Resource,
} from '@hobby.sh/core'
import { connectionString, createPostgres, destroyPostgres, startPostgres, stopPostgres } from '@hobby.sh/pg'
import type { DaemonContext } from './context.js'
import { runPreflight } from './preflight.js'

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

async function createProjectRoute(ctx: DaemonContext, req: IncomingMessage): Promise<Project> {
  const body = await readJsonBody(req)
  const name = isRecord(body) ? body['name'] : undefined
  if (typeof name !== 'string' || name.length === 0) {
    throw new HobbyError('usage', 'name is required', 'POST /v1/projects expects { "name": string }')
  }
  validateName(name)
  return ctx.store.createProject({ name, sleepAfterSeconds: ctx.config.sleepAfterSeconds })
}

function getProjectRoute(ctx: DaemonContext, name: string): RouteResult {
  const project = getProjectByNameOrThrow(ctx, name)
  const resources = ctx.store.listResources(project.id)
  return { status: 200, body: { project, resources } }
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
      await destroyPostgres(ctx, resource)
    } catch (err) {
      failures.push(`${resource.name}: ${errorMessage(err)}`)
    }
  }

  ctx.store.deleteProject(project.id)

  if (failures.length > 0) {
    throw new HobbyError(
      'internal',
      `project ${name} was deleted, but ${failures.length} resource(s) did not tear down cleanly: ${failures.join('; ')}`,
      'a container or data directory may still remain on disk and may need manual cleanup'
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

async function destroyResourceRoute(ctx: DaemonContext, id: string): Promise<RouteResult> {
  const resource = getResourceOrThrow(ctx, id)
  ctx.store.setResourceState(resource.id, 'destroying')
  await destroyPostgres(ctx, resource)
  return { status: 200, body: { deleted: true } }
}

async function startResourceRoute(ctx: DaemonContext, id: string): Promise<RouteResult> {
  const resource = getResourceOrThrow(ctx, id)
  await startPostgres(ctx, resource)
  return { status: 200, body: { resource: getResourceOrThrow(ctx, id) } }
}

async function stopResourceRoute(ctx: DaemonContext, id: string): Promise<RouteResult> {
  const resource = getResourceOrThrow(ctx, id)
  await stopPostgres(ctx, resource)
  return { status: 200, body: { resource: getResourceOrThrow(ctx, id) } }
}

// Always rendered as though the client will reach it through the proxy
// (viaProxy: true), even though nothing in this task starts that proxy: the
// proxy's port is the one users are meant to keep using, wired or not, see
// packages/proxy/src/proxy.ts's ProxyDeps.database contract. Host is
// 127.0.0.1 because M1 only runs on one box the caller is already on;
// HobbyConfig has no field yet for an externally reachable host, and adding
// one is out of scope here.
function connectionRoute(ctx: DaemonContext, id: string): RouteResult {
  const resource = getResourceOrThrow(ctx, id)
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
function renderCompose(resources: Resource[]): string {
  const lines: string[] = ['services:']
  for (const resource of resources) {
    const cfg = resource.config
    lines.push(`  ${resource.name}:`)
    lines.push(`    image: ${cfg.image}`)
    lines.push(`    container_name: ${cfg.containerName}`)
    lines.push('    restart: unless-stopped')
    lines.push('    environment:')
    lines.push(`      POSTGRES_USER: ${cfg.superuser}`)
    lines.push(`      POSTGRES_PASSWORD: ${cfg.password}`)
    lines.push(`      POSTGRES_DB: ${cfg.database}`)
    lines.push('    ports:')
    lines.push(`      - "${cfg.hostPort}:5432"`)
    lines.push('    volumes:')
    lines.push(`      - "${cfg.dataDir}:/var/lib/postgresql/data"`)
  }
  return `${lines.join('\n')}\n`
}

function ejectRoute(ctx: DaemonContext, name: string): RouteResult {
  const project = getProjectByNameOrThrow(ctx, name)
  const resources = ctx.store.listResources(project.id)
  return {
    status: 200,
    body: {
      compose: renderCompose(resources),
      dataDirs: resources.map((resource) => resource.config.dataDir),
    },
  }
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
      if (method === 'GET') return getProjectRoute(ctx, name)
      if (method === 'DELETE') return deleteProjectRoute(ctx, name)
    }

    if (segments.length === 4 && method === 'POST' && segments[3] === 'resources') {
      const name = decodeURIComponent(segments[2] as string)
      return { status: 201, body: { resource: await createResourceRoute(ctx, req, name) } }
    }

    if (segments.length === 4 && method === 'POST' && segments[3] === 'eject') {
      const name = decodeURIComponent(segments[2] as string)
      return ejectRoute(ctx, name)
    }
  }

  if (segments[1] === 'resources') {
    if (segments.length === 3) {
      const id = decodeURIComponent(segments[2] as string)
      if (method === 'GET') return { status: 200, body: { resource: getResourceOrThrow(ctx, id) } }
      if (method === 'DELETE') return destroyResourceRoute(ctx, id)
    }

    if (segments.length === 4) {
      const id = decodeURIComponent(segments[2] as string)
      const action = segments[3]
      if (method === 'POST' && action === 'start') return startResourceRoute(ctx, id)
      if (method === 'POST' && action === 'stop') return stopResourceRoute(ctx, id)
      if (method === 'GET' && action === 'connection') return connectionRoute(ctx, id)
      if (method === 'GET' && action === 'logs') return logsRoute(ctx, id, url)
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
