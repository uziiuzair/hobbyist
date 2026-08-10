// The wire boundary for a Resource: what actually crosses the daemon's HTTP
// surface, as opposed to Resource itself (packages/core/src/types.ts),
// which stays the daemon's own internal, full-fidelity record, real
// password included. Every route response that carries a resource (see
// routes.ts's own comment enumerating them) is routed through
// toWireResource/toWireResources before it ever reaches sendJson, so there
// is exactly one place in the whole daemon that decides what a resource
// looks like once it leaves the process.
//
// Two edits from Resource, both deliberate:
//
//   - config.password is omitted, not blanked. A placeholder string is
//     still a field a client could plausibly try to connect with, and it
//     would silently turn back into a real leak if some future change ever
//     put a real value in its place without anyone noticing the type had
//     stopped meaning what it used to. Omitting the key entirely is the
//     only shape that cannot be misread as a working credential. The one
//     legitimate place the real password is still returned is
//     GET /v1/resources/:id/connection (connectionRoute in routes.ts),
//     which calls connectionString directly against the store's own
//     internal Resource and never goes through this file. `hobby eject`'s
//     rendered docker-compose.yml is a second, deliberate exception for a
//     different reason: see routes.ts's renderCompose comment and the task
//     report for why (a docker-compose.yml with no working password in it
//     is not the "you can always leave" promise CLAUDE.md makes, it is a
//     compose file that cannot actually start Postgres).
//
//   - sizeBytes and connectionCount are added: computed on every request,
//     never persisted. See size.ts for exactly how sizeBytes is decided
//     (and why a sleeping resource is never woken to answer it) and
//     activity.ts's ActivityTracker (packages/proxy) for connectionCount,
//     which is simply ctx.activity.count(resource.id), already free.

import type { AppConfig, PostgresConfig, Resource, ResourceConfig, WorkerConfig } from '@hobby.sh/core'
import type { DaemonContext } from './context.js'
import { resourceSize } from './size.js'

export type WirePostgresConfig = Omit<PostgresConfig, 'password'>
export type WireAppConfig = AppConfig
export type WireWorkerConfig = WorkerConfig
export type WireResourceConfig = WirePostgresConfig | WireAppConfig | WireWorkerConfig

export interface WireResource extends Omit<Resource, 'config'> {
  config: WireResourceConfig
  sizeBytes: number | null
  connectionCount: number
}

// What a redacted value reads as. A visible placeholder rather than a
// removed key, so a caller can still see that a variable is set without
// being handed its value.
const REDACTED = '<redacted>'

function redactValues(values: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.keys(values).map((key) => [key, REDACTED]))
}

// One place where a stored config becomes something safe to hand out. Phase 1
// had exactly one secret to strip, the generated superuser password. Phase 2
// adds two more, and they are worse in one specific way: an app's `env` and a
// worker's `vars` hold whatever the user put there, which in practice means
// third-party API keys.
//
// The threat is not Studio, whose caller already authenticated. It is
// everywhere a payload from this boundary ends up: `--json` output redirected
// to a file, shell history, CI logs, and agent transcripts. That is the same
// reasoning that put the password redaction here in the first place.
function redactConfig(kind: Resource['kind'], config: ResourceConfig): WireResourceConfig {
  if (kind === 'postgres') {
    const { password: _password, ...rest } = config as PostgresConfig
    return rest
  }
  if (kind === 'app') {
    const app = config as AppConfig
    return { ...app, env: redactValues(app.env) }
  }
  const worker = config as WorkerConfig
  return { ...worker, vars: redactValues(worker.vars) }
}

export async function toWireResource(ctx: DaemonContext, resource: Resource): Promise<WireResource> {
  const config = redactConfig(resource.kind, resource.config)
  const sizeBytes = await resourceSize(ctx, resource)
  const connectionCount = ctx.activity.count(resource.id)
  return { ...resource, config, sizeBytes, connectionCount }
}

export function toWireResources(ctx: DaemonContext, resources: Resource[]): Promise<WireResource[]> {
  return Promise.all(resources.map((resource) => toWireResource(ctx, resource)))
}
