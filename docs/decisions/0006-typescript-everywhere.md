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

## Amendment, 2026-08-09: Bun was finally run, and the install path is source

Bun had never been executed against this codebase when this ADR was accepted.
M0 was measured on Node, its results file says so in its name, and the "M0
stress-tests both runtimes" line above was never carried out. Running it found
one hard blocker and settled two open questions.

**`node:sqlite` is not implemented by Bun.** `bun packages/cli/bin/hobby.js`
died on `No such built-in module: node:sqlite` before printing a line of help.
This is worth stating precisely, because the Node-compatible API rule above did
not prevent it and could not have: `node:sqlite` **is** a Node API, and
`packages/core/src/store.ts` followed the rule exactly. The rule protects
against reaching for Bun-only APIs. It does not protect against Node built-ins
Bun has not shipped. Resolved by `packages/core/src/sqlite.ts`, which is now the
only file that knows there are two implementations, and which also normalises a
behavioural difference between them: a row miss reads as `undefined` on Node and
`null` on Bun, and every lookup in `store.ts` asks `row === undefined`.

**argon2 installs and runs under Bun.** The native dependency was the failure
expected first, and it was not a problem on either runtime.

**The keystone works under Bun.** With the adapter in place, the full daemon
runs: `hobby init`, `hobby new`, a Postgres provisioned and cleanly stopped, and
wake-on-connect through the proxy. That is the specific risk this ADR named
("Bun's socket and TLS stack is younger than Node's, and the proxy is the
keystone"), now tested rather than assumed.

**The install path is a source install, so a runtime is a prerequisite after
all.** This ADR says `bun build --compile` makes installation "a download rather
than a runtime prerequisite". What shipped is
`curl -fsSL https://hobby.sh/install | bash`, which clones the repository and
builds it (`scripts/web-install.sh`, then `install.sh`). Bun is therefore
required on the box, and `install.sh` installs it when it is missing, which its
own unprivileged one-line installer makes cheap. `bun build --compile` has not
been attempted and remains the better answer for a bare VPS: it would remove the
build step, the toolchain and the clone. This amendment records that the
downloaded-binary claim above is currently an intention, not a description.

**Both runtimes still work, and that is deliberate.** The test suite runs under
`node --test`, and `bun test` passes the adapter's own cross-runtime
assertions. The escape hatch this ADR describes ("if Bun disappoints we move to
Node and lose only the compile step") is real and was exercised in the writing:
everything shipped tonight was developed and tested on Node and then verified on
Bun.
