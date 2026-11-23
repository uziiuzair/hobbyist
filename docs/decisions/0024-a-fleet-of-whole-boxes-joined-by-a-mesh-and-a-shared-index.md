# 0024. A fleet of whole boxes, joined by a mesh and a shared index

Status: PROPOSED
Date:   2026-11-23

## Context

The root `CLAUDE.md` lists "**Kubernetes, clustering, multi-node anything.**
One box." as out of scope (line 125), and ADR 0007 kept that line binding
("Each still needs an ADR to reopen", lines 62-65). This is the ADR that
reopens part of it.

The demand is real daily use, which is the bar the out-of-scope list sets.
Hobbyist runs in production for a design partner whose projects cannot go
down. Phase A (#226, #227) removed downtime on one box: rolling deploys,
held restarts, a proxy that outlives the daemon. What one box cannot survive
is the box itself.

ADR 0023 (PROPOSED, #225) tried to answer that with a standby pair. The
review on 2026-11-18 found it could split brain under a partition, and
changed the target from a pair to a fleet. The review also set an order:
mesh and membership first, then multi-node Postgres on top of it, then the
front door, then plugins. This ADR is the first of those, and only the first.

What a fleet needs before it can hold a standby, a read copy or a second
front door is two things the code does not have today:

- **A private network between boxes.** Today Hobbyist only *notices* a
  Tailscale network (`packages/cli/src/daemon/tailnet.ts`: "Hobbyist never
  manages tailscaled, it only notices one") and routes to `127.0.0.1` only
  (`targetFor`, `packages/cli/src/daemon/proxy-resolve.ts`). Boxes on
  different providers and home networks sit behind NAT.
- **One answer, shared by every box, to "which node owns project X".** State
  is one SQLite file per daemon with a single writer
  (`packages/core/src/store.ts`, "Safe today because the daemon is
  single-process"). Two boxes each holding their own file cannot agree on
  anything, and the code says plainly that concurrent writers would need a
  real transaction.

The prior art is filed at
`docs/fleet/research/2026-11-23-mesh-and-membership-prior-art.md`.

## Decision

**1. A fleet is a set of whole boxes. Every node is a complete Hobbyist, and
the fleet only adds a shared index.** Each node keeps its own daemon, its own
SQLite store as the single writer of its own resources, its own proxy, Caddy
and data directories. Nothing about a project's data leaves the node that
holds it because of this ADR. Take the fleet away and every node is a normal
single box again. This is what keeps promise 1 ("you can always leave") and
promise 2 ("it runs on one box") true: one box stays the default, a fleet is
opt-in, and a box that never joins one runs no new process at all.

**2. The mesh is a Tailscale-protocol network, coordinated by Headscale.**
Headscale (BSD-3) with the official Tailscale client (BSD-3) gives NAT
traversal with relay fallback, pre-auth keys that map onto a join token, and
a mesh that keeps working while the coordination server is down. Two modes:

- **Hobby runs Headscale** on the node that creates the fleet, as a managed
  sidecar, the way Caddy is (ADR 0009). This is the default.
- **Bring your own tailnet**, Headscale or Tailscale's hosted service, which
  is what `proxyHost: "tailnet"` (ADR 0017) already assumes.

The Tailscale client (`tailscaled`) runs on the host in kernel mode, so
Postgres, the proxy and the daemon can bind to the mesh address. This
reverses `tailnet.ts`'s "never manages tailscaled" for fleet nodes only: a
node that joins a fleet has its `tailscaled` brought up by `hobby fleet
join`. A box that is not in a fleet is untouched.

**3. Shared truth lives in etcd, run as a managed sidecar, with three voting
members.** etcd (Apache-2.0) has exactly the primitives needed: a
linearizable store, leases, watches, and transactions that compare on
revision. The first three nodes are voting members and later nodes are
clients, up to five voters at most. Members talk only over the mesh, with
TLS from a fleet CA on top.

**A fleet needs three voters.** Two boxes plus a **witness**, a small
third box that runs the mesh client, one etcd member and a daemon holding no
resources, is the smallest fleet. A two-node fleet without a witness is
refused, because a two-member etcd loses its majority when either member
goes, and then nothing can be changed safely.

**4. The index holds pointers, never data.** etcd holds, and only holds:

- the fleet's identity and its CA fingerprint
- each node's record (name, mesh address, version, role), bound to a lease
  so a node that stops renewing it drops out of the live set
- each project name, reserved fleet-wide by create-if-absent
- each project's owner and a **term**: `{node, term}`

The term is a number that only goes up, changed only by a transaction that
compares the previous value. Nothing reads a term yet. It exists now so that
the multi-node Postgres ADR, which will move ownership between nodes, starts
from a record that can already fence an old owner.

**5. One project, one owner node, placed by the operator.** `hobby new shop
--on node-b` places it. Nothing moves on its own and there is no scheduler.
The operator places and Hobby obeys, confirmed on 2026-11-23. Moving a
project between nodes is not in this ADR. It needs the replication that the
multi-node Postgres ADR designs.

**6. Any node answers for the fleet.** The CLI, Studio and MCP can talk to
any node. Reads of the index are served from etcd. A change to a project is
forwarded by the receiving daemon to the owner's daemon over the mesh. So the
daemon API stays the only control surface, and CLI and MCP parity holds.

**7. Nodes get their own credential, with a scope.** A node talks to another
node with a **node credential**, which can call only the fleet endpoints a
node needs, never the full operator API. This reverses ADR 0018's "There are
no scopes" for node-to-node traffic only. It answers the review's point that
a pairing token was full control. Operator tokens are unchanged. People
inside one organisation, each with their own credential, is the meaning of
multi-tenancy confirmed on 2026-11-23. It is not built here, and the index
reserves room for it.

**8. A partition never stops a node serving what it owns.** With one owner
per project, nothing else can take a project over without an operator act,
so a node that loses the etcd majority keeps serving its projects and
refuses only changes to the index (creating, placing or deleting a
project). This rule is deliberately weaker than what multi-node Postgres
will need, where an owner that loses its lease must stop, and that ADR
replaces it for the projects it covers.

**9. Eject is per node.** `hobby eject` on a node gives that node's projects
exactly as today. The index holds no data, so leaving needs nothing from it.
`hobby fleet leave` returns a node to a single box with its projects intact.

## What this does not decide

- **Standbys, read copies, failover.** The multi-node Postgres ADR, which is
  ADR 0023 reworked on top of this one.
- **Getting public traffic to a live node.** The front door ADR (DNS, floating
  IP, Caddy upstreams on other nodes, shared certificates).
- **Plugins, identity, mail, drive,** and the widened scope Uzair set on
  2026-11-18. The new root `CLAUDE.md` and the ADR that supersedes 0007 come
  after the first three steps have a shape.
- **Per-person accounts.** Room is reserved, nothing is built.

## Alternatives rejected

- **Raft embedded in the daemon.** No production-grade Raft exists in
  TypeScript. Owning a consensus implementation, its fsync, snapshots and
  membership changes is a project of its own.
- **Postgres as the shared store.** Circular: the store that decides who owns
  Postgres would itself need Postgres failover.
- **rqlite.** MIT and easy from TypeScript, but no leases and no watches, so
  liveness would be built on timestamps and clocks. The fallback if etcd
  proves too heavy to operate.
- **Consul.** BSL 1.1 since August 2023, and far more surface than needed.
- **Gossip (SWIM, Serf).** Gives "who seems up", which can disagree under a
  partition. etcd leases already give liveness at two to ten nodes.
- **NetBird.** The runner-up. Its server parts are AGPLv3 since v0.53.0, and
  it has more components and an identity-provider-centred setup.
- **Plain WireGuard managed by the daemon.** No NAT traversal, so home boxes
  could only reach public ones. Rebuilding hole punching and relays is what
  Headscale already is.
- **ZeroTier, Netmaker.** Licence: ZeroTier's controller is source-available
  since 1.16, and Netmaker's `ee` module is still SSPL.
- **Kubernetes or k3s.** The thing the project exists to not require.
- **A two-node fleet with no witness.** Either etcd loses its majority with
  either node, or one node holds all the truth and the fleet is a single
  point of failure with extra steps.

## Consequences accepted

- **Two new sidecars on every fleet node,** `tailscaled` and an etcd member,
  plus Headscale on one node. Their footprint on a 1 GB VPS is not measured
  yet. The spec's first step is measuring it.
- **etcd is sensitive to slow disks and slow links.** Cheap VPS disks and
  relayed links cause leader elections. Timeouts need tuning, and the spec
  has to show it stays stable on the boxes this project targets.
- **Losing two of three voters freezes the index** until an operator recovers
  it from a snapshot. Serving continues (decision 8). The recovery runbook is
  part of the spec, not an afterthought.
- **Headscale is a single instance and still 0.x.** While it is down, nodes
  cannot join and keys cannot change. Traffic continues. Node key expiry is
  disabled on fleet nodes so an outage cannot drop one.
- **A witness is a third box to pay for and keep alive,** and it only helps
  if it sits with a different provider or network from both data nodes.
- **Hobbyist now manages `tailscaled` on fleet nodes,** which `tailnet.ts`
  deliberately did not. Doing it badly would break a host's networking, so
  the spec keeps it to bring-up, health and leave.

## What would have to change to revisit

- **Retreat** to bring-your-own tailnet only, with no managed Headscale, if
  keeping Headscale current costs more than one fix a month in real use.
- **Replace etcd with rqlite** if etcd cannot stay stable, without timeouts
  so long that failover would be meaningless, on the cheapest boxes the
  design partner runs.
- **Delete the fleet** if, sixty days after it ships, the design partner is
  not running a fleet daily. A capability nobody runs is the 40 percent
  platform this project guards against.
- **Reopen decision 5** if operators repeatedly ask for placement to happen
  on its own. Automatic placement can sit on top of operator placement. The
  reverse is not true.
