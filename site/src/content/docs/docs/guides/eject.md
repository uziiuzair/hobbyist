---
title: Eject and adopt
description: The command that hands you your data and gets out of the way, and the one that takes it back.
sidebar:
  order: 7
---

<p class="state state--running">reliable</p>

**You can always leave.** It is the first of the project's three promises, it
outranks the other two when they conflict, and it is the part exercised most
deliberately, because a promise that only works in theory is not one.

Verified end to end against real Docker on 2026-08-08.

## Eject

```sh
hobby eject blog
```

Writes a `docker-compose.yml` describing the project as it stands, alongside the
data. Run `docker compose up` on any machine with Docker and the project is
back, with no Hobbyist installed anywhere.

Plain `eject` is a snapshot of current state, and Hobbyist keeps managing the
project. Taking a copy to look at should not be an irreversible act.

## Release

```sh
hobby eject blog --release
```

The same output, and Hobbyist stops managing the project. It will not start it,
stop it, sleep it or wake it.

A released project is still listed by `hobby ls`, marked
`(released, not managed)`, because it is still on the box. The distinction
between "hobby forgot about this" and "hobby is deliberately not touching this"
is worth a word on the line, and only one of them is true.

## Adopt

```sh
hobby adopt blog
```

Takes a released project back under management. There is no penalty and no
window.

## What you get, per kind

| Kind | In the eject |
|---|---|
| `postgres` | The data directory, and a compose service pointing at it. A plain `PGDATA` any Postgres 18 can open |
| `app` | The compose service and its image |
| `worker` | The built bundle, the generated manifest, and the storage directories |
| `queue` | The messages sqlite file |

## Why this exists at the top of the list

The absence of lock-in removes work rather than adding it. There is no migration
tooling to write, no export queue to operate, no retention window to explain and
no process for people leaving. Those are costs a business takes on in exchange
for keeping customers. This is not a business, so it takes none of them on.

It is also what makes the rest of the documentation trustworthy. A platform you
can leave only has to be useful. A platform you cannot leave has to be trusted,
and this one is v0-alpha.
