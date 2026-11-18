---
title: Move a database into Hobbyist
description: Copy a Postgres database from Neon, Supabase, RDS or anywhere else into a Hobbyist project, in one command.
sidebar:
  order: 8
---

`hobby import` copies an existing Postgres database into a Hobbyist project with
the two tools Postgres ships for exactly this, `pg_dump` and `pg_restore`. It is
the way in, as [`hobby eject`](/docs/guides/eject/) is the way out.

```sh
hobby import shop
```

```
source connection string (input hidden, one line):
importing into shop: dumping and restoring, this can take a while
imported into shop/primary in 0.8s
  from      localhost/shop, PostgreSQL 16.15, 9.6 MB
  with      pg_dump 18 from postgres:18-alpine
  copied    3 tables, about 3734 rows, 9.0 MB on disk (dump 79.9 KB)
  ext       citext, hstore, pg_trgm, uuid-ossp
  errors    1 from pg_restore:
    ERROR: role "authenticated" does not exist
warning: pg_restore reported 1 error; everything else was restored. ...
```

That report is from a real run of the import pipeline on 2026-11-17 (Apple
Silicon Mac, Docker Desktop, project renamed to `shop` here), importing a `postgres:16` container holding three tables, four
contrib extensions, three roles and a row-level security policy into a
`postgres:18-alpine` target. The one error is the policy, which names a role
the new database does not have.

It is a one-shot copy. Writes made to the source after the dump started are not
in it, so stop writing to the source (or accept the gap) before you switch your
app over. Nothing stays connected to the source afterwards: there is no
replication link, which would keep the new database awake forever and defeat
the point of it being able to sleep.

## Giving it the connection string

The connection string holds a password, so `hobby import` never takes it as an
argument. Arguments end up in your shell history and in the process list. Use
one of these instead:

```sh
hobby import shop                                    # a hidden prompt; paste it there
pbpaste | hobby import shop                          # from a pipe
hobby import shop --from-file ~/.config/shop-source  # a file only you can read (chmod 600)
hobby import shop --from-env SOURCE_DATABASE_URL     # the variable's NAME, not its value
```

Both the URL form (`postgres://user:password@host:5432/db?sslmode=require`)
and the `key=value` form work. `sslmode` and the other TLS settings are passed
through as written. Options that point at files on your machine (`sslcert`,
`sslkey`, an `sslrootcert` path, `passfile`) are refused, because `pg_dump`
runs in a container that cannot read them. `sslrootcert=system` works.

From an agent, the `hobby_import` MCP tool takes the same thing by reference
only: `sourceEnv` (a variable in the MCP server's configuration) or
`sourceFile` (a path). Do not paste the connection string into a chat.

## Where it goes

| You run | It imports into |
|---|---|
| `hobby import shop` and `shop` does not exist | a new project `shop`, with a postgres resource `primary` |
| `hobby import shop` and `shop` has one, empty, postgres | that one |
| `hobby import shop --resource legacy` | `shop/legacy`, created if it does not exist |

The target must be empty. If it holds any table, view, sequence or function
(extensions you added with `hobby pg ext add` do not count), the import is
refused, and there is no flag to override that: restoring one database over
another merges them in ways nobody can predict. Import into a new project, or
take a [snapshot](/docs/guides/snapshots/) and empty the database yourself.

If the import fails before restoring anything (the source is unreachable, too
new, or uses an extension this box does not ship), a project or resource it
created for the import is removed again.

## What it does

1. Starts a throwaway container from the target database's own image, on the
   project's network. Your machine needs no Postgres client tools, and nothing
   is downloaded.
2. Checks the target is empty, then connects to the source and checks its
   version. `pg_dump` can dump its own Postgres version or older, never newer,
   so a PostgreSQL 18 source cannot be imported into a box whose image is
   `postgres:16-alpine`. That is refused with the versions named.
3. Runs `pg_dump` (custom format, without owners, privileges, subscriptions,
   security labels or tablespaces) into the container's own filesystem.
4. Lists the extensions in the dump and refuses, before restoring anything, if
   the image does not ship one.
5. Runs `pg_restore --no-owner --no-acl`. Every object ends up owned by the
   project's own user, so the roles the source had do not need to exist here.
6. Runs `ANALYZE`, then reports.

The target is kept awake while this runs and goes back to its ordinary sleep
schedule afterwards. The dump sits inside the container until it finishes, so
the box needs free disk for the compressed dump as well as the restored
database.

Only import from a database you trust. The dump is restored with the project's
superuser, and a dump can contain anything its server put in it.

## Errors during the restore

By default `pg_restore` keeps going past an object it cannot create and restores
everything else, the way it does when you run it by hand. The report lists the
errors and the command exits 1. The common ones:

- **`role "authenticated" does not exist`**: a row-level security policy names a
  role this database does not have. Create the role and recreate the policy, or
  leave it out.
- **`schema "auth" does not exist`**: something refers to a schema you left out
  with `--schema` (a foreign key to `auth.users`, for example).
- **`type "vector" does not exist`**: a column needs an extension this box's
  image does not ship. See below.

`--strict` restores in one transaction instead, so the first error rolls
everything back and the database stays empty.

## Extensions

The stock image ships Postgres's own contrib extensions (`pg_trgm`, `hstore`,
`citext`, `uuid-ossp`, `pgcrypto` and the rest), and the import copies those.
It does not ship third-party ones such as `vector` (pgvector) or `postgis`.
Choosing an image per project is
[issue #2](https://github.com/uziiuzair/hobbyist/issues/2). Until it lands,
`HOBBY_IMAGE` sets the image for new resources on the whole box. If the source
uses an extension the image lacks, the import names every one of them and
stops. `hobby pg ext ls <project>` shows what a database has installed.

## Neon

- Use the **direct** connection string, not the pooled one. The pooled host
  has `-pooler` in its name, and the import warns if it sees one. Neon's console
  has a toggle for it under Connect.
- Keep `sslmode=require` in the string. Neon refuses connections without TLS.
- A Neon compute that has suspended wakes when the import connects, so there is
  nothing to do first.
- Tables using pgvector need an image with `vector` (see Extensions).

```sh
hobby import shop --from-env NEON_DIRECT_URL
```

## Supabase

A Supabase database holds a great deal that is Supabase itself: the `auth`,
`storage`, `realtime`, `graphql`, `vault` and other schemas, owned by Supabase
roles and built on extensions the stock image does not ship (`pg_graphql`,
`pgsodium`, `supabase_vault`). Import your own schema only:

```sh
hobby import shop --from-file ~/.config/supabase-url --schema public
```

With `--schema`, the extensions your tables use are copied too, into the schema
they live in on Supabase (`extensions`), so a default of
`extensions.uuid_generate_v4()` keeps working.

- Use the **session pooler** connection string (port 5432, user
  `postgres.<project-ref>`). The direct `db.<project-ref>.supabase.co` host is
  IPv6 only unless you pay for IPv4, and the transaction pooler (port 6543)
  does not work with `pg_dump`.
- Add `sslmode=require`.
- Expect errors for policies that name `authenticated` or `anon`, and for
  foreign keys into `auth.users`. Both are listed in the report. Your data is
  restored either way.

## A database on this machine

`localhost` in the connection string means this machine, not the import
container, and is reached as `host.docker.internal`. On Docker Desktop and
OrbStack that just works. On Linux the server has to listen on the Docker bridge
address, not only `127.0.0.1`. A unix socket path is refused: give the TCP host
and port.
