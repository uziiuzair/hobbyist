---
title: The agent plugin
description: Install the Hobbyist plugin in Claude Code, or its skills in another agent, so an assistant can create, branch, deploy and back up on your box.
sidebar:
  order: 13
---

<p class="state state--starting">works in Claude Code; the skills are new</p>

The plugin gives a coding agent two things. One is the
[MCP tools](/docs/reference/mcp/), started locally with `hobby mcp`. The
other is four skills, short instructions the agent loads when a task matches:

| Skill | Teaches |
|---|---|
| `managing-hobbyist-postgres` | create, connect, sleep and wake, pin, extensions, logs |
| `branching-hobbyist-postgres-for-agents` | branch before a risky migration, `hobby diff`, `hobby reset`, expiry, discard |
| `deploying-hobbyist-apps-and-workers` | `hobby deploy`, env, logs, queues |
| `hobbyist-backups-and-leaving` | snapshots, restore, eject |

The skills add no capability. Every command in them is a `hobby` verb, and
`site/scripts/check-plugin-skills.mjs` fails CI if one names a verb, flag or
tool the CLI does not have. They live in
[`plugin/`](https://github.com/uziiuzair/hobbyist/tree/main/plugin) in the
repository.

## Before you install

`hobby` has to be on the `PATH` of the machine the agent runs on, and that
machine has to be the box: `hobby mcp` talks to the daemon over its unix
socket, never to a box you are logged in to with `hobby login`. Check with:

```sh
hobby version
```

## Claude Code

From inside Claude Code:

```
/plugin marketplace add uziiuzair/hobbyist
/plugin install hobbyist@hobbyist
```

Or from a shell:

```sh
claude plugin marketplace add uziiuzair/hobbyist
claude plugin install hobbyist@hobbyist
```

The repository root holds the marketplace (`.claude-plugin/marketplace.json`),
which points at `plugin/`. Restart Claude Code if it was open. `/mcp` then
lists `hobby`, and `claude plugin details hobbyist` lists the four skills and
the server. To update later, `claude plugin marketplace update hobbyist`.

If you only want the tools and not the skills, skip the plugin and register
the server on its own:

```sh
claude mcp add hobby -- hobby mcp
```

## Other agents

The skills install into Cursor, Codex, Gemini CLI and the other agents the
[`skills` CLI](https://www.npmjs.com/package/skills) supports, straight from
the repository:

```sh
npx skills add uziiuzair/hobbyist
```

It finds the skills through the same marketplace file. It does not register
the MCP server; add that in the agent's own config, as the
[MCP reference](/docs/reference/mcp/#running-it) shows for Claude Desktop and
Cursor.

## What the skills tell an agent not to do

- **Print a connection string.** It holds the database password. The skills
  have the agent bind databases with `hobby deploy --database`, or put
  `hobby connect --json` output straight into an ignored env file or one
  command's environment, never into the conversation.
- **Run a destructive verb unasked.** `hobby rm`, `hobby reset`,
  `hobby snapshot restore --in-place`, `hobby snapshot rm`, `hobby queue purge`
  and `hobby queue rm` all prompt for the name. An agent's shell is not
  interactive, so the prompt aborts. The skills say to pass `--yes`, or
  `confirm: true` to the MCP tool, only after you have confirmed the exact
  target in the conversation.
- **Start the daemon.** When the daemon is down, the agent is told to say so
  rather than start it.

These are instructions to a model, not enforcement. The `confirm: true` gate
in the MCP tools and the typed prompt in the CLI are the enforcement.
