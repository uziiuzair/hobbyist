# 0003. The data directory is always plain Postgres

Status: ACCEPTED
Date:   2026-08-06

## Context

This project exists because its author objects to vendor lock-in and pays a
monthly bill that proves the point. A tool built on that objection which becomes
hard to leave would be worse than the platforms it criticises, because it made
the promise out loud.

Lock-in in a database tool arrives through the storage format. Once data lives in
a proprietary layout, leaving requires an export path that the vendor controls,
maintains at their discretion, and has every incentive to let rot.

## Decision

**The on-disk data directory is always a plain, unmodified PostgreSQL data
directory.** Three invariants follow, and they are testable:

1. `pg_dump` works at any moment, without Hobbyist running.
2. A stock upstream `postgres` binary, pointed at the directory, starts it.
3. `hobby eject` emits a working `docker-compose.yml` plus that directory and
   stops managing the instance.

These are enforced by a test suite that runs on every commit, not by intention.

## Consequences accepted

- **Some features become impossible**, specifically anything requiring a custom
  page format, a versioned page store, or metadata embedded inside the data
  directory. ADR 0001 already rules out the main example.
- **Metadata lives outside the data directory**, so branch relationships,
  hibernation state and instance config are stored separately and are lost on
  eject. That is stated plainly in the eject output rather than hidden.
- **Some convenience is left on the table.** Accepted deliberately.

## What would have to change to revisit

Nothing. This one is not up for negotiation, and that inflexibility is the point.
A feature that requires breaking this invariant is the wrong feature, and the
correct response is to drop the feature.

## Amendment, 2026-08-07: invariant 2 resolves to a subdirectory

This does not change the decision above. It corrects a mistaken assumption made
while implementing it, discovered by running the integration test suite against
a real Docker daemon for the first time, after the code had already been
written against a fake runtime that accepted an argv no real Docker would.

The original implementation bind-mounted the host data directory straight at
`/var/lib/postgresql/data`. Against real Docker, `postgres:18-alpine` exits 1
on that mount and logs that the suggested configuration for Postgres 18 and
newer is a single mount at `/var/lib/postgresql`, with Postgres placing its
data in a subdirectory beneath it. The corrected mount is
`<host data directory>:/var/lib/postgresql`; the container's entrypoint then
creates the real PGDATA at `<host data directory>/18/docker`.

**Consequence for invariant 2.** "A stock upstream `postgres` binary, pointed
at the directory, starts it" still holds, but "the directory" is no longer the
host data directory Hobbyist creates and bind-mounts. It is that directory's
`18/docker` subdirectory. Point a stock binary at:

```
<host data directory>/18/docker
```

not at the host data directory itself. `pg_dump` is unaffected: it connects
over the wire like any other client and never touches the data directory
path directly.

Invariants 1 and 3 are unchanged. `packages/core/src/config.ts` now exports
`resolvePgdataPath(hostDataDir)`, the one place this subdirectory pattern is
written down, and `hobby eject` prints the resolved path alongside each data
directory rather than leaving a departing user to guess it.
