# Mesh and membership: design

Status: PROPOSED (ADR 0024, pending approval)
Date:   2026-11-23

Nothing in this document is built. Every command, key and endpoint below is a
proposal. Evidence for the choices is in
`docs/fleet/research/2026-11-23-mesh-and-membership-prior-art.md`.

## Goal

Several Hobbyist boxes join into one fleet. They reach each other over a
private network, agree on which node owns each project, and accept a change
from any node. Nothing here moves data between nodes, and nothing here makes
a project survive the loss of its node. That is the next design, multi-node
Postgres, which builds on this one.

What an operator gets when this ships:

- `hobby fleet status` on any node shows every node, its health and its role.
- `hobby projects` on any node lists every project in the fleet, with the
  node it lives on.
- `hobby new shop --on node-b` creates the project on node B from anywhere.
- Changing a project from a node that does not own it works, once the
  operator has logged in on that node (F4).
- Project names are unique across the fleet.
- A box that never joins a fleet behaves exactly as it does today, with no
  new process.

## Terms

- **Node.** One box running a Hobbyist daemon that has joined a fleet.
- **Voter.** A node running an etcd member. The first three nodes are voters,
  five at most.
- **Witness.** A voter that holds no resources. `hobby fleet join --witness`.
- **Owner.** The one node a project lives on.
- **Index.** The keys in etcd described under F3. It holds pointers, never
  data.

## What already exists, and what each piece changes

| Today | File and symbol | Changes |
|---|---|---|
| One SQLite store, one writer | `packages/core/src/store.ts` `openStore`, called only from `packages/cli/src/daemon/context.ts` | Unchanged. It stays the record of the node's own resources. The index sits beside it. |
| One daemon per machine | `packages/cli/src/daemon/single-instance.ts` `DAEMON_LOCK_PATH` | Unchanged. One node is one daemon. |
| Tailnet noticed, never managed | `packages/cli/src/daemon/tailnet.ts` `parseTailscaleStatus` | Managed on fleet nodes only (F1). |
| Proxy routes to loopback | `packages/cli/src/daemon/proxy-resolve.ts` `targetFor`, `ProxyTarget.host` in `packages/proxy/src/proxy.ts` | Unchanged here. Routing to another node is the front door design. |
| API on `127.0.0.1:apiPort` only | `packages/cli/src/daemon/server.ts` (`listen(tcpServer, { port: opts.apiPort, host: '127.0.0.1' })`) | Unchanged. A separate fleet listener is added on the mesh address (F4). |
| Operator tokens, no scopes | `packages/cli/src/daemon/studio/tokens.ts` `issueToken`, `verifyToken`; `$HOBBY_HOME/api-tokens.json` | Token hashes are published to the index so any node can verify one (F4). Node credentials are new and scoped. |
| Managed sidecar pattern | `packages/cli/src/daemon/caddy.ts` `createCaddyManager`; `proxy-supervisor.ts` `superviseProxy` | Reused for Headscale and etcd. |
| Eject | `packages/cli/src/daemon/routes.ts` `ejectRoute`, `renderCompose` | Unchanged. Per node. |

## F0. Measure before building

The research's footprint numbers are recalled, not measured. Before F1:

1. On a 1 vCPU, 1 GB VPS (the cheapest the design partner runs) and on a Mac
   Mini, run `tailscaled`, one etcd member and Headscale together. Record
   resident memory, idle CPU and disk writes per minute, with hardware, disk
   type and versions stated.
2. Run a three-member etcd across three providers, with one link forced
   through a DERP relay. Record leader elections per hour at default timeouts
   and at heartbeat 500 ms, election 5000 ms.
3. From Bun, use etcd's HTTP/JSON gateway with `fetch` for range, put, txn,
   lease grant, keepalive and watch. Separately, check whether the `etcd3`
   npm client (`@grpc/grpc-js`) works under Bun 1.3.5.

**Exit:** the three together use under 200 MB resident on the 1 GB box, and
the relayed three-member etcd has no more than one election per hour at the
raised timeouts. If either fails, stop and reopen ADR 0024's choice of etcd
(rqlite is the named fallback).

Results go in `docs/fleet/research/`, dated.

## F1. The mesh

### Creating a fleet

`hobby fleet init --name <fleet>` on the first node:

1. Refuses unless `proxyTls` is set (ADR 0019) and the box has a public
   address or a working tailnet. A fleet with plaintext Postgres between
   providers is not offered.
2. Starts Headscale as a managed sidecar, with its SQLite and noise key under
   `$HOBBY_HOME/fleet/headscale/` (mode 0700). Upstream does not support
   Headscale in containers, so it runs as a supervised binary, using the
   `superviseProxy` pattern. Headscale's own DERP server is enabled, and
   Tailscale's public DERP map is off by default (`fleet.publicDerp: false`).
3. Creates the fleet CA (an Ed25519 key and a self-signed certificate) under
   `$HOBBY_HOME/fleet/ca/`, mode 0600. It signs etcd peer and client
   certificates and node credentials.
4. Brings this node onto the mesh (see "Bringing up tailscaled").
5. Starts the first etcd member (F2) and writes the fleet record.

**Bring your own tailnet.** `hobby fleet init --tailnet existing` skips
Headscale. The operator's own `tailscaled` must already be up, and
`hobby fleet invite` then cannot hand out mesh keys: each node joins the
tailnet first, by the operator's own means.

### Inviting and joining

`hobby fleet invite [--witness] [--expires 1h]` on any voter prints a join
token: one line, single use, expiring (default one hour). It carries the
Headscale URL, a single-use Headscale pre-auth key, the fleet CA fingerprint,
the voters' mesh addresses, and a one-time secret the inviting node will
accept once. The token is a secret. The CLI prints it once and never logs
it, and the docs tell the operator to move it by file
(`hobby fleet join --token-file <path>`), not by chat.

`hobby fleet join --token-file <path> [--name <node>]` on the new box:

1. Refuses if the box is already in a fleet, or if any local project name
   is already taken in the fleet. It lists the clashes and says to rename
   first.
2. Brings up `tailscaled` with the pre-auth key.
3. Dials the inviting node's fleet listener over the mesh, proves the
   one-time secret, and receives a node credential and etcd client
   certificate signed by the fleet CA.
4. If the fleet has fewer than three voters, or `--witness` was given,
   becomes a voter (F2). Otherwise it is a client.
5. Registers its node record and reserves its projects' names (F3).

### Bringing up tailscaled

Kernel mode on the host, so Postgres, the proxy and the daemon can bind to
the mesh address. Userspace mode gives no interface and is not supported for
fleet nodes.

The install script (`install.sh` at the repo root) installs the distribution's
`tailscale` package when the operator passes `--fleet`. The daemon runs
`tailscale up --login-server <headscale> --authkey <key> --hostname <node>`
once, then only reads `tailscale status --json` (the existing
`parseTailscaleStatus`) for health. It never edits routes, DNS or firewall
rules, and `--accept-dns=false` and `--accept-routes=false` are always
passed. Node key expiry is disabled for fleet nodes in Headscale, so a
Headscale outage cannot drop a node.

macOS: the Tailscale app or the `tailscale` Homebrew formula, installed by
the operator. The daemon does the same `tailscale up`.

## F2. etcd

- **Sidecar.** The `quay.io/coreos/etcd` image at a pinned version, run
  through `ComputeRuntime.ensureCreated` with `network: 'host'`, the way
  `createCaddyManager` runs Caddy. Data in `$HOBBY_HOME/fleet/etcd/`. It
  listens on the mesh address only, for both peer and client ports, with
  mutual TLS from the fleet CA. It never binds `0.0.0.0` or `127.0.0.1`.
- **Timeouts.** Heartbeat and election timeouts come from F0's measurements.
  They are written in the spec's as-built section, not guessed here.
- **Joining as a voter.** The inviting node calls `member add` (learner
  first, then promote once caught up), then the new node starts its member
  with `initial-cluster-state=existing`.
- **Client from Bun.** The HTTP/JSON gateway over mutual TLS, unless F0
  shows the gRPC client works. One small module,
  `packages/cli/src/daemon/fleet/index-client.ts`, is the only code that
  speaks to etcd.
- **Snapshots.** Each voter runs `etcdctl snapshot save` hourly, keeping 24,
  under `$HOBBY_HOME/fleet/etcd-snapshots/`. The index is small and holds no
  data, so this is cheap.
- **Witness.** A daemon started with `HOBBY_FLEET_ROLE=witness` runs the mesh,
  the etcd member and the fleet listener only. It refuses `hobby new --on`
  itself and starts no proxy, no Caddy and no containers.

## F3. The index

All keys sit under `/hobby/v1/`. Values are JSON.

| Key | Value | Written by | Rule |
|---|---|---|---|
| `fleet` | `{id, name, createdAt, caFingerprint}` | `fleet init` | Create-if-absent, never changed. |
| `nodes/<nodeId>` | `{name, meshAddress, version, role: voter\|witness\|client, joinedAt}` | the node itself | Bound to the node's lease (TTL 15 s, kept alive every 5 s). Gone when the node stops renewing it. |
| `members/<nodeId>` | same, without the lease | `fleet join` | The durable member list. `nodes/` is who is alive, and `members/` is who belongs. |
| `names/<projectName>` | `<projectId>` | the owner | Create-if-absent in a transaction, which is what makes names unique fleet-wide. |
| `projects/<projectId>/owner` | `{node, term}` | the owner, at create | Created with `term: 1`. Every later change compares the previous value in the same transaction. Nothing in this design changes it after create. |
| `tokens/<lookup>` | `{name, hash, createdAt}` | the node that issued it | The argon2id hash and lookup key from `tokens.ts`, never the token itself. |
| `people/` | reserved | nobody | Room for per-person credentials. Nothing reads or writes it yet. |

`projectId` is the existing id from `store.ts` (`randomUUID`), so it is
already unique across boxes.

**Creating a project.** On the owner: a transaction that creates
`names/<name>` and `projects/<id>/owner` only if neither exists. Only after it
commits is the local store row written. If the transaction fails, nothing
local is created and the CLI says which node holds the name.

**Deleting a project.** The local delete first, then a transaction deleting
both keys. If the daemon dies between the two, reconcile at the next start
finds index keys with no local row and deletes them.

**Reconcile.** At start, and every minute, each node compares its local
projects with the index. A local project missing from the index is
re-registered. If its name is now taken by another project, the node logs
it, reports the conflict in `hobby fleet status`, and keeps serving the
project. An index entry naming this node with no local project is removed.

## F4. Any node answers

### The fleet listener

A new listener, `fleetPort` (default 7438, `HOBBY_FLEET_PORT`), bound to the
mesh address only, with TLS from the fleet CA. It exists only on fleet
nodes. It is separate from `apiPort`, which stays on `127.0.0.1` exactly as
`server.ts` binds it today.

It accepts two credentials, checked separately:

- **Node credential.** A certificate signed by the fleet CA, naming the node.
  Allowed: `/v1/fleet/join`, `/v1/fleet/health`, `/v1/fleet/members`.
  Nothing else.
- **Node credential plus an operator token.** The forwarded request, below.
  The node credential proves which node is forwarding, and the operator token
  proves which person asked. The owner checks the token's hash against
  `tokens/` in the index. Allowed: the ordinary `/v1/` project routes, for
  projects this node owns.

A node credential alone can never change a project. That is the review's
pairing-token point, answered.

### Forwarding

A request on any node for a project owned by another node is forwarded:

- **Reads of the index** (`hobby projects`, `hobby fleet status`) are served
  locally from etcd, with no forwarding.
- **A change to a project** (deploy, settings, sleep, delete, branch,
  snapshot, eject) is sent to the owner's fleet listener, with the caller's
  operator token.
- **On the unix socket with no token**, there is no person to forward, so the
  request is refused with: `shop is on node-b. Run "hobby login" on this box
  once to act on other nodes, or run this on node-b.` The socket's
  filesystem permission proves who you are on this box only.
- **`hobby new <name> --on <node>`** is forwarded the same way. Without
  `--on`, the project is created on the receiving node.

CLI, Studio and MCP all call the same daemon routes, so forwarding lives in
the daemon and parity holds. MCP gains a fleet status tool, and its
project-creation tool gains an `on` argument.

### Surface

| Verb | CLI | API | MCP |
|---|---|---|---|
| Create a fleet | `hobby fleet init` | `POST /v1/fleet/init` | not exposed: it runs once, on a box, by hand |
| Invite | `hobby fleet invite` | `POST /v1/fleet/invites` | not exposed: it prints a secret |
| Join | `hobby fleet join --token-file` | `POST /v1/fleet/join` (local) | not exposed |
| Status | `hobby fleet status` | `GET /v1/fleet` | a new fleet status tool |
| Place a new project | `hobby new <name> --on <node>` | `POST /v1/projects` `{on}` | the project-creation tool, `{on}` |
| Leave | `hobby fleet leave` | `POST /v1/fleet/leave` | not exposed |
| Remove a dead node | `hobby fleet remove <node>` | `DELETE /v1/fleet/members/:node` | not exposed |
| Recover the index | `hobby fleet recover --snapshot <file>` | none: run with the daemon stopped | not exposed |

Verbs that hand out secrets or can break the fleet are left out of MCP on
purpose, and the MCP docs say so.

## F5. Leaving, removing, recovering

- **`hobby fleet leave`** on a node: refuses on the last voter while other
  nodes remain. Otherwise it removes the node's project keys and names from
  the index, removes its etcd member (promoting a client to voter if voters
  drop below three), stops its etcd and `tailscale down`s. Every local project
  keeps running, and the box is a single box again.
- **`hobby fleet remove <node>`** from any voter, for a node that is gone:
  removes its etcd member, its `members/` key and its Headscale node. Its
  projects stay in the index, marked `ownerGone` in `hobby fleet status`.
  The data is on that box's disk, if the box comes back, or in its snapshots.
  This design cannot bring it back on another node. Multi-node Postgres can.
- **Losing the majority.** Every node keeps serving what it owns (ADR 0024
  decision 8). `hobby fleet status` says the index is read-only, and every
  change to the index is refused with that reason. Once enough voters return,
  it heals on its own.
- **Losing the majority for good.** `hobby fleet recover --snapshot <file>`
  on one surviving voter starts a new one-member etcd from the snapshot
  (`etcdutl snapshot restore`), with the same fleet id. Others then rejoin
  through `hobby fleet invite`. Reconcile (F3) re-registers anything created
  after the snapshot. This is a written runbook in the site's guides, tested
  in CI against three containers.
- **Headscale down.** Traffic and the index keep working. Joining and inviting
  are refused with that reason. Headscale's database is included in the first
  node's hourly snapshot.

## Failure modes

| What fails | What keeps working | What stops | Who notices |
|---|---|---|---|
| One voter of three | Everything | Nothing | `fleet status`: the node is missing from `nodes/` |
| Two voters of three | Every node serves its projects | Create, place, delete, join | `fleet status`: index read-only |
| The node that owns `shop` | Every other project | `shop` | `fleet status`: owner not live |
| Headscale | Traffic, the index | Join, invite, key changes | `fleet status`: mesh control down |
| A DERP-only link between voters | Everything, more slowly | Possibly elections under load | F0 measures it, and `fleet status` reports relayed links |
| The mesh on one node | That node serves local and public traffic | Its index access and forwarding | That node's `fleet status`, and the others see its lease expire |

## Security

- **Join tokens** are single use, expire in an hour by default, are printed
  once, and are read from a file on join. Nothing logs them.
- **The fleet CA key** sits on the first node only, mode 0600. Losing that
  node means no new node credentials until `hobby fleet recover` creates a
  new CA. This is in the runbook.
- **etcd** listens on the mesh address only, with mutual TLS. Every node's
  client certificate can write the whole `/hobby/v1/` prefix. So a
  compromised node can rewrite the index, though not read any project's data
  or passwords, since none is stored there. etcd RBAC per prefix is an open
  question (below), not a promise.
- **Operator token hashes** are published to the index, so any node can
  verify a person. They are argon2id hashes, exactly as `api-tokens.json`
  already holds them on disk. Revoking a token removes its key fleet-wide.
- **Nothing listens on a public address** that does not already today. The
  fleet listener and etcd are on the mesh address only. Headscale's HTTPS
  listener is the one new public port, on the first node only, and it
  terminates TLS from the same operator-provided certificate files as the
  proxy (ADR 0019).
- **Public DERP is off** by default, so relayed traffic only goes through the
  fleet's own Headscale. It is encrypted end to end either way.

## Eject

Unchanged. `hobby eject` on a node renders that node's projects
(`ejectRoute`, `renderCompose`), with no mesh address in the output. Run
against a project on another node, it is forwarded like any change and
renders on the owner, and the CLI says which box the data directories are
on. Leaving the fleet first is never required.

## Testing

- **Unit:** the index client against an in-memory fake with the same
  compare-and-set semantics. Name reservation races, reconcile, forwarding
  decisions, credential checks on the fleet listener.
- **Integration (CI, Linux):** three daemons in three containers on one Docker
  network standing in for the mesh, with a real three-member etcd. Init,
  invite, join, create with `--on`, kill one voter, kill two, recover from a
  snapshot, leave.
- **Live (by hand, filed with hardware):** three real boxes on two providers
  plus one behind home NAT, through a real Headscale.

## Open questions

1. **etcd RBAC per node.** Can each node be limited to its own `nodes/` key
   and its own projects' keys without making every transaction need an admin
   role? If yes, a compromised node can no longer rewrite other nodes'
   records.
2. **Where Headscale lives.** On the first node (simplest), or on the witness
   (it holds no data, so losing it costs less)? The design says first node,
   and the witness is the obvious move once one exists.
3. **Install script and `tailscaled`.** Is `install.sh --fleet`
   installing the distribution's `tailscale` package acceptable, or should
   the operator always install it themselves?
4. **Fleet name in the connection string.** Should `shop` on node B be
   reachable as `shop.node-b` before the front door design lands, or does
   every connection string stay pointed at its own node's address until then?
