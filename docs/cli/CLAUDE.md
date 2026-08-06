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
hobby pg create <name>           new Postgres, returns a connection string
hobby pg ls                      what exists, what is awake, what is asleep
hobby pg branch <src> <dst>      copy-on-write branch
hobby pg connect <name>          open psql against it
hobby pg rm <name>               destroy, with a confirmation
hobby eject <name>               emit docker-compose.yml plus data, and stop managing it
```

Verb-noun-target. No subcommand deeper than three levels.

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

## Decisions to make

- Language and runtime. Node keeps it inside the `@hobby.sh` namespace and makes
  the MCP server trivial. Go or Rust give a single static binary with no runtime
  dependency, which matters for a tool people install on a bare VPS.
- Daemon or daemonless. Hibernation needs something always watching, so probably
  a daemon, but confirm before assuming.
- Where state lives: a SQLite file, plain JSON, or a Postgres of our own. Prefer
  the most boring option that survives a hard reboot.

## Open questions

- Does `hobby init` refuse to proceed on ext4, warn, or silently degrade? Leaning
  warn loudly and proceed, because refusing to run on the most common VPS
  filesystem is how a tool gets uninstalled in the first thirty seconds.
- What is the story on macOS? APFS supports reflinks, so a Mac Mini is a valid
  target, but the container runtime differs.
