# Cloudflare Containers, and the only shipping product with our wedge

Status: NOTES. A comparison against shipped code on both sides. One data point
bears on an open question; nothing is decided.
Date:   2026-08-10

`docs/hibernation/CLAUDE.md` uses Xata's CNPG scale-to-zero sidecar as its
reference point for cost envelope. That is the right reference for the sleep
half. For the **pair**, sleep plus wake, the closest shipping analog is
`cloudflare/containers` (Apache 2.0, TypeScript), the library behind Cloudflare's
container bindings for Workers.

It is worth noting plainly what it does not change: the root `CLAUDE.md` claims
that no self-hostable alternative sleeps and wakes. Cloudflare Containers is not
self-hostable, it is a managed platform feature, so the claim stands. What it
provides is a second, independently designed implementation of the behavior we
are betting the project on, in our own language, that we can read.

## Their model, in their code

`src/lib/container.ts`:

- `DEFAULT_SLEEP_AFTER = '10m'` at line 37, overridable per subclass as a class
  field (`sleepAfter = "2h"`) or through options.
- `renewActivityTimeout()` at line 1050 computes
  `this.sleepAfterMs = Date.now() + parseTimeExpression(this.sleepAfter) * 1000`.
  It is called on request handling, on stream events, and on start.
- Durable Object alarms drive the check. `scheduleNextAlarm()` runs before
  anything else on wake.
- `onStart()` and `onStop(params)` are overridable lifecycle hooks.
- A `container_schedules` SQLite table persists scheduled and delayed tasks
  across sleep.

The design is **deadline-based**: activity pushes an absolute timestamp forward,
and the periodic check compares now against that timestamp.

## Ours, and how it differs

`packages/cli/src/daemon/hibernator.ts` splits a pure `shouldSleep(input)` policy
from an impure `startHibernator` tick loop, which is a cleaner separation than
theirs and makes the whole decision table testable with no clock. The policy is
**elapsed-based**: `idleSeconds` versus `sleepAfterSeconds`, defaulting to 300 in
`packages/core/src/config.ts:63`.

Three things we have that they do not need, and one they have that we lack:

| | Us | Them |
|---|---|---|
| Activity source | Proxy connection count, `packages/proxy/src/activity.ts` | Request and stream events on the Durable Object |
| Mid-work guard | `pg_stat_activity` check via `packages/pg/src/activity-guard.ts`, refusing to sleep mid-transaction | None needed. A container is not a database. |
| Zero-connections precondition | Required exactly, `connections !== 0` rejects | Not modelled |
| Work surviving sleep | Not modelled | `container_schedules` table, so a delayed task can outlive a sleep |

The `pg_stat_activity` guard is the part with no analog anywhere in this
comparison, and it is the part that makes our sleep safe rather than merely
timed. Worth recording, because it is easy to look at a simpler implementation
and conclude ours is overbuilt.

## The ordering hazard, seen from both sides

Their `container.ts` around lines 542 to 546 carries this:

> First thing, schedule the next alarms. Also yields a microtask so subclass
> class-field initializers (e.g. `sleepAfter = "2h"`) run before
> `renewActivityTimeout` reads `this.sleepAfter`.

Different mechanism, same family of bug as the TOCTOU race fixed in our `tick()`
at `3caa065`, where activity read before an `await` went stale across the guard.
Anything that reads a deadline, awaits, and then acts on the stale read is
wrong, and both implementations had to be corrected for it. That is a reason to
treat this class of bug as expected rather than exceptional when the hibernation
loop is next touched.

Their deadline-based approach is structurally more resistant to it than an
elapsed-based one, because a deadline read late is merely conservative while an
elapsed count read late can be wrong in the unsafe direction. Ours closes the gap
with a synchronous re-read instead. Both work. If the loop is ever rewritten, a
deadline is the cheaper invariant to hold.

## The one data point for an open question

`docs/hibernation/CLAUDE.md` asks what the default idle threshold should be, and
whether it should differ between a database under active development and one
serving a deployed app.

Cloudflare ships **10 minutes** for a container that costs its owner money while
running. We ship **300 seconds** for a database that costs nothing but memory on
a box the owner already paid for.

That is not an argument to change ours. It is a note that a commercial platform
with a direct financial incentive to sleep aggressively chose a threshold twice
as long as ours, which suggests our 5 minutes is on the aggressive side rather
than the timid side, and that the risk of an annoying wake is real. The client
matrix in `docs/proxy/CLAUDE.md` is the thing that would tell us whether 300
seconds is uncomfortable in practice.

## Not applicable

`neondatabase/autoscaling` (Go, Apache 2.0) is Neon's vertical autoscaler and
runs on Kubernetes, which the root `CLAUDE.md` puts out of scope. Its idle
detection heuristics are the only readable part, and they are entangled with
NeonVM specifics.
