# Eject verified on Linux

Status: NOTES, measured 2026-08-22. **The result is good.**

`hobby eject` is the project's first promise and had only ever been exercised
end to end on macOS (2026-08-08). This is the same test on Ubuntu 24.04, ext4,
Docker 29.7.2, on a DigitalOcean droplet.

## What was done

The managed database was put to sleep, its data directory was **copied** rather
than used in place (two postgres processes against one PGDATA would corrupt it,
which is a hazard worth naming for anyone repeating this), and a stock
`postgres:18-alpine` container was pointed at the copy with no Hobbyist in the
loop at all.

```
docker run -d --name ejectproof -e POSTGRES_PASSWORD=... \
  -v /tmp/ejecttest/pgdata:/var/lib/postgresql -p 15999:5432 postgres:18-alpine
```

## Result

```
$ psql -U postgres -d coldstart -tAc 'select version()'
PostgreSQL 18.6 on x86_64-pc-linux-musl, compiled by gcc (Alpine 15.2.0) 15.2.0, 64-bit

$ psql -U postgres -tAc 'select datname from pg_database where datistemplate = false'
postgres
coldstart
```

A stock Postgres binary opened the data directory and served the database. The
ADR 0003 invariant, that this is a plain PGDATA any Postgres can open, holds on
Linux and ext4 as well as on APFS.

## Two notes for whoever documents this

**`hobby eject` writes nothing.** It renders the compose file to stdout and
prints the data directory paths. That is a reasonable choice and it is not what
the documentation implies: the site and README both say eject "hands you a
`docker-compose.yml`", which reads as a file appearing on disk. Either the
wording should say it prints one, or the command should take a path. Worth a
decision rather than a silent doc edit.

**The mount point is the postgres home, not PGDATA.** The eject output says this
correctly, naming `pgdata/18/docker` as where a stock `pg_ctl` should point
while the mount is the directory above. That is `resolvePgdataPath`'s rule
surfacing where a user can act on it, and it worked exactly as written.

## Incidental

`hobby connect coldstart` refused with `project coldstart has more than one
resource: primary, web` and a hint naming the explicit form. Correct behaviour,
and the hint was the thing that resolved it.
