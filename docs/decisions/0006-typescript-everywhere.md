# 0006. TypeScript everywhere, Bun as the runtime

Status: ACCEPTED
Date:   2026-08-07

## Context

`claude_docs/ACTIVE_CONTEXT.md` named this as the decision blocking all code. The
original framing was a genuine three-way choice between Node, Go and Rust,
weighing a single static binary against keeping the MCP server nearly free.

Two things resolved it. First, Studio is now in Phase 1, and Studio is a web
application, so TypeScript is in the project regardless of what the daemon is
written in. The question stopped being "one language or two" and became "two
languages or one." Second, the only success metric is the author still using this
in six months, which makes completion probability the dominant variable, and the
author is fastest in TypeScript.

## Decision

**TypeScript for everything: daemon, proxy, CLI, MCP, Studio.** Bun is the
runtime and the build tool, and `bun build --compile` produces the single
executable that makes installation on a bare VPS a download rather than a runtime
prerequisite.

**Write against Node-compatible APIs.** `node:net`, `node:fs`, `node:crypto`,
not `Bun.listen` and friends, except where a Bun-only API is load-bearing and
documented as such. This is not stylistic. It means switching the runtime to Node
is a build configuration change rather than a rewrite.

## Reasoning

One language means the `@hobby.sh/*` namespace stays coherent, the MCP server is
close to free, and Studio shares its types with the server that feeds it rather
than restating them. Given the daemon API is the only control surface, shared
types are what structurally prevents the CLI and MCP from drifting, which
`docs/mcp/CLAUDE.md` calls a hard rule.

Go would have given a better proxy and better syscall ergonomics for containers
and reflinks, at the cost of a second language and a second MCP story. Rust would
have given the best proxy and the slowest path to something usable. For
throughput this project will never need, neither trade is worth it.

## Consequences accepted

- **A wire-protocol proxy in JavaScript is unusual.** pgcat and PgDog are Rust,
  Supavisor is Elixir. At single-box scale the proxy is socket plumbing rather
  than computation, so this should be fine, and M0 measures it rather than
  assuming.
- **Bun's socket and TLS stack is younger than Node's**, and the proxy is the
  keystone that holds long-lived connections. M0 stress-tests both runtimes. If
  Bun disappoints we move to Node and lose only the compile step, which is
  precisely why the Node-compatible API rule exists.
- **Reflink cloning shells out to `cp --reflink=auto`** rather than calling
  `ioctl(FICLONE)` directly. Boring, portable, and one less native dependency.
- **Caddy puts a Go binary in the runtime picture** (ADR 0009). One language in
  our source tree, not one language on the box.

## What would have to change to revisit

M0 showing that neither Bun nor Node can hold the cold start budget or proxy
connections reliably. That would move the proxy, and only the proxy, to Go or
Rust, with the daemon API as the seam between them.
