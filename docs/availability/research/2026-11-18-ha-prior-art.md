# How Neon, Supabase, Xata and the standard Postgres tools stay up

Status: NOTES. A survey, not a decision. ADR 0023 and
`specs/2026-11-18-standby-pair-design.md` are where it is used.
Date:   2026-11-18

Read for one question: what does a Postgres platform need in order to survive
losing a machine, and which parts of that fit a platform whose second promise is
"it runs on one box"? Every claim below is cited to a file at a commit or to a
docs page fetched on this date. Where something could not be verified, it says
so.

Commits read: `neondatabase/neon@fa504217c61b`, `supabase/supabase@26d0aa5e`,
`supabase/supavisor@e59909dc`, `xataio/xata@f8e684bc`,
`cloudnative-pg/cloudnative-pg@3a324706`.

## The one-line answer

Nobody offers "no downtime at all." Every system surveyed drops open
connections on failover and tells clients to retry. What differs is how long the
gap is, whether acknowledged writes can be lost, and how many machines it takes
to decide safely who the primary is. **The smallest safe answer anyone ships is
three voters**, and every design that skips the third one either refuses to fail
over automatically or accepts split-brain risk.

## Neon

- **Durability is a quorum of three safekeepers.** A commit is acknowledged only
  after a majority of safekeepers have it on disk (`docs/walservice.md`,
  `docs/safekeeper-protocol.md`). Fewer than three is refused outside `--dev`
  (`storage_controller/src/main.rs`, `timeline_safekeeper_count`).
- **No hot standby compute.** Neon says it avoids "idle standby compute
  replicas". A crashed Postgres is restarted in seconds; a lost node takes 1 to
  2 minutes; an availability zone 1 to 10 minutes. Temp tables, prepared
  statements and caches are lost and apps must reconnect
  (https://neon.com/docs/introduction/high-availability).
- **Split brain is prevented with terms and generations, not fencing.** A WAL
  proposer must win a quorum vote for a higher term
  (`docs/safekeeper-protocol.md`, `docs/rfcs/013-term-history.md`); pageservers
  carry control-plane-issued generation numbers in their S3 keys
  (`docs/rfcs/025-generation-numbers.md`).
- **Planned restarts are not zero downtime either.** "Brief connection drops are
  expected during compute updates" (https://neon.com/docs/manage/updates). The
  prewarm RFC sketches a rolling restart through a warm replica and calls the
  gap after stopping the old primary a "critical section"
  (`docs/rfcs/2025-03-17-compute-prewarm.md`); whether it ships is not verified.
- **SLA:** 99.95% monthly, Business and Scale plans only
  (https://neon.com/neon-business-sla).

**What fits one box: nothing structural.** Neon's guarantees rest on three or
more safekeepers plus a control plane. ADR 0001 already rejected that shape.
What transfers is the idea of a **term number** that every primary carries, so
a stale one can be recognised and refused.

## Supabase

- **Self-hosted has no HA.** One `db` service in
  `docker/docker-compose.yml` (lines 484-487), and nothing in the self-hosting
  guide about replication or failover.
- **Cloud read replicas are asynchronous** "to ensure that transactions on the
  Primary aren't blocked", and are not presented as failover targets
  (https://supabase.com/docs/guides/platform/read-replicas).
- **Automatic failover exists only as Multigres, in alpha**, paid plans only,
  outside the SLA (https://supabase.com/docs/guides/database/multigres). Node
  count and sync mode are not documented. Whether ordinary projects use Patroni
  could not be verified.
- **Supavisor does not fail over.** Its README lists "connection buffering for
  transparent database restarts or failovers" as a feature but no code doing it
  was found in `lib/`; "Primary database election on primary failure" is under
  Future Work. On a dead backend it terminates the client with `08006`
  (`lib/supavisor/db_handler.ex` L1122-1134).
- **SLA:** 99.9%, Enterprise only (https://supabase.com/sla).

**What fits:** the honesty. Supabase's self-hosted product, the closest thing
to Hobbyist's audience, offers no HA at all, and its cloud ships failover as an
alpha. A two-box design here would be ahead of it, not behind.

## Xata (open source, on Kubernetes)

- **HA is CloudNativePG instances.** The Branch CRD defaults to one instance,
  up to five (`charts/branch-operator/crds/xata.io_branches.yaml` L301-307).
  Xata sets no `synchronous`, `minSyncReplicas` or `failoverDelay`, so
  replication is CNPG's default, asynchronous
  (`services/branch-operator/pkg/reconciler/resources/cluster.go` L216-261).
- **The gateway does not detect the primary.** It dials the CNPG `-rw`
  service, which follows the primary (`services/gateway/session/resolver.go`
  L73-77). On refused or unresolvable, it asks the clusters service for state:
  hibernated means wake and hold the connection up to 50 s; `Switchover` and
  `FailOver` mean hold and poll while an instance is available
  (`session/cluster_dialer.go` L167-262; `config.go` L23-25). Open sessions are
  not migrated.
- **CloudNativePG** fails over after `failoverDelay` (default 0 s) once the
  primary's readiness fails, shuts the old primary down, promotes the most
  advanced replica, and restarts the old one as a replica. Only the holder of a
  Kubernetes Lease may promote (15 s duration). A primary that cannot renew the
  lease and cannot reach a peer stops itself after about 10-13 s. Sync is off by
  default, and "some data loss is expected and accepted during failover"
  (`docs/src/failover.md`, `instance_manager.md`, `replication.md`).

**What fits:** the gateway shape. One front door that holds a new connection
while the cluster is between primaries, and asks a status service rather than
guessing, is exactly what Hobbyist's proxy already does for a sleeping database
(`packages/proxy/src/proxy.ts:860-899`).

## The standard tools

- **Postgres itself does not detect failure** and says so
  (https://www.postgresql.org/docs/18/warm-standby-failover.html). Promotion is
  `pg_promote()`. An old primary must be told it is no longer primary, or both
  act as primary, causing "confusion and ultimately data loss" (same page).
- **Synchronous commit levels** (`remote_write`, `on`, `remote_apply`) and
  `synchronous_standby_names` with `FIRST n` or `ANY n`
  (https://www.postgresql.org/docs/18/warm-standby.html). **If the only sync
  standby is down, commits hang** until the setting is lowered and reloaded.
- **Replication slots can fill the disk.** `max_slot_wal_keep_size` defaults to
  unlimited (https://www.postgresql.org/docs/18/runtime-config-replication.html).
- **`pg_rewind`** rejoins an old primary by copying changed blocks; needs data
  checksums (default from initdb in 18) or `wal_log_hints`
  (https://www.postgresql.org/docs/18/app-pgrewind.html).
- **pg_auto_failover** (PostgreSQL License, PG 13-18, v2.2 on 2025-04-03,
  commits through 2026-10-28): a monitor plus a keeper per node, works with two
  data nodes. Synchronous by default; when the standby is lost the primary goes
  to `wait_primary`, clears `synchronous_standby_names` and keeps accepting
  writes, with failover disabled until the standby catches up. With the monitor
  down, replication continues and nothing fails over. A primary cut off from
  both monitor and standby demotes itself after `network_partition_timeout`
  (20 s). Unhealthy after 20 s, health check every 5 s
  (https://pg-auto-failover.readthedocs.io/en/main/architecture.html,
  `.../fault-tolerance.html`, `.../ref/configuration.html`).
  **`pg_autoctl` creates and runs Postgres itself**, which matters below.
- **Patroni** (MIT): a leader lock in etcd, Consul, ZooKeeper or Kubernetes.
  etcd needs three members to survive one failure (https://etcd.io/docs/v3.5/faq/).
  `ttl` 30 s. A watchdog reboots a hung primary. `synchronous_mode` promotes
  only a sync standby (https://patroni.readthedocs.io/).
- **libpq** tries `host=a,b` in order; `target_session_attrs=read-write` skips a
  standby (https://www.postgresql.org/docs/18/libpq-connect.html).
- **PgBouncer and PgCat do not detect the primary**; roles come from config
  (https://www.pgbouncer.org/config.html, https://github.com/postgresml/pgcat).

## Incidents worth naming

- **GitHub, 2018.** A 43 s partition let the orchestrator promote primaries on
  the other coast; both sides then held writes the other lacked, and recovery
  took 24 h 11 m
  (https://github.blog/news-insights/company-news/oct21-post-incident-analysis/).
  Lesson: an automatic failover that can promote without a majority will
  eventually do it at the worst time.
- **GitLab, 2017.** A standby fell behind past the WAL the primary still had;
  during the resync an operator deleted the primary's data directory; backups
  had been failing silently
  (https://about.gitlab.com/blog/postmortem-of-database-outage-of-january-31/).
  Lessons: cap and alarm on lag, make "rebuild the standby" a single command
  that can only touch the standby, and verify restores.

## Recovery numbers, honestly

No system above publishes a measured failover time. From defaults, detection
alone is 20 s (pg_auto_failover), up to 30 s (Patroni), 40-55 s for a lost
Kubernetes node (CNPG). A design here should promise a range from its own
measurements, not borrow one.

## What this survey says to do

1. **Use plain streaming replication.** It is what every non-Neon system uses,
   and it keeps ADR 0003: a standby's data directory is a plain PGDATA.
2. **Require a third voter for automatic failover**, and fail over manually
   without one. Two machines cannot tell "the other one died" from "I cannot
   see the other one."
3. **Carry a term number**, as Neon's safekeepers do, so the proxy can refuse a
   stale primary instead of relying on fencing alone.
4. **Copy pg_auto_failover's degrade rule:** synchronous while the standby is
   healthy, asynchronous with failover disabled when it is not, and a strict
   mode for those who would rather stop than risk a lost write.
5. **Make the front door hold connections during a switch**, as Xata's gateway
   does, and tell users plainly that open connections drop, as Neon does.
