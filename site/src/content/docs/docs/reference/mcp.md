---
title: MCP tools
description: Fourteen tools over the daemon API, so an agent drives the same control surface the CLI does.
sidebar:
  order: 4
---

<p class="state state--starting">works, postgres only</p>

`@hobby.sh/mcp` exposes the daemon API as MCP tools. It is a client of the same
[HTTP API](/docs/reference/api/) the CLI uses, which is what keeps the two from
drifting: there is no second path for them to drift along.

## The tools

| Tool | Mirrors |
|---|---|
| `hobby_list` | `hobby ls` |
| `hobby_new` | `hobby new` |
| `hobby_connection_string` | `hobby connect --json` |
| `hobby_sleep` | `hobby sleep` |
| `hobby_wake` | `hobby wake` |
| `hobby_logs` | `hobby logs` |
| `hobby_rm` | `hobby rm` |
| `hobby_queue_list` | `hobby queue ls` |
| `hobby_queue_create` | `hobby queue create` |
| `hobby_queue_peek` | `hobby queue peek` |
| `hobby_queue_send` | `hobby queue send` |
| `hobby_queue_purge` | `hobby queue purge` |
| `hobby_queue_rm` | `hobby queue rm` |
| `hobby_queue_set_retention` | `hobby queue set --retention` |

## Destructive tools require confirmation twice

`hobby_rm`, `hobby_queue_purge` and `hobby_queue_rm` refuse unless called with
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

The MCP server talks to the daemon over the unix socket, so today it has to run
on the daemon's own box. Reaching a daemon from a laptop is
[not built](/docs/status/#not-built) and needs its own decision record first,
because it turns a socket with filesystem permissions into a network service
with an authentication story.
