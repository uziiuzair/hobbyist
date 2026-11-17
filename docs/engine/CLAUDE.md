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

## Amendment, 2026-11-17: declared extensions, and why roles and databases are not declared

**Built.** A postgres resource can declare extensions
(`PostgresConfig.extensions`, `packages/core/src/types.ts`). They are applied
with `CREATE EXTENSION IF NOT EXISTS ... CASCADE` by `applyExtensions`
(`packages/pg/src/extensions.ts`) at two moments only:

- **At creation**, inside `createPostgres`'s existing first boot, before its
  clean stop, so declaring costs no extra start. If the image does not ship
  one, the resource is torn down (`destroyPostgres`) and the create fails, so
  the obvious retry does not hit `name_taken`.
- **When the declaration changes**, through `POST /v1/resources/:id/extensions`
  (`setExtensionsRoute`, `packages/cli/src/daemon/routes.ts`). `add` wakes the
  database through the same `getOrCreateWake` the query route uses, applies
  the whole declared list (which also recreates one dropped by hand), and only
  then stores the declaration. `remove` only undeclares. Nothing is ever
  dropped, because `DROP EXTENSION` drops what depends on it, and a shorter
  list is not consent to delete a column.

**Not on wake, on purpose.** An extension is catalog rows and objects inside
the data directory. Once created it survives every stop, start, branch,
snapshot restore and eject with nothing re-applied (`createPostgresFromClone`
carries the declaration with the cloned catalog). Re-applying on wake would
put a connection and a catalog read inside the cold start, whose ceiling is 3
seconds, to re-confirm what the data directory already guarantees. Drift
(someone dropped a declared extension) is reported rather than silently
repaired: `GET /v1/resources/:id/extensions` returns `declared`, `installed`
with versions from `pg_extension`, and `missing`. That GET wakes a sleeping
database, since only a running Postgres can answer. The declared list alone is
on every wire resource as `config.extensions`, which costs no wake.

Every connection this opens carries `HOBBY_APPLICATION_NAME`
(`packages/pg/src/activity-guard.ts`), so it never counts as activity. An
extension the image does not ship is checked against `pg_available_extensions`
before anything is created, and the `usage` error names the image and points
at issue #2 (an image per project). "Postgres is unmodified" still holds: this
only runs the stock image's own `CREATE EXTENSION`, and nothing in core
function needs an extension. An extension that requires
`shared_preload_libraries` (`pg_stat_statements`, `pg_cron`) can be created
but will not work, because hobby passes no server arguments.

Surfaces: `hobby new --extension`, `hobby pg create --extension`, and
`hobby pg ext [ls|add|rm] <target>` under the existing `pg` verb (no new
verb); MCP `hobby_pg_ext_ls`, `hobby_pg_ext_add`, `hobby_pg_ext_rm` and an
`extensions` field on `hobby_new`; `docs/api/openapi.yaml`. Verified live on
2026-11-17 against `postgres:18-alpine`: `pg_trgm`, `uuid-ossp` and
`earthdistance` (CASCADE added `cube`) were created and reported with
versions; `vector` and `postgis` were refused with nothing created; then the
compose file rendered by the real eject route (`renderCompose`, unchanged)
was started with `docker compose` on the same data directory, and all three
extensions were present and answered queries.

**Declared roles and databases: considered, not built.** Neon's spec also
declares roles and databases. Neither fits here without changing a contract.

- **Databases.** The proxy routes on the project name and resolves the
  segment after the first dot resource first: `blog.analytics` is a resource
  named `analytics` if one exists, otherwise a database named `analytics`
  inside the default resource (`docs/proxy/CLAUDE.md`, the resolve order in
  `createProxyDeps`). A declared database would claim a name in a namespace
  where any later resource of that name silently shadows it, and a database
  inside a non-default resource has no routing key at all
  (`blog.reports.x` is not a form the proxy parses). Making that work means a
  third key segment or a different resolve order, which is a change to the
  routing contract, not to this capability. Today `CREATE DATABASE` from psql
  already gives everything a declaration would for the default resource, and
  branching and snapshots carry it in the data directory.
- **Roles.** These do not conflict with routing (auth is passthrough and the
  user name is never read), but a declared role needs a password the daemon
  generates, stores and hands out. That makes the daemon a user store, which
  `docs/proxy/CLAUDE.md` says it never maintains, and moves toward secrets
  management, which the root out-of-scope list names. `CREATE ROLE` from psql
  works and lives in the data directory like everything else.
