---
title: MCP tools
description: Twenty-one tools over the daemon API, so an agent drives the same control surface the CLI does.
sidebar:
  order: 4
---

<p class="state state--starting">works, postgres only</p>

`@hobby.sh/mcp` exposes the daemon API as MCP tools. It is a client of the same
[HTTP API](/docs/reference/api/) the CLI uses, which is what keeps the two from
drifting: there is no second path for them to drift along.

## Running it

`hobby mcp` is the server: a stdio MCP server that runs under the same runtime
as `hobby` itself, so `install.sh` installs nothing extra for it. An MCP client
starts it as a subprocess. It needs no daemon to start and list its tools; each
tool call needs one, and fails with the daemon-unreachable error without it.

**Claude Code:**

```sh
claude mcp add hobby -- hobby mcp
```

Add `--scope user` to have it in every project rather than only the current
one. The [agent plugin](/docs/guides/agent-plugin/) registers the same server
and adds skills that teach an agent the workflows.

**Claude Desktop** reads `claude_desktop_config.json` (on macOS in
`~/Library/Application Support/Claude/`). Desktop apps do not see your shell's
`PATH`, so give the full path that `command -v hobby` prints:

```json
{
  "mcpServers": {
    "hobby": { "command": "/usr/local/bin/hobby", "args": ["mcp"] }
  }
}
```

**Cursor** reads the same shape from `~/.cursor/mcp.json`, or from
`.cursor/mcp.json` in a project.

The client gets no connection string, password or token from this config.
There is nothing secret in it: access is whoever can open the daemon's socket.

## The tools

| Tool | Mirrors |
|---|---|
| `hobby_list` | `hobby ls` |
| `hobby_new` | `hobby new` |
| `hobby_branch` | `hobby branch`, with `expires` for `--expires` |
| `hobby_reset` | `hobby reset` |
| `hobby_expire` | `hobby expire`, `expires: null` for `--never` |
| `hobby_diff` | `hobby diff`, `project` is the new side and `against` the old |
| `hobby_connection_string` | `hobby connect --json` |
| `hobby_sleep` | `hobby sleep` |
| `hobby_wake` | `hobby wake` |
| `hobby_logs` | `hobby logs` |
| `hobby_env_set` | `hobby env set` |
| `hobby_env_ls` | `hobby env ls` |
| `hobby_env_unset` | `hobby env unset` |
| `hobby_pg_ext_ls` | `hobby pg ext ls` |
| `hobby_pg_ext_add` | `hobby pg ext add` |
| `hobby_pg_ext_rm` | `hobby pg ext rm` |
| `hobby_allow_ls` | `hobby allow ls` |
| `hobby_allow_add` | `hobby allow add` |
| `hobby_allow_rm` | `hobby allow rm` |
| `hobby_allow_off` | `hobby allow off` |
| `hobby_rm` | `hobby rm` |
| `hobby_import` | `hobby import --from-env` / `--from-file`, as `sourceEnv` / `sourceFile` |
| `hobby_queue_list` | `hobby queue ls` |
| `hobby_queue_create` | `hobby queue create` |
| `hobby_queue_peek` | `hobby queue peek` |
| `hobby_queue_send` | `hobby queue send` |
| `hobby_queue_purge` | `hobby queue purge` |
| `hobby_queue_rm` | `hobby queue rm` |
| `hobby_queue_set_retention` | `hobby queue set --retention` |

## The import tool never sees the password

`hobby_import` takes the source connection string by reference only: the name
of an environment variable set in the MCP server's own configuration
(`sourceEnv`), or the path of a file on the box (`sourceFile`). The MCP server
process reads it and passes it to the daemon; there is no argument that takes
the string itself, so a model never has to ask for it and it never enters a
transcript. The result holds the source's host and database name, never the
string.

## Destructive tools require confirmation twice

`hobby_rm`, `hobby_reset`, `hobby_queue_purge` and `hobby_queue_rm` refuse unless called with
`confirm: true`, and the refusal says so. That mirrors the CLI's own prompt, for
the same reason: these are irreversible, and an agent that reaches for one
should have to mean it in a way that shows up in the transcript.

## What it cannot do yet

Creating an `app` or a `worker`. `hobby_new` hardcodes `kind: 'postgres'`. The
daemon side that would allow it has landed
([ADR 0014](/docs/decisions/0014-resource-records-exist-before-code/)), and
wiring it up here is not done.

There is also no MCP tool for deploy, which is a deliberate consequence of the
same gap rather than a separate decision.

## A note on where it runs

The MCP server talks to the daemon over the unix socket (`createApi(paths.socketPath)`,
`packages/mcp/src/server.ts`), so it runs on the daemon's own box. That is a
decision, not a gap: filesystem permissions on the socket are its whole
authentication story, and there is no token for an agent to hold or leak
(`docs/mcp/CLAUDE.md`, "Transport is already decided").

The CLI half of reaching a box from a laptop is built:
[`hobby login`](/docs/reference/cli/#hobby-login-url) exchanges the operator
password for an API token and every CLI command then runs against that box
([ADR 0018](/docs/decisions/0018-the-cli-talks-to-a-remote-daemon/)). MCP
does not use that path: `hobby mcp` on a laptop that is logged in to a box
still serves the laptop's own socket, and says so on stderr. To drive a remote
box from an agent, run `hobby mcp` on the box itself, for example as the
client command `ssh box hobby mcp`.
