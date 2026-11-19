# The standby pair: zero-downtime work on one box, then a second box

Status: PROPOSED. Nothing in this document is built. Phases B and C depend on
ADR 0023 being accepted; Phase A does not depend on it and can start on its own.
Date:   2026-11-18

Implements `docs/decisions/0023`. Evidence and citations for every borrowed
idea are in `../research/2026-11-18-ha-prior-art.md`; this document cites them
by section rather than repeating them.

## What this builds, in one paragraph

A project that cannot go down gets a second, continuously updated copy of its
Postgres on a second machine, apps running on both machines, and a front door on
both machines that always sends writes to whichever copy is currently primary.
If the primary machine dies, a person (Phase B) or a three-way vote (Phase C)
promotes the copy. Acknowledged writes are not lost while the copy is healthy.
Open connections drop and clients reconnect; new connections wait at the proxy
instead of failing. Everything else on the install, including every project
that sleeps, is exactly as it is today.

## Words used below

| Word | Meaning |
|---|---|
| **Box** | One machine running one Hobbyist daemon. The daemon lock (`/tmp/hobby-daemon.lock`, `packages/cli/src/daemon/single-instance.ts`) still allows one per machine. |
| **Primary box / standby box** | Per project, not per machine. In Phase B and C all HA projects share one primary box, so the words are also used for machines. Mixed placement is out of scope. |
| **Witness** | `hobby witness`, a small Bun process with no Docker and no data. Holds the current term per project and votes. Phase C only. |
| **Term** | An integer per HA project, incremented by every promotion. The box holding the current term is primary. |
| **HA project** | A pinned project with `hobby ha on` applied. |

## Targets, stated so they can be measured

| | Target | How it is checked |
|---|---|---|
| RPO, standby healthy, default mode | 0 acknowledged commits lost | Chaos test C2 below |
| RPO, standby lost, default mode | Unbounded until it returns; failover disabled meanwhile | Test C4 |
| RTO, manual failover (Phase B) | Under 10 s from `hobby failover` to the first accepted write | Test B3 |
| RTO, automatic (Phase C) | Under 30 s from primary power-off to the first accepted write | Test C1 |
| Planned switchover (Phase B) | Under 5 s of refused or held new connections | Test B4 |
| Write latency added by sync | Measured and printed by `hobby ha on`, not promised | `hobby ha status` |

These are targets to measure against, not claims. Results get filed in
`../research/` with the hardware and the distance between boxes, as
`docs/CLAUDE.md` requires for benchmarks.

## Phase A: zero downtime on one box

No ADR needed; every user benefits; nothing here involves a second machine.

**A1. App deploys start the new container before stopping the old one.**
Today `deployApp` (`packages/app/src/app.ts`) builds, then `replaceContainer`
stops and removes the old container and creates the new one under the same
name. Change: create the new container under a suffixed name on a fresh host
port, wait for its readiness probe (`waitListening`), switch the route in the
HTTP router and Caddy (`packages/cli/src/daemon/caddy.ts`, the dial target),
then stop the old container after a drain period (default 10 s), then rename.
A failed probe leaves the old container serving and the deploy fails loudly.
Workers get the same treatment through their runtime.

**A2. The Postgres proxy survives a daemon restart.** The proxy runs in the
daemon process (`startPgProxy` in `packages/cli/src/daemon/server.ts`), so a
daemon restart or upgrade drops every proxied connection. Two options, decided
by a spike:

- *Separate process.* Run the proxy as its own long-lived process that talks to
  the daemon over the unix socket. A daemon restart then leaves sessions up; only
  a proxy upgrade drops them, and that is rarer.
- *Listener handoff.* On upgrade, pass the listening socket to the new daemon
  (the technique HAProxy uses, research section "standard tools"). Simpler to
  ship, but existing sessions still end with the old process.

Recommendation: the separate process, because it is the only option that keeps
established sessions across a daemon upgrade. It keeps the seam "the proxy
asks, the engine acts", since the proxy already only calls `wake()` through
`ProxyDeps` (`packages/proxy/src/proxy.ts`).

**A3. New connections wait instead of failing during a Postgres restart.** A
settings change recreates the container (`packages/cli/src/daemon/pg-settings.ts`).
The proxy already holds a connection while a database wakes
(`packages/proxy/src/proxy.ts`, the wake race). Mark the resource as
`restarting` for the duration so the same path holds new connections instead of
refusing them. Open sessions still end; the CLI already says so.

## Phase B: the pair, with manual failover

### B1. Pairing two boxes

```
standby$ hobby pair https://primary.example.com --token-file ~/.config/hobby-pair-token
```

- The token is an ADR 0018 API token created on the primary with
  `hobby token create pair-<standby-name>`. It is read from a file, never
  accepted as an argument, the same rule `hobby import` follows.
- Pairing records the peer in `state.db` on both boxes (new table `peers`:
  name, URL, role, token hash on the receiving side, paired_at).
- The two daemons talk over the existing HTTP API with bearer tokens, over TLS
  only. `hobby pair` refuses a plain `http://` URL unless both are on loopback
  (for tests).
- One pair per install. A second `hobby pair` is refused until `hobby unpair`.

### B2. Turning HA on for a project

```
$ hobby ha on shop            # default: sync while healthy
$ hobby ha on shop --strict   # block writes when the standby is lost
```

Refusals, each with the command that fixes it:

- The project can sleep: "pin it first: hobby pin shop" (pinning is
  `sleepAfterSeconds === null`, `packages/core/src/types.ts`).
- No peer: "pair a standby first: hobby pair <url>".
- The project has a kind that holds state outside Postgres: a worker with
  Durable Objects, a queue, a bucket or a volume (ADR 0023, decision 8).
- The peer's Postgres image differs from this box's (`HOBBY_IMAGE`,
  `packages/core/src/config.ts`). A replica must run the same major version.

What `ha on` does, in order, each step reversible by `ha off`:

1. Creates a replication role `hobby_replicator` with a random password in each
   Postgres resource of the project, stored the same way the resource's own
   password is stored today.
2. Recreates the primary container with the replication settings the daemon
   owns (B3). This is one restart of about a second, which the CLI states and
   which needs `--allow-pause` because the project is pinned, using the same
   guard as settings changes (`assertPauseAllowed`,
   `packages/cli/src/daemon/branch.ts`).
3. Asks the peer to create the standby (B4).
4. Waits until the standby is streaming and caught up, then turns synchronous
   commit on (B5).
5. Deploys the project's apps and workers on the peer (B7).
6. Prints the measured round trip and the added write latency.

`hobby unpin` refuses a project with HA on. `hobby ha off` reverses the steps
and leaves the primary exactly as a single-box project, with no replication
role, settings or slot left behind.

### B3. Settings the daemon owns on an HA primary

Passed as `-c` arguments like every other setting (`settingsCommand`,
`packages/pg/src/settings.ts`), never written into `postgresql.conf`:

| Setting | Value | Why |
|---|---|---|
| `wal_level` | `replica` (the default, set explicitly) | Physical replication |
| `max_wal_senders` | `4` | The standby, `pg_basebackup`, headroom |
| `max_replication_slots` | `4` | One slot per standby, headroom |
| `max_slot_wal_keep_size` | 10% of the data volume, minimum 2 GB | The GitLab lesson: a lost standby must not fill the primary's disk |
| `wal_log_hints` | `on` | So `pg_rewind` can rejoin an old primary (checksums are on by default in 18, but data directories made by older images may not have them) |
| `synchronous_standby_names` | `ANY 1 (hobby_standby)` or empty | Toggled by the degrade rule (B5) |
| `hba_file` | `/etc/hobby/pg_hba.conf` (read-only mount) | B4 |

`settings.ts` keeps refusing all of these from the user, and its comment that
one box has no standby gets a dated note pointing here. Applied with a reload
(`pg_reload_conf()`) where Postgres allows it, so toggling sync never restarts.

### B4. Creating the standby

The replication path must cross machines, and today it cannot: the image's
`pg_hba.conf` admits replication only on the local socket and 127.0.0.1
(`packages/cli/src/daemon/basebackup.ts`, header comment). The path chosen:

- **Through the proxy, over TLS.** The standby's Postgres connects to the
  primary box's proxy with `replication=true`. The proxy admits a replication
  startup **only** from the paired peer: TLS required (ADR 0019), the peer's
  address on the allowlist (`packages/proxy/src/access.ts`), and the
  `hobby_replicator` role. Everything else asking for replication is refused, as
  today.
- **`hba_file` points at a daemon-managed file** that holds the image's default
  lines plus one: `host replication hobby_replicator <gateway>/32 scram-sha-256`,
  where `<gateway>` is the address the proxy's connections appear from inside the
  container network. The data directory is untouched, so ADR 0003 holds.
- **`pg_basebackup -R -C -S hobby_standby`** run in a container on the standby
  box, writing into the standby's own data directory, then the standby container
  starts. `-R` writes `standby.signal` and `primary_conninfo` the standard way.
  That is plain Postgres.

The standby's Postgres is a normal resource on the standby box, with a state of
`standby` (new value in `ResourceState`, `packages/core/src/types.ts`). It is
pinned, never hibernated, and refused by every verb that would write to it
(branch, snapshot restore in place, settings, import), with a message naming the
primary box.

### B5. The degrade rule

Copied from pg_auto_failover (research, "standard tools"):

- **Healthy:** `synchronous_standby_names = 'ANY 1 (hobby_standby)'`. A commit
  returns after the standby has flushed it.
- **Standby lost** (no walsender for `standby_timeout`, default 20 s): default
  mode clears `synchronous_standby_names` and reloads, so writes continue. The
  project is marked `degraded` and **failover is disabled** until the standby
  is back within one WAL segment of the primary. `--strict` mode leaves the
  setting alone, so writes block, and says so in `hobby ha status`.
- **Caught up again:** sync is turned back on, `degraded` clears.

The daemon writes each transition to its log with a timestamp. The log has no
timestamps today; adding them is a prerequisite, and it is the same gap that
left the import stall in PR #223 unexplained.

### B6. Keeping two daemons' state in step

The primary box's `state.db` is the source of truth for HA projects. The
standby daemon pulls project and resource metadata for HA projects over the API
every 5 s and after every change notification. Rules:

- Writes to an HA project's metadata are refused on the standby box, with the
  primary's URL in the message.
- Only HA projects are synchronised. Each box's other projects are its own.
- Secrets (database passwords, the replicator password) travel only over the
  TLS API and are stored the same way on both sides.

### B7. Apps and workers on both boxes

Stateless apps and workers of an HA project are deployed on both boxes from the
same build artefact (the image tag `deployApp` already records). Each box's
Caddy serves them. Their `DATABASE_URL` points at their own box's proxy
(`host.docker.internal:<proxyPort>`, `packages/app/src/app.ts`), and that proxy
sends them to the primary (B8). So an app on the standby box works, with one
extra network hop for its queries.

Getting HTTP traffic to both boxes is the user's choice and is documented, not
built: two DNS A records, a floating IP from the VPS provider, or a load
balancer. Hobbyist does not manage DNS (root `CLAUDE.md`, out of scope).

### B8. The proxy routes to the primary

Every path converges on `ProxyDeps.resolve` (`packages/proxy/src/proxy.ts`), and
its daemon implementation hardcodes `host: '127.0.0.1'` in `targetFor`
(`packages/cli/src/daemon/context.ts`). For an HA project:

- On the primary box, `targetFor` is unchanged.
- On the standby box, `targetFor` returns the primary box's proxy address, and
  the connection is forwarded over TLS. Clients can therefore use either box's
  address, or a libpq list such as
  `host=a.example.com,b.example.com target_session_attrs=read-write`.
- During a switch (B9), `resolve` returns the `waking` state it already uses for
  a sleeping database, so new connections are held up to `wakeTimeoutMs`
  instead of refused. This is what Xata's gateway does during a CloudNativePG
  failover (research, "Xata").
- **The term check.** `targetFor` returns the current term with the target,
  and the forwarded connection carries it. A proxy that receives a connection
  carrying a term other than the one it holds refuses it. That stops a stale
  primary from receiving writes even if both are running.

### B9. Manual failover and switchover

```
standby$ hobby failover shop            # the primary is gone
primary$ hobby switchover shop          # planned: both are healthy
```

**Switchover** (planned, both healthy): the primary holds new connections at
its proxy, terminates sessions on the HA project, waits for the standby to
replay up to its final LSN, shuts down, and the standby promotes with
`pg_promote()`. The old primary rejoins as a standby with `pg_rewind`. The term
increments. No acknowledged write can be lost, and the gap is the hold time.

**Failover** (primary unreachable): refused unless all three hold, each with
its own message:

1. The project is not `degraded` (the standby was in sync when last seen), or
   `--accept-data-loss` is passed and the CLI prints how far behind it was.
2. The primary box does not answer the API, checked again at the moment of
   promotion.
3. The operator types the project name to confirm (CLI), or passes
   `confirm: "<project>"` (MCP).

It then promotes with `pg_promote()`, increments the term, and starts routing
to itself. **The old primary must not come back as primary.** In Phase B
that is enforced by the term (B8) and by the old primary's daemon: on start, a
daemon whose peer holds a higher term for an HA project starts that project's
Postgres as a standby after `pg_rewind`, never as primary. If `pg_rewind` fails,
it leaves the old data directory untouched under a dated name and rebuilds the
standby from scratch (B4), and says so. It never deletes a data directory
automatically: the GitLab lesson.

### B10. Rebuilding a standby

`hobby ha rebuild shop`, run on the standby box, can only touch the standby's
data directory. It refuses on the primary box. It moves the old directory aside
under a dated name, then repeats B4.

## Phase C: the witness and automatic failover

Starts only after Phase B has run on the author's own HA projects (ADR 0023,
"Consequences"), and after the pg_auto_failover spike (C0).

### C0. Spike: can pg_auto_failover be the coordinator?

Time-boxed to one week. Question: can `pg_autoctl` manage Postgres on HA
projects while the daemon keeps ownership of container creation, `-c` settings,
snapshots and eject? If yes, adopt it for C1 to C4 and keep only the proxy and
term parts below. If not, build the coordinator described here, which copies its
timings and its degrade rule. File the result in `../research/`.

### C1. The witness

```
witness$ hobby witness --listen 0.0.0.0:7439 --token-file ~/.config/hobby-witness-token
primary$ hobby ha witness https://witness.example.com:7439 --token-file ...
```

- A Bun process, one SQLite file, no Docker. Runs on any third machine: a
  smaller VPS, a home server, a Raspberry Pi.
- Stores, per HA project: current term, the box holding it, the last LSN each
  box reported, and the last time each box checked in.
- Both boxes check in every 5 s.

### C2. Who may be primary

- The primary holds a **lease** from the witness for the current term,
  15 s long, renewed every 5 s (CloudNativePG's lease shape).
- The standby may promote only if the witness grants it the next term. The
  witness grants it only when the primary's lease has expired **and** the
  standby's last reported LSN is at least the primary's last synchronous LSN
  (that is, the project was not `degraded`).
- **Isolation rule:** a primary that cannot renew its lease **and** cannot reach
  the standby stops accepting writes when the lease expires: its proxy refuses
  new connections and terminates sessions on HA projects, and Postgres is shut
  down. This is pg_auto_failover's `DEMOTE_TIMEOUT` and CloudNativePG's
  isolation check (research, "standard tools").
- A primary that cannot reach the witness but can reach the standby keeps
  serving (Patroni's `failsafe_mode`), since the standby will not promote
  without the witness either.

### C3. Timings

| Step | Default |
|---|---|
| Check-in interval | 5 s |
| Lease | 15 s |
| Standby declared lost (degrade, B5) | 20 s |
| Failover starts after lease expiry | immediately |
| Promotion and first accepted write | measured; target under 30 s total |

### C4. Witness down

Replication continues, the primary keeps its role, nothing fails over
automatically, and `hobby failover` still works by hand. `hobby ha status`
shows the witness as unreachable. This matches pg_auto_failover with its monitor
down.

## Surface: API, CLI and MCP

One daemon route per verb, a CLI verb and an MCP tool with the same name and
errors (`docs/mcp/CLAUDE.md`, the parity rule).

| CLI | MCP tool | Route | Phase |
|---|---|---|---|
| `hobby pair <url> --token-file` | `hobby_pair` (takes `tokenFile` only) | `POST /v1/peers` | B |
| `hobby unpair` | `hobby_unpair` | `DELETE /v1/peers/:name` | B |
| `hobby ha on <project> [--strict]` | `hobby_ha_on` | `POST /v1/projects/:name/ha` | B |
| `hobby ha off <project>` | `hobby_ha_off` | `DELETE /v1/projects/:name/ha` | B |
| `hobby ha status [project]` | `hobby_ha_status` | `GET /v1/ha` | B |
| `hobby ha rebuild <project>` | `hobby_ha_rebuild` | `POST /v1/projects/:name/ha/rebuild` | B |
| `hobby switchover <project>` | `hobby_switchover` | `POST /v1/projects/:name/switchover` | B |
| `hobby failover <project>` | `hobby_failover` (requires `confirm`) | `POST /v1/projects/:name/failover` | B |
| `hobby witness` | none (a separate process) | none | C |
| `hobby ha witness <url>` | `hobby_ha_witness` | `PUT /v1/ha/witness` | C |

Also, independent of this work: there is no `hobby_pin` MCP tool today
(`packages/mcp/src/server.ts`), and `hobby ha on` requires pinning. It should
be added in Phase B.

## Failure modes, and what happens

| Event | Default mode | `--strict` |
|---|---|---|
| Standby box dies | Writes continue after up to 20 s of waiting; `degraded`; no failover possible until rebuilt | Writes block until the standby returns or `ha off` |
| Primary box dies (B) | Down until `hobby failover`; no acknowledged write lost if not `degraded` | Same |
| Primary box dies (C) | Standby promotes within the target; new connections held meanwhile | Same |
| Network split, witness with standby (C) | Old primary's lease expires, it stops writes; standby promotes | Same |
| Network split, witness with primary (C) | Primary keeps serving; standby cannot promote; `degraded` | Primary blocks writes |
| Witness dies (C) | Nothing changes except no automatic failover | Same |
| Old primary returns after failover | Started as a standby via `pg_rewind`; refused by every proxy for writes because of the term | Same |
| Standby lag passes `max_slot_wal_keep_size` | Slot invalidated; `hobby ha status` says rebuild; nothing deleted | Same |
| Disk full on primary | Unchanged from today; the slot cap stops replication being the cause | Same |

## Security

- **Daemon to daemon:** ADR 0018 bearer tokens over TLS, created with a name per
  peer so `hobby token rm` revokes a lost pair.
- **Replication:** a dedicated role per database, `scram-sha-256`, admitted only
  by the proxy from the peer's allowlisted address over TLS, and only by one
  `pg_hba` line naming that role.
- **Witness:** its own token; it holds no database credentials and no data. A
  stolen witness token can, at worst, deny failover, never cause it, because a
  promotion also requires the standby's own daemon to agree it is caught up.
- **Secrets on disk:** token files are read from paths, never accepted as
  arguments or MCP values, as with `hobby import`.

## Eject

`hobby eject` on the primary box produces today's single-box output and strips
the daemon-owned replication settings and the `hba_file` mount from the
compose `command:`, with a line saying HA was not carried over. On the standby
box, eject refuses an HA project and names the primary. Leaving stays one
command (root `CLAUDE.md`, promise 1).

## Testing

The daemon lock is machine-wide, so two boxes cannot be two daemons on one
machine. Tests use:

- **Unit:** the degrade rule, the term check in `targetFor`, the failover
  refusals, the witness grant rule, against fakes, as the proxy is tested today.
- **Live smoke, CI:** two or three containers on one Docker network, each
  running a daemon with Docker-in-Docker or the host socket under a separate
  `HOBBY_HOME` and lock path. Making the lock path configurable for tests is a
  prerequisite.
- **Chaos tests, before each phase ships:**
  - B3: manual failover time, primary container killed.
  - B4: switchover gap under a steady write load.
  - C1: primary box powered off (container killed with its network removed).
  - C2: a write loop with a recorded commit log; after failover, every
    acknowledged commit is present on the new primary.
  - C3: partition the primary from the witness and the standby; it must stop
    writes within lease plus one interval.
  - C4: kill the witness; nothing fails over.

## Docs that change when this ships

- Root `CLAUDE.md`: promise 2 and the out-of-scope list get a dated note
  pointing to ADR 0023. (Separately, its "The wedge" section still says Xata
  cannot wake a database; #224 fixed the README and site but not this file.)
- `docs/backups/CLAUDE.md`, `docs/engine/CLAUDE.md`, `docs/compute/CLAUDE.md`,
  `docs/storage/CLAUDE.md`, `docs/queues/CLAUDE.md`: each lists HA or
  multi-node as out of scope; each gets a dated note.
- `packages/pg/src/settings.ts`: the comment on `synchronous_commit` and the
  replication refusals.
- A guide, `site/.../guides/standby-pair.md`, that says "open connections drop
  on failover; make your app retry" in its first paragraph.

## Open questions for review

1. **Phase A first, on its own?** It needs no ADR and benefits every user.
   Recommended: yes, ship A before B starts.
2. **Is the proxy-as-fence plus a term enough without hardware fencing?**
   Recommended: yes for Phase B (no automatic promotion exists to race), and
   Phase C adds the lease and isolation rule. A watchdog (Patroni) is not
   proposed.
3. **Default mode: degrade to async, or strict?** Recommended: degrade, as
   pg_auto_failover does, because a pinned project that stops taking writes
   when a backup machine dies has made the backup machine a new way to go down.
4. **Should Durable Objects and queues ever be covered?** Not proposed. Each
   would need its own replication design and its own ADR.
5. **pg_auto_failover or our own coordinator?** Decided by the C0 spike, not
   now.
