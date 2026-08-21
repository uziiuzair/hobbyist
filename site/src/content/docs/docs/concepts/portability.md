---
title: The data directory, and why you can leave
description: The first promise. What eject actually produces, and what guarantees the data format carries.
sidebar:
  order: 4
---

<p class="state state--running">the first promise</p>

**You can always leave.** It is the first of the project's three promises and it
outranks the other two when they conflict, because it is the one that makes them
honest. A platform you cannot leave has to be trusted. A platform you can leave
only has to be useful.

## What that means concretely

**Postgres stays unmodified.** No fork, no patched binaries, no required
extensions for core function. If a feature needs a patched Postgres, the feature
is wrong.
[ADR 0003](/docs/decisions/0003-plain-postgres-data-directory/) states this as an
invariant with executable tests behind it, rather than an intention.

**The data directory is a plain `PGDATA`.** You can point any Postgres 18 at it.
Nothing in it is Hobbyist-specific and nothing in it is a format anyone else
would have to reverse engineer.

**`pg_dump` always works.** It is not a fallback path that gets tested once; it
is the escape hatch, and a database you cannot dump is a bug.

## Eject

```sh
hobby eject blog
```

Writes a `docker-compose.yml` describing the project as it stands, alongside the
data. Run `docker compose up` on any machine with Docker and the project is
back, with no Hobbyist installed anywhere.

Plain `eject` is a snapshot of current state and Hobbyist keeps managing the
project. That is deliberate: taking a copy to look at should not be an
irreversible act.

```sh
hobby eject blog --release
```

The same, and Hobbyist stops managing it. A released project is still listed by
`hobby ls`, marked `(released, not managed)`, because it is still on the box.
The difference between "hobby forgot this" and "hobby is deliberately not
touching this" is worth a word on the line, and only one of those is true.

```sh
hobby adopt blog
```

Takes it back.

## What eject covers

| Kind | What you get |
|---|---|
| `postgres` | The data directory and a compose service pointing at it |
| `app` | The compose service and its image |
| `worker` | The built bundle and its manifest, plus the storage directories |
| `queue` | The messages sqlite file |

Eject was verified end to end against real Docker on 2026-08-08, and it is the
part of this project exercised most deliberately, because the promise is
worthless if it only works in theory.

## Why this is a scope decision, not a feature

The absence of lock-in removes work. There is no migration tooling to write, no
export queue to operate, no thirty day retention window to explain, and no
support process for people leaving. Those are all costs a business takes on in
exchange for keeping customers. This is not a business, so it takes on none of
them and gets a shorter surface in return.
