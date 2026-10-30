# `docs/engine/` Postgres instance lifecycle

**Status:** BUILT. `createPostgres`, `startPostgres`, `stopPostgres` and
`createPostgresFromClone` in `packages/pg/src/postgres.ts`, over the
`ComputeRuntime` interface (`packages/core/src/runtime.ts`) whose one real
implementation is `createDockerRuntime` (`packages/core/src/docker.ts`). The
body below is the original scope guard; the dated amendments at the end record
what changed after it was built.

Owns the answer to "is there a Postgres running, and where does its data live."
Create, start, stop, destroy. Data directory layout. The container runtime
abstraction.

## Non-negotiable

**Postgres is unmodified.** Stock upstream image, stock binaries, no patches, no
required extensions for core function. The moment a feature needs a forked
Postgres, the feature is wrong, not Postgres.

## In scope

- Instance create, start, stop, destroy
- Data directory layout on the host, and the naming scheme that makes branching
  and ejecting straightforward later
- The compute runtime interface, with a container implementation. Keep the
  interface honest so a microVM implementation can land later without a rewrite
  (see `docs/decisions/0002`)
- Readiness detection: knowing the difference between "container started" and
  "Postgres is accepting connections", which the proxy depends on completely
- Version pinning and upgrade paths between Postgres minor versions
- Resource limits per instance

## Out of scope

- Holding client connections open, which is `proxy/`
- Deciding when to stop an idle instance, which is `hibernation/`
- Cloning data directories, which is `branching/`
- Multi-node anything. One host. If it needs a cluster, it is out of scope.

## Decisions made

- **One Postgres process per `postgres` resource**, not one shared Postgres with
  many databases. Sleep is per resource, resource limits are per resource, and
  branching clones a data directory, all of which need the process boundary. It
  costs more memory at rest, which is exactly the cost hibernation exists to pay
  back.
- **Containers stay stopped, not removed.** Recreating a container on every wake
  spends time we do not have in a one second budget.

## Decisions to make

- Container runtime: Docker, Podman, or containerd directly. Docker is what
  people already have. Podman is rootless by default. Pick for the audience, not
  for elegance. Whatever wins sits behind `ComputeRuntime` in `core`, so this is
  a contained choice rather than a foundational one.

## Open questions

- How is readiness detected without a connection storm? `pg_isready` polling is
  the obvious answer and it needs a real timeout budget, because it sits directly
  in the user's first-query latency.
- What happens to an instance whose container was killed out from under us.

## Amendment, 2026-10-29: ports, failed starts, logs (issues #59, #60, #61)

**Host ports are probed, not only looked up (#60).** `Store.allocatePort`
knows every port a resource row holds and nothing else, so any other
process on the next "free" port made every `hobby new` fail with "address
already in use" until that process let go. Core's `allocateHostPort`
(`packages/core/src/ports.ts`) wraps it: it asks the store for a candidate,
binds it on loopback (where every container port is published), and moves
on when the bind fails. Every kind and the snapshot restore path allocate
through it. A bind-and-release is a check, not a reservation; the race
between it and docker's own bind is the one the store alone always had,
narrowed from "ever" to "this moment".

**A failed start stops its container (#59).** `startPostgres` left a
container running when readiness failed, so the next wake's `docker start`
was a no-op on an already running container and waited out the whole
`wakeTimeoutMs` again; only `hobby sleep` cleared it. `stopAfterFailedStart`
now stops the container before `failed` is recorded, and then, with docker's
hold on the port gone, checks the port once more: one still held is held by
another process, and the hint says so. The app and worker kinds do the
same stop. The open question below about "an instance whose container was
killed out from under us" is answered by the proxy amendment of the same
date (#54).

**`hobby logs` carries both streams (#61).** `docker logs` replays the
container's stderr on its own stderr, and `ComputeRuntime.logs` returned
only stdout, so every Postgres LOG, FATAL and PANIC line and most crash
output never reached `hobby logs`, the logs route or the MCP tool, while
every failure hint pointed at them. Both streams are now requested with
`--timestamps` and merged on the timestamp (`mergeTimestampedLogs`), then
the prefix is stripped, so the result reads in order as `docker logs` does
at a terminal.

## Amendment, 2026-10-30: sleeping stops, it does not remove (issue #145)

The status line above used to read "PROPOSED. Nothing built" long after the
engine was in daily use; corrected today. One behaviour worth writing down
because two site pages had it wrong: **a sleeping resource's container is
stopped, not removed.** `stopPostgres` (`packages/pg/src/postgres.ts`) calls
`ComputeRuntime.stop`, which is `docker stop -t <timeout>`
(`packages/core/src/docker.ts`); `remove` exists on the same interface and is
reached only from destroy. So a sleeping database keeps its container name,
its network membership and its published port, and a wake is `docker start`
on the existing container, which is what keeps the cold start inside budget.
The same holds for `app` and `worker`.

A new postgres is also born asleep: `createPostgres` boots it once so initdb
and `CREATE DATABASE` run, then stops it cleanly, so that the first real start
is never a crash recovery. `hobby new` therefore prints a connection string
for a database that is `sleeping`, and the first connection wakes it.

## Amendment, 2026-10-30: `BuildSpec` has no resource caps (issue #150)

`BuildSpec.memory` and `BuildSpec.cpuShares` (`packages/core/src/runtime.ts`)
are removed, and `createDockerRuntime().build` (`packages/core/src/docker.ts`)
no longer passes `--memory` or `--cpu-shares` to `docker build`. BuildKit
accepts both flags and ignores them; the measurement, the legacy-builder
comparison and the decision not to add a capped buildx builder are in
`docs/compute/CLAUDE.md`'s amendment of the same date. "Resource limits per
instance" in the scope above still holds for running containers
(`ContainerSpec`), which `docker run` does enforce; it never held for
builds.
