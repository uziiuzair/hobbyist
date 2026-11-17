# 0020. No autoprewarm after wake, and no declared roles or databases

Status: ACCEPTED
Date:   2026-11-17

## Context

Reading `neondatabase/neon` for ideas that fit one box produced two from its
compute manager (`compute_tools`): prewarming caches after a restart, and
applying a declared spec of roles, databases and extensions when a compute
starts. Declared extensions were built (`docs/engine/CLAUDE.md`, amendment of
2026-11-17). The other three were considered and are not built. The root
`CLAUDE.md` asks for an ADR for every deliberate non-build, so this is that
record. ADR 0019 already records the third Neon idea that was not built,
throttling password attempts at the Postgres proxy.

## Decision

**1. No autoprewarm after a wake.** Stock Postgres can reload shared_buffers
after a start (`pg_prewarm` with `autoprewarm`). Measured on 2026-11-17
(`docs/hibernation/research/2026-11-17-autoprewarm-after-wake.md`): time to
ready did not change, the first 100 queries after a wake got slower (51 ms to
93 ms with the page cache warm, 60 ms to 127 ms with the VM cache dropped,
medians), and the gain over 2,000 queries was about 170 ms with a warm cache
and none with a dropped one. The first queries after a wake are the ones a
waiting request sits behind, which is the wedge (ADR 0007), so the wedge
decides it. Neon gains more because a cache miss there is a network round trip
to a pageserver, the design ADR 0001 declined; here it is a page cache hit.

**2. No declared databases.** The proxy resolves `project.name` resource first,
then as a database in the default resource (`docs/proxy/CLAUDE.md`). A declared
database would claim a name a later resource silently shadows, and a database
inside a non-default resource has no routing key. Making it work changes the
routing contract, which is a bigger decision than this feature is worth while
`CREATE DATABASE` from psql already does the job for the default resource.

**3. No declared roles.** They do not collide with routing, but a declared role
needs a password the daemon generates, stores and hands out. That makes the
daemon a user store, which the proxy docs say it never maintains, and moves
toward secrets management, which the root out-of-scope list names. `CREATE
ROLE` from psql works and lives in the data directory like everything else.

## Consequences accepted

- A wake starts with empty shared_buffers. On one box the pages are usually
  still in the OS page cache, so this costs microseconds per miss.
- Anyone wanting extra databases or roles uses psql, and the daemon neither
  knows about nor reports them.

## What would have to change to revisit

- **Autoprewarm:** a measurement on a real Linux box with local disk, caches
  dropped between stop and start, where the first 100 queries after a wake get
  faster with it. Shipping would be opt-in per resource, passed as a server
  argument from `containerSpec` and the same `command:` in `renderCompose`
  (ADR 0003 invariant 3).
- **Databases:** a routing change for another reason that gives databases
  inside any resource a key of their own.
- **Roles:** a decision to let the daemon hold credentials for others, which
  would itself need its own ADR against the out-of-scope list.
