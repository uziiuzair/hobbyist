# `docs/fleet/` several boxes, one fleet

**Status:** PROPOSED. Nothing here is built. ADR 0024
(`docs/decisions/0024-a-fleet-of-whole-boxes-joined-by-a-mesh-and-a-shared-index.md`)
argues for the folder and is awaiting approval. The design is
`specs/2026-11-23-mesh-and-membership-design.md`, and the evidence it rests on
is `research/2026-11-23-mesh-and-membership-prior-art.md`.

## The one thing this capability is for

**Letting whole Hobbyist boxes find each other and agree on who owns what.**
A private network between them (Headscale and the Tailscale client), and a
small shared index (etcd) holding which node owns each project, the node list
and fleet-wide names. Every node stays a complete Hobbyist, and the index
holds pointers, never data.

## What belongs here

- The mesh: creating a fleet, invites, joins, `tailscaled` bring-up, Headscale.
- Membership: the etcd sidecar, voters and the witness, leases, recovery.
- The index: its keys, the term, reconcile.
- The fleet listener and forwarding a change to the owning node.

## What does not belong here

- **Replicating Postgres, standbys, read copies, failover.** That is the
  multi-node Postgres design (ADR 0023 reworked). It reads the index's term,
  but its design is filed with the engine, not here.
- **Getting public traffic to a live node:** DNS, floating IPs, Caddy
  upstreams on other nodes. That is the front door, filed under `proxy/`.
- **Placement logic.** The operator places and Hobby obeys (ADR 0024 decision
  5). A scheduler proposal needs its own ADR first.
- **Per-person accounts.** The index reserves room (`people/`). The design
  needs its own ADR.
