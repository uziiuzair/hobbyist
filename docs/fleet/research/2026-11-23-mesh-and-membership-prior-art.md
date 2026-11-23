Status: NOTES

# Mesh and membership: prior art research

Prepared 2026-11-23 for the Hobbyist fleet design doc (2 to about 10 operator-owned machines, mixed VPS and home NAT, TypeScript/Bun daemon, manual placement, no Kubernetes).

Confidence legend: **[verified]** checked against a primary source this session; **[recall]** from prior knowledge and not re-checked this session; **[uncertain]** sources conflict or no evidence found.

---

## 1. Private network options

### 1.1 Comparison table

| | Headscale + Tailscale client | NetBird (self-hosted) | Plain WireGuard managed by daemon |
|---|---|---|---|
| Licence | Headscale BSD-3-Clause [recall]; Tailscale client BSD-3-Clause [recall] | Client BSD-3; `management/`, `signal/`, `relay/` AGPLv3 since v0.53.0 [verified] | Kernel module GPLv2; `wireguard-go` MIT [recall] |
| Coordination server | Headscale: single Go binary, SQLite or Postgres, one tailnet only [verified] | Management + signal + relay (+ STUN/TURN); newer "combined server" packaging [verified that it exists in v0.83.0; exact component list uncertain] | None. The daemon is the control plane |
| NAT traversal | Yes: STUN-like discovery, hole punching via `magicsock`, DERP relays as fallback; Headscale can run an embedded DERP server [recall] | Yes: ICE (pion) with STUN, relay fallback (own relay, older versions coturn TURN) [recall] | None. At least one side of each pair needs a reachable UDP endpoint; NAT'd home boxes need `PersistentKeepalive` and can only reach public peers (hub-and-spoke) |
| Key distribution / rotation | Node generates its own WireGuard key; control server distributes public keys; node key expiry and re-auth configurable [recall] | Similar: peers register with management, which pushes peer lists [recall] | Daemon must generate keys, exchange public keys, push configs, handle rotation itself |
| ACLs | Tailscale-style HuJSON policy file in Headscale [recall] | Groups and policies in management UI/API [recall] | Only `AllowedIPs` plus host firewall (nftables) the daemon writes |
| Join flow | `headscale preauthkeys create` (reusable/ephemeral, expiry) then `tailscale up --login-server ... --authkey ...` [recall] | Setup keys: `netbird up --setup-key ...` [recall] | Bespoke: e.g. join token over HTTPS to an existing node, exchange pubkeys |
| Kernel vs userspace | Kernel/TUN mode needs `/dev/net/tun` + `NET_ADMIN`; userspace mode needs neither, but then tailscaled is only a SOCKS5/HTTP proxy and other processes do not get a routable interface [verified] | Kernel WireGuard when available, else userspace `wireguard-go` with TUN; also needs `NET_ADMIN` in a container [recall] | Kernel module needs root/`NET_ADMIN`; `wireguard-go` needs TUN |
| Runs in a container | Client: yes, official image (`TS_USERSPACE` toggles mode) [verified]. Server: upstream README says it does not "support nor encourage" containers or reverse proxies (works in practice, but unsupported) [verified] | Yes, Docker is the documented self-host path [recall] | Yes with `--cap-add NET_ADMIN` and host networking |
| Footprint | Headscale tens of MB RAM; tailscaled ~20 to 50 MB RSS [recall, not measured] | Management + signal + relay plus dashboard and an IdP for full setup; heavier [recall] | Smallest: kernel module, zero daemons |
| Maturity / health | Headscale v0.29.7 (30 Oct 2026, security release; min client v1.80.0); v0.29.4 to v0.29.6 in Sep to Oct 2026 [verified]. Still 0.x, one tailnet, follows Tailscale client protocol changes | v0.83.2 (20 Nov 2026), frequent releases, VC-backed [verified] | WireGuard itself is very mature; the management code would be ours |
| Coordination server down | Existing connections keep working with cached keys and policy; no new connections, no key changes, no policy updates, no revocation until it returns [verified, Tailscale doc kb/1091 applies to the client behaviour]. Risk: a node key expiring during the outage cannot renew [inference] | Incident write-up: existing P2P connections stayed up; new connections and reconnects were delayed [verified, one incident only, not a documented guarantee] | No coordination server; mesh only depends on the daemon having written configs. Endpoint changes (home IP changes) break until the daemon republishes |

### 1.2 Others, one line each

- **Nebula** (MIT, Slack, Go; repo updated Apr 2026 [verified]): certificate-based PKI, lighthouses, relays, solid; **out-ish** because you run your own CA and lighthouse and it is not WireGuard (no reuse of WG tooling), but a credible second choice with no account/server concept.
- **ZeroTier**: since 1.16 (Aug 2025) the agent/core is MPL-2.0 but the **controller is under a commercial source-available licence** [verified]; **out** on licence grounds for a self-hosted controller.
- **innernet** (MIT, tonari; latest seen v1.7.1, date uncertain [uncertain]): WireGuard with a CIDR-based server and NAT traversal; **out** because small community and Rust server adds another unfamiliar component; its coordination server is required for peer updates.
- **Netmaker**: server moved from SSPL to Apache-2.0, netclient Apache-2.0, but the `ee` module is still SSPL [verified]; **out**: heavier (MQTT broker, server, UI), history of licence churn, kernel WireGuard focus.

### 1.3 What "plain WireGuard managed by the daemon" really means

The daemon must: generate a keypair per node; run a join handshake (token-authenticated HTTPS to any existing member); keep a member list with `{pubkey, mesh IP, endpoints}`; render `wg` config and apply it (`wg syncconf`); detect endpoint changes; rotate keys. What it cannot do without building a lot more: NAT-to-NAT hole punching and relaying. With home boxes behind NAT you get a hub-and-spoke where every NAT'd node keeps a tunnel to public nodes, and NAT'd-to-NAT'd traffic transits a public node (needs IP forwarding and routing config). That is precisely what DERP/ICE solve, and is the main reason not to hand-roll.

---

## 2. Membership and shared truth

### 2.1 Embedding Raft in TypeScript/Bun

No production-grade Raft exists for JS/TS [verified, search found only young or unmaintained packages]: `@coaty/consensus.raft` (port of etcd raft, notes the original JS implementations are unmaintained), `liferaft` (old, low downloads), `@usex/raft` (Redis-backed, pre-1.0, "no backward compatibility guaranteed"), `@maboke123/raft-core` (feature-rich but tiny adoption). Writing or embedding one means owning a consensus implementation, its durability (fsync), snapshots and membership changes. **Do not.**

Sidecar options:

- **etcd** (Apache-2.0, CNCF). Current lines v3.7.4 (19 Nov 2026), v3.6.17, v3.5.36 [verified]. Provides exactly the primitives needed: linearizable KV, leases with TTL, watches, multi-key transactions with compare-on-revision, and a monotonically increasing global revision. v3.6 claims at least 50% lower average memory than v3.5 [verified, project benchmark]; one open OpenShift bug reports a 2 to 3x regression on large clusters [verified, unresolved]. For a tiny keyspace (well under 100 MB, few clients) a member is typically 30 to 100 MB RSS [recall, measure it]. The real constraint is disk fsync latency: etcd wants low-latency fsync, and cheap VPS or home SD-card disks cause leader churn. Default heartbeat 100 ms, election timeout 1000 ms; across WAN/relayed links these need raising (e.g. 500 ms / 5000 ms) [recall]. Has an HTTP/JSON gateway (`/v3/kv/range`, `/v3/lease/grant`, `/v3/watch`) usable from `fetch`, avoiding gRPC in Bun.
- **rqlite** (MIT; v9.4.x Mar 2026, v10.x May 2026, v10 nodes cannot join v9 clusters [verified]). Raft-replicated SQLite over HTTP, very easy from TS. Lacks first-class leases/TTL keys and watches, so leader leases and liveness must be emulated with timestamps (clock-dependent). Good for "config tables", weaker for fencing.
- **Consul**: BSL 1.1 since August 2023 [verified]; source-available, not OSI. Also brings gossip and a lot of surface. **Out** on licence and size.

### 2.2 How existing Postgres HA tools store "who is primary" and fence

- **Patroni** (4.0 released Aug 2024; 4.1.x current [verified]). DCS: etcd/etcd3, Consul, ZooKeeper, Kubernetes; the built-in PySyncObj Raft DCS is deprecated [verified]. Truth: a `/leader` key with a TTL; only the holder runs as primary and must refresh it every loop. Fencing: a primary that cannot refresh the leader key demotes itself (optionally a Linux watchdog reboots the box if Patroni hangs); `failsafe_mode` (since 3.0) lets a primary stay up during a DCS outage if it can reach all other members over the Patroni REST API [verified]. Epoch: the Postgres timeline plus `/history` [recall].
- **pg_auto_failover** (2.2; 2026 activity is distro packaging, no new upstream release found [verified]). Truth lives in a separate **monitor** (a Postgres instance with the `pgautofailover` extension) holding a state machine per node. Monitor is a SPOF for failover decisions but not for replication [verified]. Fencing: the state machine only promotes a standby after the primary is reported/assumed `demoted`, with timeouts; the old primary's keeper demotes itself when it loses both monitor and standby [recall].
- **CloudNativePG** (1.30). Uses a Kubernetes Lease object per cluster: a replica may promote only after the old primary's lease expires (`leaseDurationSeconds`) [verified]. Manual fencing via the `cnpg.io/fencedInstances` annotation, which stops postmaster [verified]. Kubernetes-only, so a reference model rather than a candidate.
- **Stolon**: cluster data in etcd/Consul/Kubernetes; sentinels elect a leader that writes the desired topology; a stolon proxy only routes to the master named in cluster data and drops connections to an old one, which is the fence [recall]. Upstream last pushed mid-2024, effectively dormant [verified, low confidence on exact status].
- **Neon**: storage controller stores tenant **generation numbers** in its own Postgres DB; pageservers must validate their generation with the controller before deleting or publishing data, so a stale pageserver's writes are rejected [verified]. Safekeepers run a Paxos-like protocol with **terms**: a new compute must win a term from a quorum of safekeepers, after which the old compute's WAL appends are refused [recall, Neon docs only confirm Paxos/quorum].

Common pattern: (a) a small strongly-consistent store holds `{primary, term}`; (b) the term only goes up, via compare-and-set; (c) **fencing is enforced at the data path** (proxy routing, storage refusing stale generations, primary self-demotion on lease loss), not just by writing the record.

### 2.3 Postgres as the shared store

Tempting (it is already there), but circular for Postgres failover: the store that decides who the primary is would itself need HA and failover, which is the problem being solved. pg_auto_failover accepts this by making the monitor a separate, non-replicated Postgres and living with it as a SPOF. A single Postgres also gives no majority semantics across 3 nodes. Fine for non-critical cluster metadata if replicated from the consensus store, not as the source of truth.

### 2.4 Gossip/SWIM vs consensus

- **Gossip (memberlist/SWIM, Serf; Go, MPL-2.0 [recall])**: scalable, eventually consistent liveness and failure detection ("who seems up"). Can disagree during partitions. Not safe for "who is primary".
- **Consensus (etcd)**: linearizable truth with majority; requires quorum to make progress.
- For 2 to 10 nodes gossip adds little: etcd leases (each daemon keeps a lease-bound `/nodes/<id>` key) already give membership and liveness, and the mesh layer (Tailscale/NetBird) shows peer reachability. **Skip gossip.**

### 2.5 Two nodes with a witness

- **Patroni**: needs a DCS majority; standard advice is 3 etcd members, so with 2 Postgres nodes the third etcd member runs on a tiny witness box with no Postgres [recall].
- **pg_auto_failover**: the monitor is effectively the witness (primary + standby + monitor) [verified architecture].
- **Others** (Pacemaker qdevice, SQL Server/Windows file share witness, MongoDB arbiter): all "third vote without data" [recall].
- **Minimal witness for Hobbyist**: a third cheap VPS (or a Pi on a different network) running only the mesh client and one etcd member, plus a minimal daemon in "witness" mode that holds no resources. Roughly 1 vCPU, 512 MB RAM, SSD. Must sit in a different failure domain from both data nodes, otherwise it adds nothing.

---

## 3. Recommendation

### Network: Headscale + official Tailscale client (kernel mode, host network)

- Fits licence (BSD-3), self-hostable, real NAT traversal with DERP fallback (including an embedded DERP in Headscale), pre-auth keys map cleanly onto a `hobby join <token>` flow, ACLs available later, and the mesh **keeps working when Headscale is down**.
- Run `tailscaled` as a daemon-managed host-network container with `NET_ADMIN` and `/dev/net/tun` (kernel mode) so Postgres containers, etcd and the wake proxy can bind to the `100.x` address. Userspace mode is a fallback only (proxy, no routable interface).
- Run Headscale (single binary + SQLite) on one stable public node, with its DB backed up. Note upstream does not officially support containers or reverse proxies for Headscale; the daemon could run it as a managed binary instead.
- NetBird is the runner-up (more features, faster-moving) but AGPL server, more components and an IdP-centric setup cost more to maintain. Plain WireGuard is acceptable only if every node has a public IP; it fails the "home behind NAT" requirement without rebuilding DERP.
- Ejectability: Hobbyist is ejectable because the data and compose files do not depend on the mesh; a user can drop the mesh and use public IPs or their own VPN.

### Shared truth: etcd sidecar (3 members; 2 nodes + witness)

- One etcd member per node up to 3 (or 5 at most); further nodes are clients only. With 2 nodes, the third member is the witness. Peer and client traffic over mesh IPs, plus etcd TLS (defence in depth, the mesh is already encrypted).
- Do not embed Raft; do not use Postgres or gossip for truth; rqlite is the fallback if etcd ops prove too heavy, at the cost of building leases yourself.

### What the daemon must build

1. Join flow: issue Headscale pre-auth key, bring up tailscaled, add etcd member (`member add` then start), write `/nodes/<id>` bound to a lease.
2. Placement records: `/projects/<id>/primary = {node, term}`, changed only via etcd Txn comparing the key's `mod_revision` (or the previous term). Term is a monotonically increasing integer (or simply the etcd revision of the write).
3. Fencing on the data path: the wake proxy only forwards to the node named in the current record and refuses if its own term is stale; a node that loses its etcd lease or sees a higher term stops/demotes its Postgres (Patroni-style self-demotion). Consider passing the term into the app layer for writes that leave the box.
4. Operator commands for manual move/promote that bump the term, with a timeout wait for the old primary's lease to expire (CloudNativePG pattern).
5. etcd lifecycle: bootstrap, member add/remove, snapshots (`etcdctl snapshot save`), disaster recovery from snapshot when quorum is lost, version upgrades.
6. Client: use etcd's HTTP/JSON gateway from Bun `fetch`, or the `etcd3` npm client if `@grpc/grpc-js` works under Bun **[uncertain, test it]**.

### Main risks

- **Quorum loss** freezes changes: with 3 members, losing 2 blocks all placement changes until recovered. Needs a documented recovery runbook (force new cluster from snapshot).
- **Split brain if fencing is only advisory**: writing a new term does not stop an isolated old primary; self-demotion on lease loss and proxy checks are mandatory.
- **WAN latency and DERP-relayed links** between etcd members cause elections; tune heartbeat/election timeouts and prefer direct paths. Disk fsync latency on cheap VPS is a known etcd failure mode.
- **Headscale is single-instance**: outage blocks joins and key changes, not traffic; node key expiry during an outage can drop a node, so disable expiry for server nodes or monitor it. Headscale is still 0.x and tracks Tailscale protocol changes (minimum client version bumps).
- **Bootstrap ordering**: etcd runs over the mesh, mesh control lives on one node; the first node must bring up Headscale, tailscaled, then etcd.
- **Witness placement**: a witness in the same provider/region as a data node gives false safety.

### Explicit uncertainties

- Footprint numbers for etcd, tailscaled and Headscale are recalled, not measured; benchmark on target VPS.
- NetBird's exact self-hosted component set in v0.83 (combined server) not fully confirmed.
- Neon safekeeper term mechanics beyond "Paxos with quorum" not confirmed from primary docs this session.
- Stolon and innernet maintenance status not confirmed from primary GitHub pages.
- Bun compatibility with `@grpc/grpc-js` for the `etcd3` client is untested.

---

## Sources

- Headscale README (single tailnet, container stance): https://raw.githubusercontent.com/juanfont/headscale/HEAD/README.md
- Headscale releases (v0.29.7, 30 Oct 2026): https://github.com/juanfont/headscale/releases
- Tailscale, coordination server down: https://tailscale.com/kb/1091/what-happens-if-the-coordination-server-is-down
- Tailscale userspace networking: https://tailscale.com/kb/1112/userspace-networking/
- Tailscale Docker parameters: https://tailscale.com/docs/features/containers/docker/docker-params
- NetBird AGPL announcement: https://netbird.io/knowledge-hub/netbird-agpl-announcement
- NetBird releases (v0.83.2, 20 Nov 2026): https://github.com/netbirdio/netbird/releases
- NetBird incident write-up (existing P2P stayed up): https://status.netbird.io/incidents/01KPNY357W1CA1NMH22MZPKHC7/write-up
- ZeroTier 1.16 licensing: https://docs.zerotier.com/changelog/2025/08/21/zt1-v1.16.0
- Netmaker Apache-2.0 switch: https://netmaker.io/resources/netmaker-goes-open-source-why-we-switched-to-apache-2-0
- innernet releases: https://newreleases.io/project/github/tonarino/innernet/release/v1.7.1
- etcd releases: https://github.com/etcd-io/etcd/releases
- etcd v3.6 announcement: https://etcd.io/blog/2025/announcing-etcd-3.6/
- OpenShift etcd 3.6 memory bug: https://issues.redhat.com/browse/OCPBUGS-76329
- rqlite v10 changes: https://build.opensuse.org/projects/openSUSE/packages/rqlite/files/rqlite.changes?expand=0
- HashiCorp BSL: https://hashicorp.com/de/blog/hashicorp-adopts-business-source-license
- JS Raft packages: https://npmjs.com/package/@coaty/consensus.raft , https://npmjs.com/package/liferaft
- Patroni DCS failsafe mode: https://patroni.readthedocs.io/en/master/dcs_failsafe_mode.html
- Patroni releases: https://github.com/patroni/patroni/blob/master/docs/releases.rst
- pg_auto_failover architecture: https://sources.debian.org/src/pg-auto-failover/2.0-2/docs/architecture.rst
- pg_auto_failover monitor SPOF discussion: https://tapoueh.org/blog/2021/11/an-introduction-to-the-pg_auto_failover-project/
- CloudNativePG failover (Lease): https://cloudnative-pg.io/docs/1.30/failover
- CloudNativePG fencing: https://cloudnative-pg.io/docs/1.30/fencing
- Stolon: https://github.com/sorintlab/stolon
- Neon storage controller: https://github.com/neondatabase/neon/blob/main/docs/storage_controller.md
- Neon architecture: https://neon.com/docs/introduction/architecture-overview
