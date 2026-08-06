# `docs/engine/` Postgres instance lifecycle

**Status:** PROPOSED. Nothing built.

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
