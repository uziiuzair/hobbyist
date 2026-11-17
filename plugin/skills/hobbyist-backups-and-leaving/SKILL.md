---
name: hobbyist-backups-and-leaving
description: Take, list, restore and delete local snapshots of a Hobbyist project, and eject a project to a standalone docker-compose.yml plus its data. Use before a risky change the user wants to be able to undo, when the user asks to back up or restore, or when they want to move a project off Hobbyist or stop it being managed.
---

# Hobbyist backups and leaving

A snapshot is a copy of a whole project's data, kept on the same box. It does
not survive losing the disk, and there is no point-in-time recovery: you get
back exactly what was there when it was taken. For an off-box backup,
`pg_dump` always works against a Hobbyist database.

Snapshots and eject have no MCP tools; run the CLI.

## Snapshot

```sh
hobby snapshot blog                 # project held asleep for the copy, then restarted
hobby snapshot blog --online        # Postgres-only projects: no pause, uses pg_basebackup
hobby snapshot ls blog              # newest first; still works after the project is deleted
```

It prints the snapshot id. A pinned project with something running is
refused unless `--allow-pause`, which stops it for the copy: ask the user
first, or use `--online` if the project holds only Postgres. The two cannot
be combined.

## Restore

```sh
hobby snapshot restore blog <id>                    # into a new project, blog-restored
hobby snapshot restore blog <id> --as blog-check    # into a new project you name
hobby snapshot restore blog <id> --in-place         # replace blog's own data
```

Default to restoring into a new project: the original is untouched, and you
can inspect or `hobby diff` it before deciding anything.

`--in-place` overwrites the project's current data with the snapshot's.
Everything written since the snapshot is lost. It asks the user to type the
project name; in a non-interactive shell that aborts with exit 1. Pass
`--yes` only after the user has explicitly agreed to lose the newer data.
It keeps connection strings, restores data and not configuration, and is
refused if the project's resources changed since the snapshot.

## Delete a snapshot

```sh
hobby snapshot rm blog <id>
```

Irreversible, with a typed confirmation. `--yes` only on the user's word.

## Leave: eject

```sh
hobby eject blog > docker-compose.yml
hobby eject blog --release > docker-compose.yml   # also stop Hobbyist managing it
hobby adopt blog                                   # manage a released project again
```

`eject` prints a `docker-compose.yml` on stdout and lists the data
directories (and any queue backlog files it wrote under `./queues/`) on
stderr. The compose file contains the database password, because it has to
start Postgres on its own. Always redirect it to a file, never let it print
into the conversation, never `cat` it, and do not commit it. Tell the user
where it is and that it holds a secret.

`--release` stops hobby managing the project: no more sleep, wake, branches
or snapshots for it until `hobby adopt`. Confirm with the user before
passing it.

## Before risky work

When the user is about to do something they may want to undo on a whole
project, take a snapshot first and tell them the id. For trying out a schema
change, a branch is usually lighter: see the branching skill.
