# 0001. No Neon-style storage and compute separation

Status: ACCEPTED
Date:   2026-08-06

## Context

The obvious way to build "Postgres that feels like Neon" is to build what Neon
built. Neon separates storage from compute by replacing Postgres's storage
substrate: compute nodes stream WAL over the network to a tier of safekeeper
nodes running a consensus algorithm, and pageservers store committed WAL and
reconstruct any page at any point in history on request.

That design is what delivers instant branching, scale-to-zero and
point-in-time-anything simultaneously, and it is genuinely excellent engineering.
Notably, Neon achieved it while keeping Postgres itself unmodified, which they
described as non-negotiable for adoption.

It is also a distributed storage engine written in Rust by a team of Postgres
specialists over several years, funded accordingly.

## Decision

**We are not building a pageserver, a safekeeper tier, or any form of custom
Postgres storage substrate.**

We take the three user-visible behaviors that architecture delivers and obtain
each of them a cheaper way on a single host:

| Behavior | How we get it instead |
|---|---|
| Instant branching | Filesystem copy-on-write via PostgreSQL 18 clone (ADR 0005) |
| Compute off when idle | Stop the container, wake on connection (`docs/proxy/`) |
| Data survives restarts | The data directory is just a directory on disk |

## Consequences accepted

- **No point-in-time travel to arbitrary WAL positions as a native primitive.**
  PITR comes from conventional backup tooling instead, with conventional
  granularity and conventional restore times.
- **Branching is bounded by the filesystem**, so it requires reflink support and
  it requires quiescing the source database.
- **No independent scaling of storage and compute**, which is fine, because there
  is one box.
- **We will never match Neon on the hardest cases.** That is the correct trade for
  a project whose target user is one person on one server.

## What would have to change to revisit

Someone would have to be running Hobbyist at a scale where a single host is
genuinely insufficient, and that scale would mean this had become a product with
users and operators, which it explicitly is not. Revisiting this is effectively
starting a different project.

## Amendment, 2026-11-17: Neon's Postgres is patched, not unmodified

This does not change the decision. It corrects a statement of fact in the
context above, which said Neon kept Postgres itself unmodified.

Neon builds every supported major version from its own repository,
`neondatabase/postgres`, pulled into `neondatabase/neon` as git submodules
under `vendor/postgres-v14` through `vendor/postgres-v17` (pinned in
`vendor/revisions.json`; v17 is 17.5 at `1e01fce`). The commits on that line
change Postgres internals, for example buffer allocation and SLRU segment
handling, and add hooks Neon's storage needs. What Neon keeps unmodified is the
wire protocol and the SQL surface clients see, not the server.

The correction strengthens the decision rather than weakening it. Hobbyist's
engine rule (`docs/engine/CLAUDE.md`) is that Postgres is unmodified, stock
upstream binaries and no patches, so even the parts of Neon's storage design
that might look reusable assume a server Hobbyist will not run. Checked against
the repository on 2026-11-17.
