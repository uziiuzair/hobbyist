# M0: the cold start spike

Status: PROPOSED
Date:   2026-08-07
Timebox: 2 days. If it runs longer, the answer is already interesting.

## What this is

A throwaway experiment that produces **numbers**, not a foundation. The code
written here is deleted when it is done. Nothing in M1 imports from it.

The wedge is that everything sleeps and wakes on demand, and the number that
decides whether that feels good or feels broken is unmeasured. M0 measures it
before anything is designed on top of the assumption. See
`../research/2026-08-07-cold-start-budget.md` for why the target is what it is.

## The question

**How long does it take, from TCP accept to a first query answered, to serve a
connection to a Postgres that was asleep?**

Target under 1 second. 3 seconds is a hard ceiling.

## Method

Prepare once: a container with an initialised `PGDATA`, then stopped cleanly.
Never removed. This is the state a hibernated instance is in.

Then, per iteration:

1. Client opens TCP to the spike proxy
2. Proxy reads the startup packet
3. Proxy issues a container start
4. Proxy polls for readiness
5. Proxy dials upstream, replays the startup packet, splices
6. Client issues `SELECT 1` and reads the row
7. Stop the container cleanly, wait, repeat

**Record six segments separately**, because a total is useless for fixing
anything:

| Segment | From | To |
|---|---|---|
| `accept_parse` | TCP accept | startup packet parsed |
| `wake_issue` | parsed | container start command returns |
| `container_up` | start issued | runtime reports running |
| `pg_ready` | running | Postgres actually accepts a connection |
| `ready_detect` | Postgres ready | we notice it is ready |
| `connect_splice` | noticed | first row read by the client |

`ready_detect` is called out separately on purpose. It is the segment most likely
to be needlessly large, and it is entirely ours.

## The matrix

Every cell gets 50 iterations, reported as p50, p95 and max.

- **Hardware:** a five dollar VPS (state vCPU, RAM, disk type, filesystem) and a
  Mac Mini (APFS). Both stated in the results, per the rule that a benchmark
  without hardware is a rumour.
- **Runtime:** Bun and Node. ADR 0006 accepted that Bun's socket stack is younger
  than Node's and that the proxy is the keystone. This is where that gets
  checked, not assumed.
- **Image:** the Postgres image we intend to ship, and one alternative base
  (alpine versus debian), because base image start time is a free lever if it
  turns out to matter.
- **Page cache:** warm and cold. A benchmark run in a loop measures a warm box,
  and nobody's first query of the day is warm. Drop caches between cold runs.

Default Postgres configuration throughout. Tuning `fsync` or `shared_buffers` to
win the benchmark would produce a number we cannot ship behind.

## The levers, tried in order, each measured

1. Container **stopped, not removed**. Compare against remove-and-recreate to
   quantify what `docs/engine/CLAUDE.md` already assumed.
2. **Clean shutdown.** Compare a clean stop against a `SIGKILL`ed container, so
   we know what recovery costs inside a user's first query. This case will happen
   in production regardless of what we prefer.
3. **Readiness poll interval.** 1000ms, 100ms, 25ms. Expect this to dominate.

## Also record

- **Failure timing.** How long a wake that never succeeds takes to give up, and
  confirm the client receives a real Postgres `ErrorResponse` rather than a
  dropped socket. An unreadable connection error is the failure mode that makes
  people uninstall.
- **Idle cost.** RSS and CPU of the spike proxy holding 20 idle connections.
  `docs/hibernation/CLAUDE.md` sets the cost envelope by reference to Xata's
  sidecar at under 15MiB and 0.05 CPU. A watcher that is itself a load has
  defeated its purpose.

## The decision this gates

| Result (p95, five dollar VPS, cold cache) | Consequence |
|---|---|
| Under 1s | Proceed to M1 as designed |
| 1s to 3s | Proceed, publish the real number, revisit levers in M2 |
| Over 3s after all three levers | **Escalate.** A warm pool becomes mandatory and the RAM story gets rewritten, or the wedge is re-examined. Either way this is a project-shape decision and it belongs in an ADR |

If Bun loses materially to Node on `accept_parse` or `connect_splice`, the proxy
moves to Node and we lose only the compile step. That is why ADR 0006 requires
Node-compatible APIs.

## Done means

1. A results document at `../research/YYYY-MM-DD-cold-start-measurements.md`,
   with hardware stated, every cell of the matrix filled, and the gate above
   answered explicitly rather than left to interpretation.
2. `docs/proxy/CLAUDE.md` and the root `CLAUDE.md` updated if the target moved.
3. **The spike code deleted.** Not moved into a package, not kept for reference.
   Its output is the measurements.

## Explicitly not in M0

State persistence, the resource model, projects, more than one database, auth,
TLS, error handling beyond the one failure case above, and anything resembling a
command surface. All of that is M1, and mixing it in here is how a spike quietly
becomes the foundation it was not reviewed to be.
