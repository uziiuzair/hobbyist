# 0023. A standby pair, opt-in, for projects that cannot go down

Status: PROPOSED
Date:   2026-11-18

Reopens one item on the out-of-scope list in the root `CLAUDE.md` ("Kubernetes,
clustering, multi-node anything. One box.") and in ADR 0007 (guard 4), and
reopens it narrowly. Starts the `availability/` capability. Leaves ADRs 0001
through 0005 untouched, and leaves the default install exactly as it is.

## Context

The request is for users who "can't bear the loss of any downtime at all."
Taken literally that is not a property any Postgres platform offers. The survey
in `docs/availability/research/2026-11-18-ha-prior-art.md` found that Neon,
Supabase, Xata and the standard tools all drop open connections on a failover
and tell clients to retry. What they offer is a short gap, no lost acknowledged
writes, and survival of a dead machine.

Today a Hobbyist project can go down for these reasons:

| Cause | Today | Needs a second machine? |
|---|---|---|
| App deploy | stop then start (`replaceContainer`, `packages/app/src/app.ts`) | No |
| Daemon restart or upgrade | the proxy is in-process (`startPgProxy`, `packages/cli/src/daemon/server.ts`), so live connections drop | No |
| Settings change | the container is recreated, about one second | No |
| Host reboot, kernel or Docker upgrade | everything is down until it returns | **Yes** |
| Disk or machine lost | restore the last snapshot; writes since then are gone (ADR 0016) | **Yes** |

The first three affect every user and need no decision here; they are Phase A
of the spec and are built inside the current scope. **The last two cannot be
fixed on one box by definition.** That is the whole question this ADR answers.

Three things argue against answering it at all, and they are real:

1. **Promise 2, "It runs on one box."** The root `CLAUDE.md` says "If a feature
   requires a cluster, it is out of scope."
2. **The wedge.** ADR 0007: "A capability that cannot sleep does not obviously
   belong here." A database that must never be unavailable cannot sleep, since a
   wake costs up to a second.
3. **Scope is this project's main risk.** High availability is the classic
   feature that is easy to start and hard to finish, and the GitHub (2018) and
   GitLab (2017) incidents in the survey are what a half-finished one looks like.

## The decision

**Hobbyist may run as a standby pair: one primary box, at most one standby box,
and one witness. It is opt-in per project, it applies only to pinned projects,
and a single box remains the default and the documented way to run Hobbyist.**

Each of the following could have gone the other way.

**1. A pair, never a cluster.** Exactly one primary and at most one standby,
both owned by the same person. No second standby, no read scaling, no sharding,
no multi-primary, no scheduler that places workloads across machines, no
Kubernetes. Each of those still needs its own ADR. The line is drawn at "two
copies of one box" because that is the smallest thing that survives losing a
machine, and anything larger is a different product that Xata and CloudNativePG
already build well.

**2. Opt-in per project, and only for pinned projects.** `hobby ha on <project>`
refuses a project that can sleep (`sleepAfterSeconds !== null`,
`packages/core/src/types.ts`), and `hobby unpin` refuses a project with HA on.
This is how the wedge stays intact: sleep is unchanged for every other project,
on both boxes. A project that cannot tolerate a one-second wake already has to be
pinned today; HA does not move that line, it only adds a second copy behind it.
Under ADR 0007's tie-break, the wedge wins wherever the two meet, and they meet
only on projects the user has already chosen to keep awake.

**3. Plain Postgres streaming replication.** The standby is an ordinary
physical replica, so its data directory is a plain PGDATA and ADR 0003 holds on
both boxes. No safekeepers, no shared storage, no Neon-style separation: ADR
0001 already rejected that shape, and the survey confirms it needs three or more
storage nodes plus a control plane. Postgres stays unmodified; no extension is
required.

**4. Synchronous while healthy, asynchronous with failover disabled when not.**
Copied from pg_auto_failover's default. While the standby is connected and
caught up, a commit is acknowledged only after the standby has flushed it, so a
failover loses no acknowledged write. When the standby is gone, the primary
keeps accepting writes asynchronously and automatic failover is disabled until
the standby catches up, so the stale copy can never be promoted. A per-project
`--strict` mode blocks writes instead, for users who prefer stopping to any risk
of loss.

**5. Failover is manual first, automatic only with a witness.** Two machines
cannot tell "the other one is dead" from "I cannot see the other one", and the
GitHub incident is what happens when software guesses. So:

- With two boxes, failover is `hobby failover`, run by a person.
- Automatic failover needs a third voter, the **witness**: a small process with
  no Docker and no data, on any third machine. A box may promote only with the
  witness's vote, and a primary that can see neither the witness nor the standby
  stops accepting writes after a timeout.
- With the witness down, replication continues and nothing fails over
  automatically, which is pg_auto_failover's behaviour.

**6. Every primary carries a term number.** Each promotion increments a term
recorded by the witness. The proxy routes writes only to the box holding the
current term. This is the idea Neon uses for safekeepers, applied to one
question: a stale primary that comes back is recognised and refused by the
front door, rather than relying on fencing alone.

**7. The proxy is the fence.** Every client already reaches Postgres through the
proxy: external clients, and apps and workers through `DATABASE_URL`
(`packages/app/src/app.ts`). That makes the proxy the one place where "who is
primary" is enforced. Both boxes run the proxy; on the standby box it forwards
to the primary. There is a single code point to change, `targetFor` in
`packages/cli/src/daemon/context.ts`.

**8. Only stateless kinds and Postgres are covered.** A project with Durable
Object state, a queue backlog, a bucket or a volume is refused by `hobby ha on`
in this decision. Those kinds keep state in files outside Postgres
(ADR 0016, part 1), and replicating each is its own design. Apps and workers
without durable state run on both boxes.

**9. Leaving still works.** `hobby eject` on either box produces the same
single-box `docker-compose.yml` as today, for the primary only, and says so. The
standby can be discarded at any time with no effect on the primary.

## Consequences accepted

- **Promise 2 gets a qualifier.** "It runs on one box" becomes "it runs on one
  box, and a project that cannot go down can have a second." The default install,
  the docs' first page and every existing guide stay single-box.
- **HA projects never sleep.** A project with HA on costs a running Postgres on
  two machines. That is the price, and it is stated in the CLI output.
- **Synchronous commit adds a network round trip to every write** on an HA
  project. Across a city it is negligible; across an ocean it is not, and the
  spec measures it and warns.
- **Open connections drop on failover.** The proxy holds new connections during
  the switch, but a session in progress is lost, as on Neon, Supabase and Xata.
  Apps must retry. The docs say this plainly instead of saying "zero downtime".
- **A surface that did not exist:** daemon-to-daemon trust, replication users,
  `pg_hba` entries for replication, a witness process, and the state replication
  between two daemons. Each is a place to get security wrong, and the spec names
  how each is closed.
- **Settings change shape.** `packages/pg/src/settings.ts` refuses replication
  settings and allows only `on`, `off` and `local` for `synchronous_commit`
  because "one box does not have" a standby. On an HA project the daemon sets
  those itself; the user still cannot.
- **The build is larger than any single capability so far.** It is phased so
  that each phase is useful alone: Phase A (single-box zero-downtime work)
  benefits every user, Phase B (manual failover) is complete without Phase C, and
  Phase C ships only after Phase B has run on the author's own projects.

## Alternatives rejected

- **Do nothing; recommend Neon or Supabase for these projects.** Honest, and
  still the right answer for anyone who needs an SLA. Rejected only because the
  same user is already running everything else on Hobbyist and the pair is the
  smallest step that removes the single machine as a cause of loss.
- **Adopt pg_auto_failover wholesale.** It is the closest match in behaviour,
  and decision 4 copies it. But `pg_autoctl` creates and runs Postgres itself,
  which collides with how the daemon owns every container
  (`containerSpec` in `packages/pg/src/postgres.ts`), with settings as `-c`
  arguments (ADR 0022), and with hibernation. The spec keeps a time-boxed spike
  on it before Phase C, and adopts it if the collision turns out to be shallow.
- **Patroni.** Needs a three-member consensus store such as etcd as well as the
  witness role; more moving parts than the problem has.
- **Kubernetes with CloudNativePG.** Already exists, already open source, and
  is exactly the cluster the root `CLAUDE.md` rules out.
- **Neon-style quorum storage.** Rejected by ADR 0001 for one box; still
  rejected for two.

## What would have to change to revisit

**Retreat to one box** if, six months after Phase B ships, no project on the
author's own install has HA turned on. The feature would then be occupying
attention without serving daily use, which is the failure ADR 0007 names. The
retreat is cheap by design: HA is per project and the single-box path never
changed.

**Widen past a pair** only if a recorded incident shows a pair losing a project
that a third copy would have saved. Not on a whiteboard argument.

**Drop the homegrown coordinator for pg_auto_failover** if the Phase C spike
shows the daemon can delegate Postgres lifecycle on HA projects without breaking
eject, settings or snapshots.
