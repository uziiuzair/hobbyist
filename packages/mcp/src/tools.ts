// The tool surface itself: one function per CLI verb, each a thin wrapper
// over the same daemon Api the CLI uses (packages/cli/src/cli/client.ts).
// Deliberately free of any MCP SDK import. server.ts is the only file that
// knows about the protocol; this file knows about the daemon API and
// nothing else, which is what makes it testable with a fake Api and no
// stdio, no transport, no Docker, no network.
//
// The rule that defines this package (see CLAUDE.md and the task brief):
// this surface wraps the CLI and the daemon API, it never extends them.
// Every handler below either calls an existing Api method or resolveTarget,
// both already exercised by packages/cli/src/cli/commands.ts. No handler
// invents a new route or a new capability.

import { HobbyError, parseTarget } from '@hobby.sh/core'
import { DaemonUnreachableError, resolveQueueTarget, resolveTarget, type Api } from '@hobby.sh/cli'

// The MCP SDK's CallToolResult shape, reproduced by hand rather than
// imported, so this file has zero dependency on @modelcontextprotocol/sdk.
// server.ts's registered callbacks return exactly this shape already, no
// adapting needed.
export interface ToolTextContent {
  type: 'text'
  text: string
}

export interface ToolResult {
  [key: string]: unknown
  content: ToolTextContent[]
  isError?: boolean
}

function textResult(value: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] }
}

// The single place a thrown error becomes agent-readable text. HobbyError's
// code and message (and hint, when present) are always included verbatim:
// an agent that gets back an opaque "something went wrong" will retry the
// same call forever, per the task brief. DaemonUnreachableError is not a
// HobbyError (see client.ts's own comment on why), so it is handled
// separately with its own recognizable prefix.
function formatError(err: unknown): string {
  if (err instanceof HobbyError) {
    return err.hint === undefined ? `${err.code}: ${err.message}` : `${err.code}: ${err.message} (hint: ${err.hint})`
  }
  if (err instanceof DaemonUnreachableError) {
    return `daemon_unreachable: ${err.message}`
  }
  return err instanceof Error ? err.message : String(err)
}

async function run(fn: () => Promise<unknown>): Promise<ToolResult> {
  try {
    return textResult(await fn())
  } catch (err) {
    return { content: [{ type: 'text', text: formatError(err) }], isError: true }
  }
}

export interface ListArgs {
  [key: string]: never
}

export interface NewArgs {
  name: string
}

export interface TargetArgs {
  target: string
}

export interface LogsArgs {
  target: string
  tail?: number
}

export interface RmArgs {
  target: string
  confirm: boolean
}

export interface QueueLsArgs {
  project?: string
}

export interface QueueCreateArgs {
  project: string
  name: string
}

export interface QueuePeekArgs {
  target: string
  limit?: number
}

export interface QueueSendArgs {
  target: string
  body: unknown
  delaySeconds?: number
}

export interface QueuePurgeArgs {
  target: string
  confirm: boolean
}

export interface QueueRmArgs {
  target: string
  confirm: boolean
}

export interface QueueSetRetentionArgs {
  target: string
  retentionSeconds: number
}

// Mirrors `hobby ls`: every project, with every resource's current state.
// getProject is called once per project because, same as cmdLs, no single
// route already returns "everything, with sleep state" in one call.
//
// No redaction happens in this file: every resource the daemon Api hands
// back is already the wire shape (WireResource, see
// packages/cli/src/daemon/wire.ts), which never carries a password field at
// all. This package used to blank it out a second time on its own; that is
// gone now that the daemon itself never sends it, per the task report on
// keeping the two redaction points consistent rather than one contradicting
// the other (a placeholder string would have re-added a `password` key the
// wire response no longer has).
export async function listTool(api: Api): Promise<ToolResult> {
  return run(async () => {
    const { projects } = await api.listProjects()
    const details = await Promise.all(projects.map((project) => api.getProject(project.name)))
    return {
      projects: details.map(({ project, resources }) => ({ project, resources })),
    }
  })
}

// Mirrors `hobby new <name>`: create the project, create its `postgres`
// resource named `primary`, exactly like cmdNew (packages/cli/src/cli/commands.ts).
// Unlike cmdNew, this does not also fetch and return the connection string.
// That is a deliberate narrowing for this surface, not a semantic drift:
// the task's password decision says the password must be returned only
// from the dedicated connection endpoint (hobby_connection_string), so an
// agent using hobby_new gets the created project and resource (already
// password-free, see listTool's comment above) and a hint pointing at the
// tool that actually carries the credential.
export async function newTool(api: Api, args: NewArgs): Promise<ToolResult> {
  return run(async () => {
    const { project } = await api.createProject(args.name)
    const { resource } = await api.createResource(project.name, { kind: 'postgres', name: 'primary' })
    return {
      project,
      resource,
      hint: `call hobby_connection_string with target "${project.name}" to get the connection string`,
    }
  })
}

// Mirrors `hobby connect <target>`'s data path (not its psql exec: an
// agent has no terminal to hand psql's stdio to). This is the only tool in
// the package that returns a real, working password, by design: see the
// task's connection-string decision. resolveTarget is the same ambiguity
// rule cmdConnect/cmdSleep/cmdWake/cmdLogs already use, reused rather than
// reimplemented.
export async function connectionStringTool(api: Api, args: TargetArgs): Promise<ToolResult> {
  return run(async () => {
    const { resource } = await resolveTarget(api, args.target)
    return await api.getConnection(resource.id)
  })
}

// Mirrors `hobby sleep <target>`: resolve to one resource, POST stop. The
// CLI's own comment on cmdSleepWake explains the sleep/wake vs start/stop
// naming split; this tool keeps the CLI's domain verb, the same as the CLI.
export async function sleepTool(api: Api, args: TargetArgs): Promise<ToolResult> {
  return run(async () => {
    const { resource } = await resolveTarget(api, args.target)
    const result = await api.stopResource(resource.id)
    return { resource: result.resource }
  })
}

// Mirrors `hobby wake <target>`: resolve to one resource, POST start.
export async function wakeTool(api: Api, args: TargetArgs): Promise<ToolResult> {
  return run(async () => {
    const { resource } = await resolveTarget(api, args.target)
    const result = await api.startResource(resource.id)
    return { resource: result.resource }
  })
}

// Mirrors `hobby logs <target> [--tail N]`. Logs are plain container
// output, not a Resource, so there is nothing to redact here; a superuser
// password could in principle appear in Postgres's own log lines (a bad
// query, a connection error), but that is a property of what Postgres
// chooses to log, not something this tool introduces or can filter, so no
// attempt is made to scrub it.
export async function logsTool(api: Api, args: LogsArgs): Promise<ToolResult> {
  return run(async () => {
    const { resource } = await resolveTarget(api, args.target)
    return await api.getLogs(resource.id, args.tail)
  })
}

// Mirrors `hobby rm <target> [--yes]`, with the interactive "type the name
// to confirm" prompt (cmdRm) replaced by a required `confirm: true`
// argument, since an MCP tool call has no terminal to read a line from.
// Without confirm === true this throws before making any Api call at all,
// which is what "issues no request at all" (task brief) means in practice:
// the check happens before resolveTarget, before parseTarget, before
// anything that would touch the daemon.
//
// Same project-vs-resource split as cmdRm: a bare project name deletes the
// whole project (every resource in it, best-effort, per routes.ts); a
// `project/resource` target deletes only that resource.
export async function rmTool(api: Api, args: RmArgs): Promise<ToolResult> {
  return run(async () => {
    if (args.confirm !== true) {
      throw new HobbyError(
        'usage',
        `hobby_rm refused: confirm must be true to delete "${args.target}"`,
        'this permanently destroys the project or resource, and its data, and cannot be undone; ' +
          'call hobby_rm again with confirm: true only once that is actually intended'
      )
    }

    const { project: projectName, resource: resourceName } = parseTarget(args.target)
    if (resourceName === null) {
      return await api.deleteProject(projectName)
    }
    const { resource } = await resolveTarget(api, args.target)
    return await api.deleteResource(resource.id)
  })
}

// ---------------------------------------------------------------------------
// Queue tools. Every one of these wraps the exact same daemon routes
// packages/cli/src/cli/commands.ts's `hobby queue` verbs already call,
// through the same resolveQueueTarget this package imports from @hobby.sh/cli
// rather than reimplementing: an agent and a human resolving "blog/jobs"
// must always land on the same resource.
// ---------------------------------------------------------------------------

// Mirrors `hobby queue ls [project]`: with a project, one call; without one,
// every project that has at least one queue. See cmdQueueLs's own comment
// (packages/cli/src/cli/commands.ts) for why an empty project is left out of
// the unscoped listing.
export async function queueListTool(api: Api, args: QueueLsArgs): Promise<ToolResult> {
  return run(async () => {
    const projectNames =
      args.project !== undefined ? [args.project] : (await api.listProjects()).projects.map((p) => p.name)
    const results: Array<{ project: string; queues: unknown }> = []
    for (const name of projectNames) {
      const { queues } = await api.listQueues(name)
      if (args.project === undefined && queues.length === 0) {
        continue
      }
      results.push({ project: name, queues })
    }
    return { projects: results }
  })
}

// Mirrors `hobby queue create <name> --project <p>`.
export async function queueCreateTool(api: Api, args: QueueCreateArgs): Promise<ToolResult> {
  return run(async () => {
    const { resource } = await api.createQueue(args.project, args.name)
    return { resource }
  })
}

// Mirrors `hobby queue peek <target> [--limit n]`: read-only, never leases.
export async function queuePeekTool(api: Api, args: QueuePeekArgs): Promise<ToolResult> {
  return run(async () => {
    const { resource } = await resolveQueueTarget(api, args.target)
    return await api.peekQueue(resource.id, args.limit)
  })
}

// Mirrors `hobby queue send <target> <json>`. `args.body` is already a
// parsed value (the MCP SDK hands tool arguments through as JSON, never as a
// string an agent would need to JSON.parse itself), so there is no
// client-side parse step to fail the way the CLI's own positional does.
export async function queueSendTool(api: Api, args: QueueSendArgs): Promise<ToolResult> {
  return run(async () => {
    const { resource } = await resolveQueueTarget(api, args.target)
    return await api.sendMessage(resource.id, { body: args.body, delaySeconds: args.delaySeconds })
  })
}

// Mirrors `hobby queue purge <target>`, with the same confirm: true
// requirement as hobby_rm and for the same reason: irreversible, and an
// agent has no terminal to type a queue name back into. Refuses, and makes
// no request to the daemon at all, without confirm === true.
export async function queuePurgeTool(api: Api, args: QueuePurgeArgs): Promise<ToolResult> {
  return run(async () => {
    if (args.confirm !== true) {
      throw new HobbyError(
        'usage',
        `hobby_queue_purge refused: confirm must be true to purge "${args.target}"`,
        'this permanently deletes every message currently in the queue and cannot be undone; ' +
          'call hobby_queue_purge again with confirm: true only once that is actually intended'
      )
    }
    const { resource } = await resolveQueueTarget(api, args.target)
    return await api.purgeQueue(resource.id)
  })
}

// Mirrors `hobby queue rm <target>`. Same confirm: true gate as hobby_rm and
// hobby_queue_purge; the underlying route (routes.ts's destroyResourceRoute)
// is what actually refuses a queue a worker still binds, so this tool adds
// nothing but resolution and the confirmation gate.
export async function queueRmTool(api: Api, args: QueueRmArgs): Promise<ToolResult> {
  return run(async () => {
    if (args.confirm !== true) {
      throw new HobbyError(
        'usage',
        `hobby_queue_rm refused: confirm must be true to delete "${args.target}"`,
        'this permanently destroys the queue and every message in it, and cannot be undone; ' +
          'call hobby_queue_rm again with confirm: true only once that is actually intended'
      )
    }
    const { resource } = await resolveQueueTarget(api, args.target)
    return await api.deleteResource(resource.id)
  })
}

// Mirrors `hobby queue set <target> --retention <seconds>`. Bounds are
// enforced by the daemon (routes.ts's setRetentionRoute), which returns a
// HobbyError naming them; formatError above already renders that verbatim,
// so an agent that guesses outside the range sees exactly why.
export async function queueSetRetentionTool(api: Api, args: QueueSetRetentionArgs): Promise<ToolResult> {
  return run(async () => {
    const { resource } = await resolveQueueTarget(api, args.target)
    return await api.setRetention(resource.id, args.retentionSeconds)
  })
}
