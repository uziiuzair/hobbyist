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
import {
  branchTool,
  connectionStringTool,
  diffTool,
  envListTool,
  envSetTool,
  envUnsetTool,
  expireTool,
  listTool,
  logsTool,
  newTool,
  pgExtAddTool,
  pgExtListTool,
  pgExtRmTool,
  queueCreateTool,
  queueListTool,
  queuePeekTool,
  queuePurgeTool,
  queueRmTool,
  queueSendTool,
  queueSetRetentionTool,
  resetTool,
  rmTool,
  sleepTool,
  wakeTool,
} from './tools.js'

const TARGET_DESCRIPTION =
  'a project name, or "project/resource" when the project has more than one resource. ' +
  'a bare project name is only valid when that project has exactly one resource.'

const QUEUE_TARGET_DESCRIPTION =
  'a project name, or "project/queue" when the project has more than one queue. ' +
  'a bare project name is only valid when that project has exactly one queue.'

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
        extensions: z
          .array(z.string().min(1))
          .optional()
          .describe('extensions to declare and create on first boot, for example ["pg_trgm"]. mirrors --extension'),
      },
    },
    async (args) => newTool(api, args)
  )

  server.registerTool(
    'hobby_pg_ext_ls',
    {
      description:
        'list a postgres resource\'s declared extensions and every installed extension with its version. ' +
        'mirrors `hobby pg ext ls <target>`. wakes a sleeping database to read it. ' +
        '`missing` names declared extensions that are no longer installed.',
      inputSchema: {
        target: z.string().min(1).describe(TARGET_DESCRIPTION),
      },
    },
    async (args) => pgExtListTool(api, args)
  )

  server.registerTool(
    'hobby_pg_ext_add',
    {
      description:
        'declare extensions on a postgres resource and create them (CREATE EXTENSION IF NOT EXISTS ... CASCADE). ' +
        'mirrors `hobby pg ext add <target> <ext>...`. wakes a sleeping database. an extension the image does ' +
        'not ship is refused and nothing is declared.',
      inputSchema: {
        target: z.string().min(1).describe(TARGET_DESCRIPTION),
        extensions: z.array(z.string().min(1)).min(1).describe('extension names, as pg_available_extensions lists them'),
      },
    },
    async (args) => pgExtAddTool(api, args)
  )

  server.registerTool(
    'hobby_pg_ext_rm',
    {
      description:
        'undeclare extensions on a postgres resource. mirrors `hobby pg ext rm <target> <ext>...`. ' +
        'never drops anything from the database; the extension stays installed.',
      inputSchema: {
        target: z.string().min(1).describe(TARGET_DESCRIPTION),
        extensions: z.array(z.string().min(1)).min(1).describe('extension names to undeclare'),
      },
    },
    async (args) => pgExtRmTool(api, args)
  )

  server.registerTool(
    'hobby_branch',
    {
      description:
        'create a new project whose postgres resources start from a copy of an existing project\'s data. ' +
        'mirrors `hobby branch <source> <name>`. the branch starts asleep, is never pinned, and keeps the ' +
        'source\'s database password. an awake source is paused for the length of the copy; a pinned, ' +
        'awake source is refused unless allowPause is true. projects holding apps, workers or queues are refused.',
      inputSchema: {
        source: z.string().min(1).describe('the project to branch from'),
        name: z.string().min(1).describe('the new project name'),
        allowPause: z
          .boolean()
          .optional()
          .describe('accept pausing a pinned project that is awake; leave unset unless the user asked for it'),
        expires: z
          .string()
          .min(1)
          .optional()
          .describe('optional expiry such as "7d" or "36h": the daemon deletes the branch after that, once it is asleep and unpinned'),
      },
    },
    async (args) => branchTool(api, args)
  )

  server.registerTool(
    'hobby_reset',
    {
      description:
        'replace a branch\'s data with a fresh copy of its parent\'s current data, keeping the branch\'s name, port and ' +
        'resources. mirrors `hobby reset <branch>`. DESTRUCTIVE: everything written to the branch is lost. requires ' +
        'confirm: true; without it, this tool refuses and makes no request to the daemon at all. an awake parent or ' +
        'branch is paused for the copy; a pinned, awake one is refused unless allowPause is true. a project not made ' +
        'with hobby_branch, or whose parent is gone, is refused.',
      inputSchema: {
        branch: z.string().min(1).describe('the branch project to reset'),
        allowPause: z
          .boolean()
          .optional()
          .describe('accept pausing a pinned project that is awake; leave unset unless the user asked for it'),
        confirm: z
          .boolean()
          .describe('must be exactly true to proceed; any other value (including omitting it) is refused'),
      },
    },
    async (args) => resetTool(api, args)
  )

  server.registerTool(
    'hobby_expire',
    {
      description:
        'set or clear when the daemon deletes a branch. mirrors `hobby expire <branch> <duration>` and ' +
        '`hobby expire <branch> --never`. only projects made with hobby_branch can expire. an expired branch is ' +
        'deleted once it is asleep and unpinned; a pinned or awake one is skipped and logged, never forced.',
      inputSchema: {
        branch: z.string().min(1).describe('the branch project'),
        expires: z
          .string()
          .min(1)
          .nullable()
          .describe('a duration from now such as "7d", "36h" or "1d12h", or null to clear the expiry'),
      },
    },
    async (args) => expireTool(api, args)
  )

  server.registerTool(
    'hobby_diff',
    {
      description:
        'compare the database schemas of two projects with pg_dump --schema-only, as a unified diff per postgres ' +
        'resource. mirrors `hobby diff`. WAKES every database it compares that is asleep; they sleep again once idle, ' +
        'and the dump itself does not keep them awake. read-only otherwise.',
      inputSchema: {
        project: z.string().min(1).describe('the project whose schema is the new side (lines it adds are "+")'),
        against: z
          .string()
          .min(1)
          .optional()
          .describe('the project to compare against (the old side); defaults to the parent project was branched from'),
      },
    },
    async (args) => diffTool(api, args)
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
    'hobby_env_set',
    {
      description:
        'set environment variables or secrets on an app or worker. mirrors `hobby env set <target> K=V...`. ' +
        'applied on its next wake; a running resource is stopped so the next request picks the values up. ' +
        'returns the key names, never the values.',
      inputSchema: {
        target: z.string().min(1).describe(TARGET_DESCRIPTION),
        set: z.record(z.string(), z.string()).describe('variables to set or replace, name to value'),
      },
    },
    async (args) => envSetTool(api, args)
  )

  server.registerTool(
    'hobby_env_ls',
    {
      description:
        'list the names of the environment variables set on an app or worker. mirrors `hobby env ls <target>`. ' +
        'values are never returned. for a worker, `vars` lists the names from [vars] in its wrangler config too.',
      inputSchema: {
        target: z.string().min(1).describe(TARGET_DESCRIPTION),
      },
    },
    async (args) => envListTool(api, args)
  )

  server.registerTool(
    'hobby_env_unset',
    {
      description:
        'remove environment variables from an app or worker. mirrors `hobby env unset <target> K...`. ' +
        'applied on its next wake; a running resource is stopped.',
      inputSchema: {
        target: z.string().min(1).describe(TARGET_DESCRIPTION),
        keys: z.array(z.string().min(1)).min(1).describe('variable names to remove'),
      },
    },
    async (args) => envUnsetTool(api, args)
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

  server.registerTool(
    'hobby_queue_list',
    {
      description:
        'list queues, with current depth, oldest message age, consumer (and whether it has code deployed ' +
        'yet) and dead letter queue. mirrors `hobby queue ls [project]`. omit project to list every ' +
        'project that has at least one queue.',
      inputSchema: {
        project: z.string().min(1).optional().describe('limit the listing to one project, by name'),
      },
    },
    async (args) => queueListTool(api, args)
  )

  server.registerTool(
    'hobby_queue_create',
    {
      description: 'create a queue with no consumer bound yet. mirrors `hobby queue create <name> --project <p>`.',
      inputSchema: {
        project: z.string().min(1).describe('the project to create the queue in'),
        name: z.string().min(1).describe('the new queue name'),
      },
    },
    async (args) => queueCreateTool(api, args)
  )

  server.registerTool(
    'hobby_queue_peek',
    {
      description:
        'read the oldest messages currently in a queue, without leasing them: a peeked message is still ' +
        'deliverable to a real consumer afterward. mirrors `hobby queue peek <target> [--limit n]`.',
      inputSchema: {
        target: z.string().min(1).describe(QUEUE_TARGET_DESCRIPTION),
        limit: z.number().int().positive().optional().describe('maximum messages to return, defaults to 10'),
      },
    },
    async (args) => queuePeekTool(api, args)
  )

  server.registerTool(
    'hobby_queue_send',
    {
      description: 'enqueue one message onto a queue. mirrors `hobby queue send <target> <json>`.',
      inputSchema: {
        target: z.string().min(1).describe(QUEUE_TARGET_DESCRIPTION),
        body: z.unknown().describe('the message payload, any JSON value'),
        delaySeconds: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe('seconds to delay visibility, 0 to 86400 (Cloudflare\'s own bound)'),
      },
    },
    async (args) => queueSendTool(api, args)
  )

  server.registerTool(
    'hobby_queue_purge',
    {
      description:
        'permanently delete every message in a queue. mirrors `hobby queue purge <target>`. DESTRUCTIVE ' +
        'AND IRREVERSIBLE. requires confirm: true; without it, this tool refuses and makes no request to ' +
        'the daemon at all.',
      inputSchema: {
        target: z.string().min(1).describe(QUEUE_TARGET_DESCRIPTION),
        confirm: z
          .boolean()
          .describe('must be exactly true to proceed; any other value (including omitting it) is refused'),
      },
    },
    async (args) => queuePurgeTool(api, args)
  )

  server.registerTool(
    'hobby_queue_rm',
    {
      description:
        'permanently destroy a queue and every message in it. mirrors `hobby queue rm <target>`. refuses ' +
        'while a worker still binds the queue as a producer or a consumer. DESTRUCTIVE AND IRREVERSIBLE. ' +
        'requires confirm: true; without it, this tool refuses and makes no request to the daemon at all.',
      inputSchema: {
        target: z.string().min(1).describe(QUEUE_TARGET_DESCRIPTION),
        confirm: z
          .boolean()
          .describe('must be exactly true to proceed; any other value (including omitting it) is refused'),
      },
    },
    async (args) => queueRmTool(api, args)
  )

  server.registerTool(
    'hobby_queue_set_retention',
    {
      description:
        'change how long a queue keeps an unconsumed message before dropping it. mirrors `hobby queue ' +
        'set <target> --retention <seconds>`. Cloudflare\'s own bounds: 60 seconds to 1209600 (14 days).',
      inputSchema: {
        target: z.string().min(1).describe(QUEUE_TARGET_DESCRIPTION),
        retentionSeconds: z.number().int().describe('60 to 1209600 (14 days)'),
      },
    },
    async (args) => queueSetRetentionTool(api, args)
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
