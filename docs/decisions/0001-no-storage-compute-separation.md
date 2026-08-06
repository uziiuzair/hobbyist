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
