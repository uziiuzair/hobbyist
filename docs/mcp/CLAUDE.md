# `docs/mcp/` the MCP server

**Status:** PROPOSED. Nothing built.

Exposes the `hobby` verbs to agents over MCP, so provisioning a database is
something an assistant can do directly rather than by shelling out and parsing
human-readable output.

## Why this is in v1 despite being small

It is the differentiator. Coolify, Dokploy and the rest deploy things well and
have no reason to ship this. Being MCP-native from the first release is what
makes Hobbyist infrastructure built for how software is actually written now,
rather than infrastructure with an integration bolted on later.

It is also genuinely small. It is a thin wrapper over verbs that already exist,
which is the whole reason it belongs in v1 rather than being deferred.

## In scope

- Tool surface mirroring the CLI: create, list, branch, connection string,
  destroy, and a guarded query tool
- What an agent is allowed to do without a human present
- Response shaping: what an agent gets back, which is not the same as what a
  terminal gets

## Transport is already decided

The MCP server is a client of the **daemon HTTP API over the unix socket**, the
same one the CLI uses. Filesystem permissions are the authentication, so there is
no token to issue, no port to bind, and no credential to leak. An agent discovers
a local Hobbyist by the socket existing.

This is also what makes the hard rule below structural rather than aspirational:
there is exactly one surface, and both clients render it.

## Out of scope

- Anything the CLI cannot already do. This surface **wraps** the CLI, it does not
  extend it. A capability that appears here first is a bug.
- Being a general Postgres MCP server. Several exist and they query databases.
  This one manages them.

## Hard rule

**The MCP tools and the CLI verbs must never diverge.** Same names, same
semantics, same errors. If they drift, this becomes a second product surface with
its own bugs, and the person maintaining it is one person.

## Open questions

- Does the query tool exist at all in v1? Letting an agent run arbitrary SQL
  against a real database is a meaningful decision, not a convenience. A
  read-only default with explicit opt-in is the obvious shape.
- Destructive operations need a confirmation model that survives an agent being
  overconfident.
