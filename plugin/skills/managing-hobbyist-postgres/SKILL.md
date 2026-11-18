---
name: managing-hobbyist-postgres
description: Create, connect to, inspect and look after Postgres databases on a self-hosted Hobbyist box with the `hobby` CLI or the hobby MCP tools. Use when the user wants a new database, a connection string in their app's environment, extensions, logs, or to understand why a database is asleep, slow to first connect, or will not wake.
---

# Managing Hobbyist Postgres

Hobbyist runs plain Postgres containers on one box. Every project holds
typed resources; `hobby new <name>` makes a project with one postgres
resource named `primary`. Databases sleep when idle and wake when something
connects, so a first query after a quiet spell is slower than the rest. That
is the product working, not a fault.

Prefer the MCP tools (`hobby_list`, `hobby_new`, `hobby_wake`, ...) when the
hobby MCP server is connected; they mirror the CLI verbs below one to one.
Otherwise run the CLI. Add `--json` to any command whose output you parse.

## Targets

`<target>` is `project` when the project holds one resource, otherwise
`project/resource`. In a directory linked with `hobby link <project>`, most
verbs take no target and act on the linked project.

## Create

```sh
hobby new blog                         # project "blog" with postgres "primary"
hobby new blog --extension pgvector    # declare extensions at creation, repeatable
hobby new status --pin                 # never auto-sleeps
hobby pg create --project blog analytics   # a second database in the same project
hobby ls                               # every project, resource and sleep state
```

A new database is left sleeping on purpose; the first connection wakes it.

## Connect without leaking the password

`hobby new` and `hobby connect --json` print a connection string with the
password in it. Never echo, print, paste or log it, and never write it into
a file that is committed. Put it straight into an environment variable or
an ignored env file without showing it (these use `jq`; any JSON reader
works):

```sh
# into a gitignored env file, value never shown
printf 'DATABASE_URL=%s\n' "$(hobby connect blog --json | jq -r .connectionString)" >> .env.local
grep -q '^\.env\.local$' .gitignore || echo '.env.local' >> .gitignore

# or for one command only
DATABASE_URL="$(hobby connect blog --json | jq -r .connectionString)" npm run migrate
```

`hobby connect blog` with no flag opens `psql` and passes the credentials
through the child's environment, which is the right way for a human to get a
shell. The MCP tool `hobby_connection_string` returns the password in
cleartext into the conversation; use it only when the user asks for exactly
that, and do not repeat its output back.

Always connect through the string hobby gives you (the proxy). The
container's own `config.hostPort` in `hobby ls --json` bypasses the wake
router: it fails while the database sleeps.

## Sleep, wake, pin

| Command | Effect |
|---|---|
| `hobby sleep <target>` | Stop it now. Refused while a session or query is open. |
| `hobby sleep <target> --force` | Stop it anyway, ending sessions. Ask the user first. |
| `hobby wake <target>` | Start it now, for example before a latency-sensitive test or after fixing a failed wake. |
| `hobby pin <project>` | Never auto-sleep this project. Wakes nothing by itself. |
| `hobby unpin <project> [--sleep-after <seconds>]` | Auto-sleep again. |

If `hobby ls` shows a resource as failed with "wake refused, retry in ...",
read `hobby logs <target>` for the cause, fix it, then `hobby wake <target>`.

## Extensions

```sh
hobby pg ext ls blog                   # declared and installed, with versions
hobby pg ext add blog pg_trgm hstore   # declare, then CREATE EXTENSION IF NOT EXISTS
hobby pg ext rm blog hstore            # undeclare only, never drops anything
```

`ls` and `add` wake the database. An extension the image does not ship is
refused with the image named. `pg_stat_statements` needs its library
preloaded first, and `add` refuses it with the exact
`hobby pg config set` command to run (see Server settings). `pg_cron` is
refused outright: its jobs would silently stop while the database sleeps.
Dropping an extension is a psql `DROP EXTENSION`, which also drops dependent
columns: only do that when the user explicitly asks.

## Server settings

```sh
hobby pg config ls blog                    # what is set, never wakes anything
hobby pg config ls blog --all              # every setting hobby allows, with ranges
hobby pg config set blog work_mem=16MB shared_preload_libraries=pg_stat_statements
hobby pg config unset blog work_mem
hobby new shop --setting work_mem=16MB     # declared at creation
```

Only allowlisted settings are accepted, and values outside their range are
refused. Settings are passed to Postgres as server arguments, so `eject`
carries them. On a sleeping database a change applies at the next wake and
wakes nothing. On an awake one it restarts Postgres, a pause of a second or
two that closes open connections: tell the user before doing that. A pinned,
awake project is refused unless `--allow-pause` is passed, and only pass it
after the user agrees to the pause.

## Who can connect

```sh
hobby allow blog                           # the project's allowlist, if any
hobby allow add blog 203.0.113.7 10.0.0.0/8
hobby allow rm blog 203.0.113.7            # removing the last entry keeps it box only
hobby allow off blog                       # open again to any address that can reach the proxy
```

An allowlist applies to every database in the project, through plain
Postgres, TLS and the serverless driver. Connections from the box itself
(loopback, and the project's own apps and workers) are always allowed.
Changes apply to new connections; open sessions are not ended. `allow off`
widens access, so confirm it with the user first.

## Logs

```sh
hobby logs blog --tail 200
```

It returns the recent log and exits; it does not follow.

## Destructive verbs

`hobby rm <target>` destroys a database or a whole project (a bare project
name removes everything in it). It asks the user to type the name. In a
non-interactive shell the prompt reads nothing and aborts with exit 1.
`--yes` skips the prompt: pass it only after the user has confirmed the
exact target in this conversation. The MCP equivalent `hobby_rm` refuses
unless called with `confirm: true`, under the same rule.

## When the daemon is not reachable

Exit code 5, or the error code `daemon_unreachable`, means the CLI could not
reach the daemon. Tell the user; do not try to start `hobby daemon` yourself
unless they ask.
