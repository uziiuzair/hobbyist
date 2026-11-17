# `docs/mcp/` the MCP server

**Status:** BUILT. Eighteen tools registered (twenty-one since the 2026-11-17 amendment below) in `packages/mcp/src/server.ts`
over the daemon API on the unix socket, mirroring the CLI verbs for projects,
databases, env and queues; no deploy tool, and `hobby_new` creates only
postgres. The body below is the original scope guard and still governs the
folder.

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

## Amendment, 2026-10-29: env tools (issue #74)

`hobby_env_set`, `hobby_env_ls` and `hobby_env_unset`
(`packages/mcp/src/tools.ts`, registered in `server.ts`) mirror `hobby env
set|ls|unset` over `POST /v1/resources/:id/env`, the same route the CLI
uses, per the rule above that this surface wraps the CLI and never extends
it. Response shaping matters more here than anywhere else in the tool set:
an agent is handed a secret to set, and what comes back is the key names and
whether the resource was stopped, never a value. `ls` reads names off the
daemon's redacted wire config, so there is no tool that could return one.

## Amendment, 2026-11-17: branch workflow tools

Three tools, mirroring three new verbs over three new routes, so the count
in the status line above is now twenty-one. `hobby_reset` (`hobby reset`,
`POST /v1/projects/:name/reset`) replaces a branch's data with its parent's
and is gated on `confirm: true` exactly as `hobby_rm` is: no request is made
without it. `hobby_expire` (`hobby expire`, `POST /v1/projects/:name/expiry`)
sets or clears a branch's expiry, and `hobby_branch` gained `expires`; both
parse the duration with the CLI's own `parseDuration`
(`packages/cli/src/cli/output.ts`), so "7d" means one thing on both surfaces.
`hobby_diff` (`hobby diff`, `POST /v1/projects/:name/diff`) wakes what it
compares and says so in its description. The SDK's tool annotations
(`readOnlyHint`, `destructiveHint`) are still not used anywhere in
`packages/mcp/src/server.ts`; the `confirm` argument remains the convention.

**2026-11-17 amendment (import).** `hobby_import` mirrors `hobby import` and
takes the source connection string by reference only, as `sourceEnv` or
`sourceFile`, resolved in the MCP server process; there is no argument for the
string itself. The reasoning is in `docs/portability/CLAUDE.md`'s 2026-11-17
import amendment.
