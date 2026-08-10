# 0012. Durable Objects, and the alarm mirror that lets them sleep

Status: ACCEPTED
Date:   2026-08-10

Extends the phase table in ADR 0007 with a resource kind it does not list.
Depends on ADR 0011, which chose workerd via Miniflare as the runtime for the
`worker` kind. Does not disturb ADRs 0001 through 0005.

## Context

ADR 0007 registers `postgres` in Phase 1, `app` and `worker` in Phase 2, and
`bucket` and `volume` in Phase 3. **Durable Objects appear nowhere in it**, nor in
the root `CLAUDE.md`, nor in `docs/compute/CLAUDE.md`, whose in-scope list stops
at apps, workers, builds, hostnames and logs. This is new scope, requested
directly, with Queues, Workers KV and D1 named as following it.

`docs/decisions/CLAUDE.md` requires an ADR for a new capability folder and for
anything that reopens the out-of-scope list. Both apply, so this is that record
rather than a spec written around the gap.

The honest framing: ADR 0007 widened scope once already and named the resulting
risk in its own consequences ("the named failure mode is now materially more
likely"). This widens it again. What follows is not an argument that the risk has
gone away. It is an argument that this particular addition is unusually cheap and
unusually on-wedge, plus the specific reasons it might still be wrong.

### Why this is not the usual scope creep

**A Durable Object is the wedge, at object granularity.** The root `CLAUDE.md`
says everything sleeps and everything wakes on demand, and that a capability
which cannot sleep does not obviously belong here. Durable Objects are named,
addressed on demand, idle to nothing, and wake on the next request. They are the
single primitive on any managed platform that most closely matches what this
project already exists to do.

**The runtime is already being stood up for another reason.** ADR 0011 commits to
Miniflare, which wraps workerd, for the `worker` kind. workerd implements Durable
Objects natively: actor addressing, single-threaded execution, input and output
gates, SQLite-backed transactional storage, alarms and WebSocket hibernation.
None of that is ours to build. The marginal cost of this capability is not a
runtime.

**The storage format is already the escape hatch.** ADR 0003 requires a plain
Postgres data directory, and the reason it gives is that leaving must always be
possible. A Durable Object on this substrate is one ordinary SQLite file per
object (`workerd.capnp:722-731`, confirmed empirically in
`docs/durable-objects/research/2026-08-10-alarms-are-readable-from-outside.md`).
It is copyable, `sqlite3`-readable, and reflink-clonable, so ADR 0003's promise
and ADR 0005's branching both extend to it without new machinery.

**What is left is one real problem, and it is ours.** Alarms cannot survive
sleep from inside the runtime. A stopped process has no timer, so a project whose
worker sets an alarm for 03:00 either never sleeps or misses the alarm. That is
precisely the gap `docs/hibernation/research/2026-08-10-cloudflare-containers-sleep-after.md`
had already recorded against us, in the row where Cloudflare's
`container_schedules` table sits opposite our "Not modelled".

## Decision

**Three parts.**

### 1. A Durable Object namespace is a resource, one per class

`ResourceKind` gains `durable_object`. One resource is one Durable Object class,
which is one `<uniqueKey>/` directory on disk. Object instances inside it are
files, not resources; there may be millions and they are created by being
addressed.

The namespace, not the worker, is the resource because **that is the boundary
workerd already draws.** Its alarm scheduler is per namespace
(`server.c++:404-408`) and its storage directory is per namespace
(`server.c++:388`). Modelling a coarser unit would mean holding a sleep decision
and an alarm schedule for a thing the runtime partitions anyway.

The consequence is per-namespace branch, backup and eject, and a Studio view that
lists a class's objects the way it lists a database's tables.

### 2. `wrangler.jsonc` declares; the store projects

A Durable Object class is declared in the worker's manifest, which is user-owned
and the source of truth. The resource row is a **projection**, reconciled on
deploy:

- a class in the manifest with no resource creates one
- a class that disappears from the manifest marks its resource `orphaned` and
  **never deletes storage**
- pruning orphaned storage is an explicit, separate verb

This is what stops "two sources of truth" from being a real problem: there is one
writer and one direction. A manifest edit can never destroy data, which matters
more here than tidiness, because the failure it prevents is silent and permanent.

**`durableObjectUniqueKeyModifier` is derived from the resource's id**, the UUID
the store assigns at `createResource` and never changes. Not the project name and
not the class name, both of which a rename would change. If the modifier were
regenerated per deploy, every object's storage would be orphaned on the next
deploy and the user would lose state silently. This is the sharpest data-loss
edge in the capability. It is enforced on the `@hobby.sh/compute` side and
asserted from ours.

### 3. The alarm mirror lives outside the runtime, and only ever asks for a wake

The daemon reads pending alarms out of a **stopped** namespace with one query
against `<uniqueKey>/metadata.sqlite`:

```sql
SELECT actor_id, scheduled_time, actor_name FROM _cf_ALARM
```

`scheduled_time` is int64 nanoseconds since the Unix epoch. From that the daemon
holds the earliest deadline per namespace and does exactly two things: it blocks
sleep while an alarm is imminent, and it calls `wake(resource)` when one comes
due.

**It does not fire alarms.** workerd's scheduler reloads every row and reschedules
on startup (`alarm-scheduler.c++:86-99`), so being awake at the deadline is
sufficient and is the whole contribution. This mirrors the seam the proxy already
has, one clock further out: the proxy asks and the engine acts; here the clock
asks and the engine acts. Neither ever starts a container itself, which is what
keeps both testable against a fake with no Docker in the loop.

## Consequences accepted

- **We depend on an interface upstream calls experimental.** `localDisk` is marked
  `** EXPERIMENTAL; SUBJECT TO BACKWARDS-INCOMPATIBLE CHANGE **`
  (`workerd.capnp:723`), and the scheduler behind it describes itself as
  sufficient "for the usecase of local development"
  (`alarm-scheduler.c++:84`). Mitigation is to pin the Miniflare version, assert
  the schema at startup instead of assuming it, and treat a missing `_cf_ALARM`
  table as a loud error rather than an empty result. An alarm mirror that
  silently reports nothing pending is indistinguishable from a working one until
  an alarm is missed.
- **Scope went up again, five days after ADR 0007 said that was the main risk.**
  Nothing here repeals the 30-day daily-use gate in ADR 0007 guard 2. This
  capability is Phase 2 work and inherits that gate.
- **`hobby eject` has a third obligation.** ADR 0007 already noted eject gets
  harder with every kind. A namespace directory is self-contained and its files
  are plain SQLite, so the obligation is met by handing over the directory and the
  manifest, and the test for it is that `wrangler dev` serves the result.
- **The catalog can show names only for objects that have set an alarm.**
  `actor_name` is persisted in `_cf_ALARM` and nowhere else, and `idFromName` is
  an HMAC that does not reverse. Objects that never set an alarm are listable by
  id only. This is documented as absent rather than faked.
- **Two sessions own two halves of one feature.** `@hobby.sh/compute` owns the
  runtime, the manifest, the generated config and HTTP wake. `@hobby.sh/do` owns
  the alarm mirror, the catalog and storage lifecycle. The seam is a pure
  predicate and a `wake` callback, chosen so that neither half can reach into the
  other's lifecycle.

## What would have to change to revisit

**If the on-disk layout breaks twice**, this stops being orchestration around a
mature tool and becomes maintenance of an undocumented format. At that point the
options are to pin a Miniflare version indefinitely, to move to raw workerd where
the capnp schema is at least a declared interface, or to drop the capability. The
correct response is not to add a compatibility shim per version.

**If nobody sets an alarm in daily use**, the mirror is dead weight guarding a
case that does not occur, and the honest move is to delete it and let a namespace
with a pending alarm simply refuse to sleep. `docs/CLAUDE.md` prefers deleting a
feature to deferring it, and this is the most likely candidate in this capability.

**If Durable Objects are not used within 30 days of being usable**, that is
evidence this ADR was scope creep with a good story attached, and the response is
to remove the kind rather than carry it.
