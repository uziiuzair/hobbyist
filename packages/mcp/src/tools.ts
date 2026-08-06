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

import { HobbyError, parseTarget, type Resource } from '@hobby.sh/core'
import { DaemonUnreachableError, resolveTarget, type Api } from '@hobby.sh/cli'

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

// Strips the plaintext superuser password out of a Resource before it
// leaves this package in any tool's output except hobby_connection_string.
// PostgresConfig.password (packages/core/src/types.ts) sits right next to
// every other field on a Resource, so every route that returns a Resource
// returns the password too; that is the known, separately-tracked leak the
// task brief describes. This does not fix the daemon's wire shape (out of
// scope here), it only keeps the MCP surface from repeating the leak in
// every tool that happens to echo back a resource.
function redactResource(resource: Resource): Resource {
  return {
    ...resource,
    config: {
      ...resource.config,
      password: '[redacted, call hobby_connection_string for the real value]',
    },
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

// Mirrors `hobby ls`: every project, with every resource's current state.
// getProject is called once per project because, same as cmdLs, no single
// route already returns "everything, with sleep state" in one call. Every
// resource is redacted; the whole point of a list is orientation, not
// credentials.
export async function listTool(api: Api): Promise<ToolResult> {
  return run(async () => {
    const { projects } = await api.listProjects()
    const details = await Promise.all(projects.map((project) => api.getProject(project.name)))
    return {
      projects: details.map(({ project, resources }) => ({
        project,
        resources: resources.map(redactResource),
      })),
    }
  })
}

// Mirrors `hobby new <name>`: create the project, create its `postgres`
// resource named `primary`, exactly like cmdNew (packages/cli/src/cli/commands.ts).
// Unlike cmdNew, this does not also fetch and return the connection string.
// That is a deliberate narrowing for this surface, not a semantic drift:
// the task's password decision says the password must be returned only
// from the dedicated connection endpoint (hobby_connection_string), so an
// agent using hobby_new gets the created project and resource (redacted)
// and a hint pointing at the tool that actually carries the credential.
export async function newTool(api: Api, args: NewArgs): Promise<ToolResult> {
  return run(async () => {
    const { project } = await api.createProject(args.name)
    const { resource } = await api.createResource(project.name, { kind: 'postgres', name: 'primary' })
    return {
      project,
      resource: redactResource(resource),
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
    return { resource: redactResource(result.resource) }
  })
}

// Mirrors `hobby wake <target>`: resolve to one resource, POST start.
export async function wakeTool(api: Api, args: TargetArgs): Promise<ToolResult> {
  return run(async () => {
    const { resource } = await resolveTarget(api, args.target)
    const result = await api.startResource(resource.id)
    return { resource: redactResource(result.resource) }
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
