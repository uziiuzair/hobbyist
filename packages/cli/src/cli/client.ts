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
//
// decision hobbyist.bound-every-outbound-call: checked here, per that
// decision's own instruction, before adding the queue methods below rather
// than after. This function has no request timeout today, and that gap is
// pre-existing and shared by every one of the 20-odd calls this file already
// makes (health, listProjects, deploy, and so on), not something the queue
// routes introduce. The new queue methods (listQueues, peekQueue,
// sendMessage, purgeQueue, setRetention) add no second transport and no
// second gap: they call the exact same request() above, over the same
// unix socket to the same box, so their blast radius if this socket ever
// hangs is identical to `hobby ls` hanging today, not a new failure mode.
// The routes those methods reach (packages/cli/src/daemon/routes.ts) make no
// outbound network call of their own either: enqueue, peek and purge are
// synchronous sqlite operations, the same shape as every other route in that
// file. Giving this transport a timeout is a real gap worth closing, but
// doing it here would silently change the failure mode of every existing
// command in one diff meant to add queue support, which is a different,
// riskier change than this task asked for.
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
  // Null when the box has no running tailscaled; absent entirely from a
  // daemon older than this field, so callers treat undefined as null.
  tailnetConnectionString?: string | null
}
export interface LogsResponse {
  logs: string
}
// One entry per queue, from GET /v1/projects/:name/queues. `consumer` is the
// full WireResource of whatever consumerResourceId points at, or null:
// carrying the whole resource (not just a name) is what lets output.ts read
// `consumer.config.manifest === null` and print "(no code yet)" using the
// exact same fact `hobby ls` already renders for an undeployed worker,
// rather than a second, possibly-drifting signal invented for this table.
export interface QueueListEntry {
  resource: WireResource
  depth: number
  oldestMessageAgeSeconds: number | null
  consumer: WireResource | null
}
export interface QueueListResponse {
  queues: QueueListEntry[]
}
// A peeked message, body already decoded (see routes.ts's decodeMessageBody):
// neither the CLI nor MCP ever has to know this queue's on-disk codec.
export interface QueueMessage {
  id: string
  timestampMs: number
  attempts: number
  contentType: string
  body: unknown
}
export interface QueuePeekResponse {
  messages: QueueMessage[]
}
export interface QueueSendResponse {
  id: string
}
export interface QueuePurgeResponse {
  purged: number
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
  // Resources this eject could not render, one message per resource. Two
  // distinct reasons land here: a kind eject has never learned to emit at all
  // ("name (kind)"), and an app or worker with no image because it has never
  // been deployed ("name: never deployed, so there is no image to run", see
  // routes.ts's isDeployed). Reported rather than silently dropped either
  // way, so an incomplete compose file is never mistaken for a complete one.
  notEjectable?: string[]
  // Every queue in the project, backlog included: `jsonl` is the whole
  // handover for that queue, one JSON object per line (id, body, attempts,
  // enqueuedAt), decoded rather than left as @hobby.sh/queue's codec-encoded
  // string (routes.ts's toBacklogLine explains why: this file's reader has
  // no hobbyist installation left to decode it with). Present with `count: 0`
  // and `jsonl: ''` for a queue holding nothing, never omitted, so a missing
  // entry always means "no such queue," never "hobby forgot."
  queues?: Array<{ name: string; jsonl: string; count: number }>
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
      | {
          kind: 'worker'
          name: string
          // Absent for a sourceless create (packages/cli/src/daemon/routes.ts's
          // createResourceRoute: readAppSource returns null when the field is
          // missing, and createWorkerResource, packages/worker/src/worker.ts,
          // accepts sourcePath: null and produces an `undeployed` row). Not
          // required the way it once was, now that a project can hold a
          // worker with no code yet.
          source?: { path: string }
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
  // Queue routes. `id` is always a resource id, not a name: resolveQueueTarget
  // (packages/cli/src/cli/commands.ts) turns a CLI `project`/`project/name`
  // target into one before any of these are called, the same resolution
  // sleep/wake/logs already go through for every other kind.
  listQueues(project: string): Promise<QueueListResponse>
  createQueue(project: string, name: string): Promise<ResourceResponse>
  peekQueue(id: string, limit?: number): Promise<QueuePeekResponse>
  sendMessage(id: string, input: { body: unknown; delaySeconds?: number }): Promise<QueueSendResponse>
  purgeQueue(id: string): Promise<QueuePurgeResponse>
  setRetention(id: string, retentionSeconds: number): Promise<ResourceResponse>
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
    listQueues: (project) => call(client, 'GET', `/v1/projects/${p(project)}/queues`),
    createQueue: (project, name) => call(client, 'POST', `/v1/projects/${p(project)}/resources`, { kind: 'queue', name }),
    peekQueue: (id, limit) =>
      call(client, 'GET', `/v1/resources/${p(id)}/queue/messages${limit === undefined ? '' : `?limit=${limit}`}`),
    sendMessage: (id, input) => call(client, 'POST', `/v1/resources/${p(id)}/queue/messages`, input),
    purgeQueue: (id) => call(client, 'DELETE', `/v1/resources/${p(id)}/queue/messages`),
    setRetention: (id, retentionSeconds) =>
      call(client, 'POST', `/v1/resources/${p(id)}/queue/retention`, { retentionSeconds }),
  }
}
