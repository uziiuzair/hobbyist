# `docs/cli/` the `hobby` binary

**Status:** PROPOSED. Nothing built.

The single user-facing entry point. Every capability in this repo is reachable
through `hobby`, and nothing is reachable any other way. There is no web
dashboard, no REST API for humans, and no config file that has to be hand-edited
to do something the CLI cannot.

## Why this is capability 1

The CLI is the product surface. Managed Postgres platforms are not bought for
their storage engines, they are bought because provisioning is one click and the
connection string is right there. Our equivalent of that click is one command,
so the command has to be exceptional.

## The shape

```
hobby init                       prepare the host, check the filesystem, start the daemon
hobby new <name>                 project + postgres + connection string, one command
hobby ls                         everything, with sleep state
hobby pg create --project <p>    the explicit form, for a second database
hobby sleep|wake <target>        manual override
hobby connect <target>           open psql against it
hobby studio                     print the URL, open the browser
hobby studio passwd              set the operator credential, on the box only
hobby branch <src> <dst>         copy-on-write branch (Phase 1.5)
hobby rm <target>                destroy, with a confirmation
hobby eject <project>            emit docker-compose.yml plus data
hobby eject <project> --release  the same, and hobby stops acting on it
hobby adopt <project>            manage a released project again
```

Verb-noun-target. No subcommand deeper than three levels.

**`hobby new` carries the promise.** The root `CLAUDE.md` says one command gives
you a Postgres, and that has to survive Projects existing. `hobby new blog`
creates the project, creates the `postgres` resource in it, and prints the
connection string. Everything else is the explicit form for when you want
something other than the common case.

## In scope

- Command surface, argument parsing, help text
- Config resolution: flags, then env, then project file, then global defaults
- The daemon: lifecycle, supervision, IPC with the CLI, where state lives on disk
- Output conventions: human-readable by default, `--json` on every command that
  returns data, exit codes that scripts can trust
- `hobby init` host preflight, including the reflink capability check

## Out of scope

- Anything that talks the Postgres wire protocol, which is `proxy/`
- Container start and stop mechanics, which is `engine/`
- The MCP surface, which is `mcp/`, though it wraps these same verbs and must not
  drift from them

## Decisions made

- **Language and runtime: TypeScript on Bun**, shipped as a compiled single
  binary. See `docs/decisions/0006`.
- **Daemon, not daemonless.** Hibernation needs something always watching, and
  the proxy has to be resident to answer connections at all.
- **State lives in one SQLite file the daemon owns.** The most boring thing that
  survives a hard reboot.
- **`hobby init` warns loudly on ext4 and proceeds.** Refusing to run on the most
  common VPS filesystem is how a tool gets uninstalled in the first thirty
  seconds. Branching degrades to a real copy there and says so.

## The daemon API is the only control surface

The daemon serves one HTTP API on two listeners: a **unix socket** for the CLI
and MCP, where filesystem permissions are the authentication and no credential
exists to leak, and a **loopback TCP port** for Studio, reached only through
Caddy and gated by the operator credential (`docs/decisions/0008`).

Same routes for all three clients. This is what makes the "CLI and MCP must never
diverge" rule in `docs/mcp/CLAUDE.md` structural rather than a matter of
discipline: there is only one surface to drift from.

## Open questions

- What is the story on macOS? APFS supports reflinks, so a Mac Mini is a valid
  target, but the container runtime differs.
- Does the daemon supervise itself, or does it hand that to systemd and launchd?
  Handing it over is less code and worse on the boxes that have neither.
