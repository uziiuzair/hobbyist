---
title: Postgres
description: The one resource kind that is reliably configured and working. Creating databases, connecting, and what the data directory guarantees.
sidebar:
  order: 1
---

<p class="state state--running">reliable</p>

This is the part of the project that has been run in anger. Cold start is
measured, eject is verified end to end against real Docker, and the data format
carries executable guarantees rather than intentions.

## Create one

```sh
hobby new blog                              # project + a postgres named primary
hobby pg create --project blog analytics    # a second database in the same project
hobby create postgres analytics --project blog   # the same thing, general form
```

`hobby new` does three things in one command because that is the ergonomic being
copied: a managed platform does not ask you to pick a compute size before you
have a table. It creates the project, creates a `postgres` resource named
`primary`, waits for it to actually accept queries, and prints the connection
string.

## Connect

```sh
hobby connect blog          # opens psql
hobby connect blog --json   # the connection string, for an ORM or a .env
```

`hobby connect` never puts the connection string in the child process's argument
list. The credentials go through the environment instead, so nothing that reads
a process list can see your password. Your own `PSQLRC`, `PAGER` and `PGSSLMODE`
still apply, since only the five `PG*` connection variables are forced.

`--json` also returns `tailnetConnectionString` when the daemon has a tailnet
address. That is the one to use from another machine.
[Tailscale and tunnels](/docs/guides/tailscale-and-tunnels/).

## Sleep and wake

```sh
hobby sleep blog
hobby wake blog
```

Neither is usually necessary. A database sleeps by itself after
`sleepAfterSeconds` of inactivity (300 by default) and wakes when something
connects. `wake` exists for when you want it warm before something else needs
it, not because anything requires you to call it.
[How wake works](/docs/concepts/sleep-and-wake/).

## The version

The default image is `postgres:18-alpine`, and it is configurable.
Postgres itself is unmodified: no fork, no patched binaries, and no extension is
required for anything core.

Postgres 18 or newer is a hard requirement only for cloning a database that is
*awake*. Cloning a cleanly stopped data directory is version independent, and
since hibernation means most instances are stopped, that is the usual case.

## Where the data is

```
~/.hobby/projects/blog/primary/pgdata/18/docker
```

That is a plain `PGDATA`. Point any Postgres 18 at it.

The nesting is not decoration. Postgres 18's official image refuses to start
when a bind mount lands directly on what used to be `PGDATA`, so the mount point
is the postgres home directory and the entrypoint places the real data directory
in a subdirectory named for the major version. `resolvePgdataPath` in
`packages/core/src/config.ts` is the single place that pattern is written down.

## Backing up

Use `pg_dump`. It is not a fallback here, it is the escape hatch, and a database
you cannot dump is a bug.

```sh
pg_dump "$(hobby connect blog --json | jq -r .connectionString)" > blog.sql
```

Do not read the presence of snapshot code in the repository as a backup story:
`takeSnapshot` is implemented and tested and reachable from no command.
[Status](/docs/status/#not-reachable).

## Leaving

```sh
hobby eject blog
```

A `docker-compose.yml` and the data directory, runnable on any machine with
Docker and no Hobbyist anywhere. [Eject and adopt](/docs/guides/eject/).
