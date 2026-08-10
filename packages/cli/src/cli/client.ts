// The CLI's only way to talk to the daemon: a plain node:http client bound
// to the unix socket at paths.socketPath. No fetch, no HTTP client
// dependency, since node:http already speaks unix sockets natively via the
// socketPath option and the daemon's whole API is small and JSON-shaped.
//
// Two layers: DaemonClient.request is the raw transport (method, path, body
// in; status and parsed body out, or a DaemonUnreachableError if nothing
// answered). Api is a typed wrapper, one function per route in
// packages/cli/src/daemon/routes.ts, that turns a >=400 response into a
// thrown HobbyError built from the wire error shape. Nothing above this
// file ever touches raw HTTP.

import http from 'node:http'
import { HobbyError, type ErrorCode, type Project } from '@hobby.sh/core'
import type { WireResource } from '../daemon/wire.js'

// Thrown when the socket does not exist, or exists but nothing answers on
// it (a stale file, or the daemon crashed). Deliberately not a HobbyError:
// HobbyError codes are things the daemon itself decided; this is a
// client-side condition the daemon never gets a chance to speak for, which
// is exactly why it maps to exit 5 rather than anything in exit.ts's
// ErrorCode table. main.ts is the only place that catches it.
export class DaemonUnreachableError extends Error {}

export interface RawResponse {
  status: number
  body: unknown
}

export interface DaemonClient {
  request(method: string, path: string, body?: unknown): Promise<RawResponse>
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

// A single attempt, no retry. A hung CLI waiting on a dead daemon is worse
// than a clear, immediate error, per the brief's explicit instruction not
// to retry silently.
export function createClient(socketPath: string): DaemonClient {
  return {
    request(method: string, path: string, body?: unknown): Promise<RawResponse> {
      return new Promise((resolve, reject) => {
        const payload = body === undefined ? undefined : JSON.stringify(body)
        const req = http.request(
          {
            socketPath,
            path,
            method,
            headers:
              payload === undefined
                ? {}
                : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) },
          },
          (res) => {
            const chunks: Buffer[] = []
            res.on('data', (chunk: Buffer) => chunks.push(chunk))
            res.on('end', () => {
              const text = Buffer.concat(chunks).toString('utf8')
              let parsed: unknown = {}
              if (text.length > 0) {
                try {
                  parsed = JSON.parse(text)
                } catch {
                  parsed = { error: { code: 'internal', message: 'the daemon returned a non-JSON body' } }
                }
              }
              resolve({ status: res.statusCode ?? 0, body: parsed })
            })
            res.on('error', (err) => {
              reject(new DaemonUnreachableError(`connection to the daemon dropped: ${errorMessage(err)}`))
            })
          }
        )

        // ENOENT (no socket file at all) and ECONNREFUSED (a stale file
        // nothing is listening on) both land here; neither is worth telling
        // apart for the user, both mean "there is no daemon to talk to
        // right now."
        req.on('error', (err) => {
          reject(new DaemonUnreachableError(`cannot reach the hobby daemon at ${socketPath}: ${errorMessage(err)}`))
        })

        if (payload !== undefined) {
          req.write(payload)
        }
        req.end()
      })
    },
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

// The inverse of HobbyError.toWire() in packages/core/src/errors.ts. Any
// error body that does not match that exact shape (should never happen
// against this daemon, but the client must not trust the wire blindly) is
// downgraded to a generic `internal`, the same way routes.ts's own
// toHobbyError downgrades an unexpected throw on the server side.
function toHobbyError(body: unknown): HobbyError {
  if (isRecord(body) && isRecord(body.error)) {
    const { code, message, hint } = body.error
    if (typeof code === 'string' && typeof message === 'string') {
      return new HobbyError(code as ErrorCode, message, typeof hint === 'string' ? hint : undefined)
    }
  }
  return new HobbyError('internal', 'the daemon returned an error response in an unrecognized shape')
}

async function call<T>(client: DaemonClient, method: string, path: string, body?: unknown): Promise<T> {
  const { status, body: responseBody } = await client.request(method, path, body)
  if (status >= 400) {
    throw toHobbyError(responseBody)
  }
  return responseBody as T
}

// Response envelopes, verbatim from the table in task-4-report.md and
// cross-checked against packages/cli/src/daemon/routes.ts. `Project` is
// reused directly from @hobby.sh/core for the shape of a single project;
// note that createdAt/lastActiveAt are typed as Date there but actually
// arrive as ISO strings once they have crossed the wire and been through
// JSON.parse. Nothing in this package calls a Date method on a value that
// came back from the client, specifically to avoid that mismatch ever
// mattering; see output.ts.
//
// A resource, unlike a project, is never core's own `Resource`: every route
// that hands one back sends the daemon's wire shape (see
// packages/cli/src/daemon/wire.ts), which strips config.password and adds
// sizeBytes/connectionCount. WireResource is that shape, typed here to
// match reality rather than the richer internal record the daemon actually
// holds.
export interface HealthResponse {
  status: string
}
export interface ProjectsResponse {
  projects: Project[]
}
export interface ProjectResponse {
  project: Project
}
export interface ProjectDetailResponse {
  project: Project
  resources: WireResource[]
}
export interface ResourceResponse {
  resource: WireResource
}
export interface DeletedResponse {
  deleted: true
}
export interface ConnectionResponse {
  connectionString: string
}
export interface LogsResponse {
  logs: string
}
export interface EjectResponse {
  compose: string
  dataDirs: string[]
  // True when this call also performed the handover: containers removed, the
  // network removed, the project forgotten, data left alone.
  released: boolean
  // A Caddyfile routing each ejected app's hostname to its published port.
  // Empty when the project has no apps. ADR 0009: an ejected app that no
  // longer serves is not an ejected app.
  caddyfile?: string
  // Resources this eject could not render, as "name (kind)". Reported rather
  // than silently dropped, so an incomplete compose file is never mistaken
  // for a complete one.
  notEjectable?: string[]
}

export interface Api {
  health(): Promise<HealthResponse>
  listProjects(): Promise<ProjectsResponse>
  createProject(name: string): Promise<ProjectResponse>
  getProject(name: string): Promise<ProjectDetailResponse>
  deleteProject(name: string): Promise<DeletedResponse>
  createResource(
    project: string,
    input:
      | { kind: 'postgres'; name: string }
      | {
          kind: 'app'
          name: string
          source?: { path: string; dockerfile?: string }
          image?: string
          port?: number
          env?: Record<string, string>
          databaseResourceId?: string
        }
  ): Promise<ResourceResponse>
  deployResource(
    id: string,
    input?: { source?: { path: string; dockerfile?: string } }
  ): Promise<ResourceResponse & { image: string; logs: string }>
  getResource(id: string): Promise<ResourceResponse>
  deleteResource(id: string): Promise<DeletedResponse>
  startResource(id: string): Promise<ResourceResponse>
  stopResource(id: string): Promise<ResourceResponse>
  getConnection(id: string): Promise<ConnectionResponse>
  getLogs(id: string, tail?: number): Promise<LogsResponse>
  eject(project: string, opts?: { release?: boolean }): Promise<EjectResponse>
  adopt(project: string): Promise<{ project: Project }>
}

export function createApi(socketPath: string): Api {
  const client = createClient(socketPath)
  const p = (segment: string): string => encodeURIComponent(segment)

  return {
    health: () => call(client, 'GET', '/v1/health'),
    listProjects: () => call(client, 'GET', '/v1/projects'),
    createProject: (name) => call(client, 'POST', '/v1/projects', { name }),
    getProject: (name) => call(client, 'GET', `/v1/projects/${p(name)}`),
    deleteProject: (name) => call(client, 'DELETE', `/v1/projects/${p(name)}`),
    createResource: (project, input) => call(client, 'POST', `/v1/projects/${p(project)}/resources`, input),
    deployResource: (id, input) => call(client, 'POST', `/v1/resources/${p(id)}/deploy`, input ?? {}),
    getResource: (id) => call(client, 'GET', `/v1/resources/${p(id)}`),
    deleteResource: (id) => call(client, 'DELETE', `/v1/resources/${p(id)}`),
    startResource: (id) => call(client, 'POST', `/v1/resources/${p(id)}/start`),
    stopResource: (id) => call(client, 'POST', `/v1/resources/${p(id)}/stop`),
    getConnection: (id) => call(client, 'GET', `/v1/resources/${p(id)}/connection`),
    getLogs: (id, tail) =>
      call(client, 'GET', `/v1/resources/${p(id)}/logs${tail === undefined ? '' : `?tail=${tail}`}`),
    eject: (project, opts) =>
      call(client, 'POST', `/v1/projects/${p(project)}/eject${opts?.release === true ? '?release=true' : ''}`),
    adopt: (project) => call(client, 'POST', `/v1/projects/${p(project)}/adopt`),
  }
}
