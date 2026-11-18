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

Both non-builds are recorded as ADR 0020
(`docs/decisions/0020-no-autoprewarm-and-no-declared-roles-or-databases.md`).

## Amendment, 2026-11-17: server settings and preload libraries

**Built.** A postgres resource can declare server settings
(`PostgresConfig.settings`, `packages/core/src/types.ts`), which closes the
gap the extensions amendment above left open: "an extension that requires
`shared_preload_libraries` can be created but will not work".

**An allowlist, validated in the daemon.** `SETTINGS` in
`packages/pg/src/settings.ts` lists 46 settings, each with its type, bounds,
default, the `pg_settings.context` that says whether Postgres needs a
restart for it, and a PostgreSQL 18 docs link. Types, units, contexts and
defaults were read from `pg_settings` in `postgres:18-alpine` (18.7) on
2026-11-17; bounds are narrowed for one small box (`shared_buffers` 1MB to
8GB, `max_connections` 5 to 1000). Anything not listed is refused by name,
so a typo or a setting that can stop the server booting (`port`,
`data_directory`, archive and replication settings, anything naming a file)
never reaches a container. Values are checked in Postgres's own units
(case-sensitive, as Postgres reads them) and normalized, which also means no
value ever needs quoting. Xata's `internal/postgrescfg/parameters.yaml`
(Apache-2.0) was read as a guide to which settings are worth exposing;
nothing was copied. `io_method=io_uring` is left out: under Docker's default
seccomp profile the server exits at start ("could not setup io_uring queue:
Operation not permitted", checked live).

`shared_preload_libraries` takes its own allowlist, `pg_stat_statements` and
`auto_explain`, the two libraries in the image worth preloading that start
no background worker. `pg_cron` is refused (its jobs stop while the database
sleeps) and `pg_prewarm` is left out (ADR 0020); both are recorded in
ADR 0022. A setting that belongs to a library (`pg_stat_statements.max`,
`auto_explain.log_min_duration`) is refused unless that library is preloaded,
whichever side of a change would break that.

**Server arguments, never config files.** `settingsCommand` turns the
declaration into `postgres -c name=value ...`, sorted, and `containerSpec`
(`packages/pg/src/postgres.ts`) puts it in the new `ContainerSpec.command`
(`packages/core/src/runtime.ts`, emitted after the image by
`buildCreateArgs` in `packages/core/src/docker.ts`). A resource with no
settings gets no command and keeps the image's own CMD, exactly as before.
The official entrypoint passes the same arguments to its initdb temp
server, so a create with settings boots with them the first time.
`postgresql.conf` and `postgresql.auto.conf` are never touched (ADR 0003);
checked live, `pg_settings.source` reads `command line` and
`postgresql.auto.conf` has no setting in it.

**Every change recreates the container, even a reloadable one.** A value
given on the command line outranks the config files and `pg_reload_conf`
does not re-read it, so the only way to apply a change without writing a
config file is a new container on the same data directory.
`applyPostgresSettings` (`packages/cli/src/daemon/pg-settings.ts`) does it
by state:

- **Asleep or failed:** the stopped container is replaced
  (`recreatePostgresContainer`) and nothing is started. The settings apply on
  the next wake. A settings change never wakes a database.
- **Awake:** a pause, with the conventions `hobby branch` and snapshots
  use. A pinned project needs `allowPause` (`assertPauseAllowed`), the
  activity guard must report idle (`waitForIdle`, exported from
  `snapshots.ts`, refusing if it stays active or cannot answer), and wakes
  are held (`holdProjectAsleep`) so a reconnecting pool waits rather than
  starting the old container mid-swap. Then stop, recreate, start.
- **A start that fails with the new settings is rolled back:** the previous
  config is stored, the container is recreated from it and started again,
  and the usage error carries the failed start's log lines. Not exercised
  live: Postgres accepted `shared_buffers=8GB` on an 8GB Docker Desktop VM,
  because the memory is reserved lazily; covered against the fake runtime.
- Unchanged settings touch no container. Starting, stopping and creating
  states are refused with a conflict. A released project is refused: its
  settings live in its compose file now.

**Carried like extensions.** `createPostgresFromClone` copies the source's
settings, so a branch and a snapshot restored into a new project run as
their source did. `rebindPostgresToClone` (`hobby reset`) takes the
parent's, as it takes the parent's image: the parent's cloned catalog may
hold `pg_stat_statements`, which needs the parent's preload. An in-place
snapshot restore keeps the resource's own settings and container. Eject
writes the same arguments into the compose `command:`
(`docs/portability/CLAUDE.md`, same date).

**Extension metadata.** `EXTENSION_PRELOADS` in the same file names the
extensions that need a library: `pg_stat_statements`, the only one of the
60 the image ships whose objects refuse to work without a preload (checked
live: without it, reading the view errors), and `pg_cron`, refused. `hobby
pg ext add` refuses such an extension before any wake while the library is
not preloaded, and the hint is the exact `hobby pg config set <target>
shared_preload_libraries=...` that adds it; once preloaded the add proceeds.
`createPostgres` refuses the same way before anything is allocated, unless
the same create preloads it. `ExtensionReport.needsPreload` (on `ext ls` and
`GET /v1/resources/:id/extensions`) marks declared or installed extensions
whose library is missing, and a settings change that unsets a needed
library is allowed but reports the same list.

Surfaces: `hobby pg config [ls|set|unset] <target> [--all] [--allow-pause]`
under the existing `pg` verb, `--setting name=value` on `hobby new` and
`hobby pg create`; `GET`/`POST /v1/resources/:id/settings` and `settings` on
the postgres create body (`docs/api/openapi.yaml`); MCP
`hobby_pg_config_ls`, `hobby_pg_config_set`, `hobby_pg_config_unset` and a
`settings` field on `hobby_new`.

**Verified live on 2026-11-17** against `postgres:18-alpine` on Docker
Desktop 28.4 (Apple silicon), driving the compiled `containerSpec`,
`applyPostgresSettings` and the real eject route against a container named
`cfg-live` on port 36432, not a daemon: created with
`shared_preload_libraries=pg_stat_statements`, `pg_stat_statements` was
created and read; an asleep change replaced the container without starting
it and applied on the next start; an awake change restarted it (2.6 seconds
from stop to ready, including the container swap); the compose file the
eject route rendered was started with `docker compose` on the same data
directory and reported every setting with source `command line`, with
`pg_stat_statements` answering. Not run: `hobby daemon` and
`scripts/smoke.mjs`, which the integrated run covers.

## Amendment, 2026-11-18: what a connection sees during a settings restart (Phase A3)

Adds to the 2026-11-17 settings amendment above, which is unchanged.
`applyPostgresSettings` (`packages/cli/src/daemon/pg-settings.ts`) already
held wakes for the swap (`holdProjectAsleep`); the full account of what that
means for clients is the same-dated amendment in `docs/proxy/CLAUDE.md`. In
short:

- A connection made while an awake database is being restarted waits on the
  wake fence (`buildWake`, `packages/cli/src/daemon/context.ts`) and is
  served by the restarted container, over plain TCP, TLS, `/sql` and the
  serverless WebSocket alike, for up to `wakeTimeoutMs`.
- If neither the new settings nor the rolled-back ones start, the hold is
  released naming the resource (`ReleaseHold`), and the waiting connections
  get "`<project>/<db>` was restarted by a settings change, and did not come
  back: ..." at once, rather than each starting the container again.
- The hibernator skips a held project (`isProjectHeld`), so it cannot stop
  the database between the restart's own stop and start.
- Sessions open at the stop end, and the CLI now says so on a restart
  (`printSettingsChange` in `packages/cli/src/cli/commands.ts`): "sessions
  open before the restart were ended; new connections made during it were
  held until it was back, up to the wake timeout."
- A concurrent snapshot, restore, branch or reset of the same project is
  refused with a conflict that names the operation in progress.

Covered by `packages/cli/test/restart-wait.test.ts`. Not run against real
Docker.
