// Wires tools.ts's pure handlers into an MCP server over stdio. This file,
// not tools.ts, is the one place that knows about @modelcontextprotocol/sdk:
// it owns the zod input schemas (the SDK's own shape for a tool's
// parameters), tool descriptions, and the stdio transport. Nothing here
// talks to the daemon directly; every call goes through the same Api
// (packages/cli/src/cli/client.ts) the CLI uses, reached over the unix
// socket at paths.socketPath. There is no token, no port, no credential to
// leak here: filesystem permissions on that socket are the whole
// authentication story, per docs/mcp/CLAUDE.md.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { resolvePaths } from '@hobby.sh/core'
import { createApi, type Api } from '@hobby.sh/cli'
import { z } from 'zod'
import { connectionStringTool, listTool, logsTool, newTool, rmTool, sleepTool, wakeTool } from './tools.js'

const TARGET_DESCRIPTION =
  'a project name, or "project/resource" when the project has more than one resource. ' +
  'a bare project name is only valid when that project has exactly one resource.'

// Builds the server and registers every tool against a given Api, so tests
// can build one against a fake Api without ever binding stdio. The real
// entry point, runStdioServer below, is the only caller that supplies a
// real, socket-backed Api.
export function createServer(api: Api): McpServer {
  const server = new McpServer({
    name: 'hobby-mcp',
    version: '0.0.0',
  })

  server.registerTool(
    'hobby_list',
    {
      description:
        'list every hobby project and its resources, with current sleep/running state. ' +
        'mirrors `hobby ls`. takes no arguments.',
      inputSchema: {},
    },
    async () => listTool(api)
  )

  server.registerTool(
    'hobby_new',
    {
      description:
        'create a new hobby project and its postgres resource (named "primary"), and wait for it to be ' +
        'ready. mirrors `hobby new <name>`. does not return the connection string; call ' +
        'hobby_connection_string afterward to get it.',
      inputSchema: {
        name: z.string().min(1).describe('the new project name, for example "blog"'),
      },
    },
    async (args) => newTool(api, args)
  )

  server.registerTool(
    'hobby_connection_string',
    {
      description:
        'get the postgres connection string for a resource, including its superuser password in ' +
        'cleartext. mirrors the data path of `hobby connect <target>`. this is the only tool that ' +
        'returns a working password; treat the result as a secret.',
      inputSchema: {
        target: z.string().min(1).describe(TARGET_DESCRIPTION),
      },
    },
    async (args) => connectionStringTool(api, args)
  )

  server.registerTool(
    'hobby_sleep',
    {
      description: 'put a resource to sleep (stop its container). mirrors `hobby sleep <target>`.',
      inputSchema: {
        target: z.string().min(1).describe(TARGET_DESCRIPTION),
      },
    },
    async (args) => sleepTool(api, args)
  )

  server.registerTool(
    'hobby_wake',
    {
      description:
        'wake a sleeping resource (start its container, and wait until it is ready). mirrors ' +
        '`hobby wake <target>`.',
      inputSchema: {
        target: z.string().min(1).describe(TARGET_DESCRIPTION),
      },
    },
    async (args) => wakeTool(api, args)
  )

  server.registerTool(
    'hobby_logs',
    {
      description: 'tail a resource\'s container logs. mirrors `hobby logs <target> [--tail N]`.',
      inputSchema: {
        target: z.string().min(1).describe(TARGET_DESCRIPTION),
        tail: z.number().int().positive().optional().describe('number of trailing log lines, defaults to 200'),
      },
    },
    async (args) => logsTool(api, args)
  )

  server.registerTool(
    'hobby_rm',
    {
      description:
        'permanently destroy a project (all its resources) or a single resource, and its data. ' +
        'mirrors `hobby rm <target>`. DESTRUCTIVE AND IRREVERSIBLE. requires confirm: true; without it, ' +
        'this tool refuses and makes no request to the daemon at all. only pass confirm: true once you ' +
        'are certain the target and its data should be deleted.',
      inputSchema: {
        target: z.string().min(1).describe(TARGET_DESCRIPTION),
        confirm: z
          .boolean()
          .describe('must be exactly true to proceed; any other value (including omitting it) is refused'),
      },
    },
    async (args) => rmTool(api, args)
  )

  return server
}

// The real entry point: resolves the real $HOBBY_HOME paths, builds a real
// Api bound to the real unix socket, and connects over stdio. Never called
// from tests; see test/tools.test.ts for the pure, socket-free path.
export async function runStdioServer(): Promise<void> {
  const paths = resolvePaths(process.env)
  const api = createApi(paths.socketPath)
  const server = createServer(api)
  const transport = new StdioServerTransport()
  await server.connect(transport)
}
