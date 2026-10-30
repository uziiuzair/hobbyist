# `docs/durable-objects/` the durable half

**Status:** Built, wired into the daemon, and **verified end to end against real
Docker** on 2026-08-11: an alarm set before sleep fired after it, with no
request in between. See
`research/2026-08-11-end-to-end-alarm-across-sleep.md`. **Phase 2.**
See `docs/decisions/0012` for why this capability exists at all.

**The Phase 2 gate is gone.** ADR 0007 guard 2 held Phase 2 until Phase 1 had
been in daily use for 30 consecutive days. `docs/decisions/0010` removed it on
2026-08-10. Nothing paces this capability, which is worth knowing before adding
to it.

Registers the `durable_object` resource kind: **one resource is one Durable
Object class**, which is one namespace, which is one directory of SQLite files.
Object instances are files inside it, not resources.

## The one thing this capability is for

**Making a Durable Object sleep.**

The runtime is not ours. `@hobby.sh/compute` runs workerd via Miniflare (ADR
0011), and workerd already implements actor addressing, single-threaded
execution, input and output gates, SQLite-backed storage, alarms and WebSocket
hibernation. Reimplementing any of that is out of scope here and always will be.

What workerd cannot do, by construction, is honour an alarm while it is stopped.
A stopped process has no timer. So a namespace either never sleeps or misses its
alarms, unless something outside the runtime holds the schedule. Holding that
schedule is this capability.

Everything else in this folder exists because the storage is on disk and
therefore has a lifecycle: listing it, deleting it, cloning it, handing it over.

## The seam

**The clock asks, the engine acts.** This package never starts or stops a
container. It computes deadlines and calls `wake(resourceId)`, exactly as
`packages/proxy` calls `wake` rather than talking to Docker. That is what keeps
the wake logic testable against a fake with no Docker and no workerd in the loop,
and it is the same reason `docs/proxy/CLAUDE.md` gives for its own version of
this rule.

The sleep decision is exposed as a **pure predicate** with no I/O, in the shape
of `shouldSleep` in `packages/cli/src/daemon/hibernator.ts`. The hibernator calls
it. It does not call the hibernator.

## In scope

- The alarm mirror: read `_cf_ALARM` from a stopped namespace, hold the earliest
  deadline, ask for a wake when it comes due
- The sleep predicate the hibernator consults before sleeping a namespace
- The object catalog: list objects, sizes, modification times, pending alarms
- Storage lifecycle: delete an object as a unit, prune an orphaned namespace
- The eject and branch story for Durable Object state
- Asserting, from this side, that the unique key is stable across redeploy and
  rename, since losing that silently destroys every object's storage

## Out of scope

- **The runtime.** Miniflare, workerd, the generated config, the container, the
  manifest and HTTP wake all belong to `@hobby.sh/compute` and `docs/compute/`.
- **Firing alarms.** workerd reschedules every pending alarm on startup. Being
  awake at the deadline is the entire contribution.
- **A Durable Objects API of our own.** User code is a real Cloudflare Worker. If
  it would not run on Cloudflare, it does not run here either.
- **Queues, Workers KV, D1.** Same substrate, later, and each gets its own folder
  or its own section rather than being smuggled in here.
- **Global uniqueness.** One box. A name maps to one live object because there is
  one runtime, not because of a consensus protocol.

## Open questions

- **How long is the wake grace window, and how late may an alarm be?** The guard
  refuses to sleep a namespace whose next alarm is within
  `DEFAULT_WAKE_GRACE_SECONDS` (30). Separately, because the mirror polls,
  an alarm can fire up to one tick late, currently 10 seconds, plus a cold
  start. Fine for a cron-shaped task and unexamined for anything finer. Neither
  number is measured against a need; both are guesses with a knob.
- **What does the catalog show for an object that has never set an alarm?** Its
  hex id, and nothing else. `actor_name` lives only in `_cf_ALARM`, and
  `idFromName` is an HMAC that does not reverse. Whether forward derivation
  (name to id, for lookup by name) is worth implementing against
  `actor-id-impl.c++` is open.
- **What happens to a pending alarm during a branch?** Cloning a namespace clones
  its `metadata.sqlite`, so the clone inherits real alarms that will fire against
  a copy. That is probably wrong and is not yet decided.
- **Does the mirror survive a Miniflare version bump?** The layout is upstream
  experimental. The schema assertion turns a break into a loud failure, but the
  policy for what to do next is not written down.

## Amendment, 2026-10-30: `hobby do` does not exist, and what the mirror reads (issue #171)

**There is no `hobby do` verb.** `specs/2026-08-10-the-alarm-mirror-and-object-catalog.md`
mentions `hobby do ls`, `hobby do inspect` and `hobby do rm` as consumers of
the object catalog. The spec is a dated artifact and stays as written; none of
the three is built, and the `USAGE` table in `packages/cli/src/cli/main.ts`
has no `do` verb. Durable Object storage is reached only through the worker
that owns it. If a listing is ever wanted, it is a new verb and a new route,
not a gap in an existing one.

**The mirror reads `_cf_ALARM` in the namespace's `metadata.sqlite`**, not
`_cf_METADATA` key 1 in each object's own file. Both exist and agree
(`alarms.test.ts` pins that), and the comment in `packages/do/src/alarms.ts`
gives the three reasons for reading the namespace copy: it is what
`AlarmScheduler` reloads on restart, so it decides what actually fires; it is
one file per namespace instead of one per object; and it is the only place an
object's human name is stored. The public guide
(`site/src/content/docs/docs/guides/durable-objects.md`) said the opposite
and has been corrected. The QA queues lane confirmed the on-disk shape on
2026-10-19: a `_cf_ALARM` row of `actor_id|scheduled_time|actor_name`.
