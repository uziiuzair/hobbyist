# `docs/availability/` the standby pair

**Status:** PROPOSED. Nothing built. `docs/decisions/0023` is PROPOSED;
`specs/2026-11-18-standby-pair-design.md` is the design;
`research/2026-11-18-ha-prior-art.md` is the evidence.

Keeping a project up when a machine goes away, for the few projects whose owner
has decided they must never sleep and never go down.

## Position

**A pair, never a cluster.** One primary box, at most one standby box, and an
optional witness for automatic failover. One box remains the default and the
documented way to run Hobbyist. ADR 0023 argues why the line sits exactly here.

**Postgres does the replication.** Plain physical streaming replication, so a
standby's data directory is a plain PGDATA (ADR 0003). We write the
coordination, the routing and the refusals, never a replication protocol.

**Nobody gets "zero downtime" written in the docs.** Open connections drop on a
failover on every platform surveyed. What this folder promises is measured:
the gap, and whether an acknowledged write can be lost.

## In scope

- Single-box zero-downtime work that benefits every user: app deploys that start
  the new container first, a proxy that survives a daemon restart, connections
  held during a Postgres restart (spec, Phase A)
- Pairing two daemons, per-project HA for pinned projects, synchronous
  replication with the degrade rule, manual switchover and failover, rebuilding
  a standby (Phase B)
- The witness, leases, terms and automatic failover (Phase C)
- The failure-mode table and the chaos tests that check it

## Out of scope

- More than one standby, read replicas for scaling, sharding, multi-primary
- Placing workloads across machines, or any scheduler
- Kubernetes, Patroni with etcd, or any consensus store beyond the witness
- HA for Durable Object state, queue backlogs, buckets or volumes (each needs
  its own ADR)
- Managing DNS or floating IPs (root `CLAUDE.md`, out of scope); documented, not
  built
- Cross-region synchronous replication, which the spec warns against
