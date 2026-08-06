# M1: the resource model and Postgres lifecycle

Status: PROPOSED
Date:   2026-08-07
Depends on: M0 having answered the cold start gate.
Sibling: `../../cli/specs/2026-08-07-m1-daemon-control-api-and-verbs.md`, which
owns the daemon, the API and the command surface. This document owns everything
below it.

## What M1 delivers

A Postgres you can create, connect to, list, stop, start and destroy, whose data
directory is a plain Postgres data directory, proven by tests rather than by
assertion. **No sleeping and no waking yet.** Those are M2 and M3, and building
them before this exists means debugging two unproven things at once.

## `@hobby.sh/core`

Depends on nothing. Knows nothing about Docker, Postgres or HTTP.

```ts
type ResourceKind = 'postgres'          // M1 registers exactly one

type ResourceState =
  | 'creating' | 'running' | 'starting'
  | 'sleeping' | 'stopping' | 'failed' | 'destroying'

interface Project {
  id: string
  name: string                          // [a-z][a-z0-9-]{1,62}
  networkName: string
  sleepAfterSeconds: number | null       // null means never. unused until M3
  createdAt: Date
}

interface Resource {
  id: string
  projectId: string
  kind: ResourceKind
  name: string
  state: ResourceState
  config: unknown                       // kind-specific, validated by the kind
  lastActiveAt: Date | null
  createdAt: Date
}
```

**The `ComputeRuntime` interface** is the ADR 0002 escape hatch and the seam
Phase 2's `app` and `worker` kinds plug into. It is deliberately small, and it
must never leak a Docker type:

```ts
interface ComputeRuntime {
  ensureCreated(spec: ContainerSpec): Promise<ContainerId>
  start(id: ContainerId): Promise<void>
  stop(id: ContainerId, opts: { timeoutMs: number }): Promise<void>
  remove(id: ContainerId): Promise<void>
  inspect(id: ContainerId): Promise<{ exists: boolean; running: boolean }>
  logs(id: ContainerId, opts: { tail?: number; follow?: boolean }): AsyncIterable<string>
}
```

M1 ships one implementation. Which container runtime is still open in
`docs/engine/CLAUDE.md`, and because it sits behind this interface, that choice is
contained rather than foundational.

**A fake implementation ships in M1, not M2.** The proxy is tested against it,
and writing it now is what makes M2's wake logic testable with no Docker in the
loop.

## State

One SQLite file the daemon owns. Tables mirror the types above. Two rules:

- **The database is the only source of truth for metadata.** No `meta.json` next
  to the data directory. Two sources means one of them is wrong.
- **Reconcile on daemon start.** Ask the runtime what is actually running and
  correct the recorded state. A host reboot, a `docker rm` by hand, or a crash
  mid-transition must all converge, and the recorded state must never be trusted
  over observed reality.

## Disk layout

```
~/.hobby/
  state.db
  daemon.sock
  config.json
  projects/<project>/<resource>/pgdata/
```

The data directory sits at a predictable path with nothing of ours inside it.
That is ADR 0003, and it is what makes the invariant tests below possible.

## The `postgres` resource kind

**Create.** Run `initdb` inside the target container image so the data directory
is produced by exactly the binary that will later open it. Never initialise with
a host Postgres. Generate a password, record the connection details, leave the
container stopped or running per the caller.

**Start.** `ensureCreated`, then `start`, then wait for readiness.

**Readiness** is a real connection attempt in a loop, not a port check. An open
port during startup means nothing. Poll interval comes from M0's measurement;
until then assume it is small and that the number matters.

**Stop.** A clean shutdown, always, with a timeout. Postgres stopped
mid-checkpoint does recovery on the way back up, and that recovery lands entirely
inside a user's first query in M2. This is the single most important thing this
milestone does for the milestone after it.

**Destroy.** Stop, remove the container, remove the data directory, remove the
rows. Confirmation is the CLI's job, not this layer's.

## Ports, and the one thing that changes at M2

**M1 publishes a host port per instance**, because there is no proxy yet and a
connection string has to reach something. M2 puts the proxy on 5432, moves
instances onto the project's private network, and stops publishing them.

**This means the connection string changes shape between M1 and M2**, from a
per-instance port to a single port with the project in the database name. That is
acceptable exactly once, before anyone is using it, and it is written here so it
is a planned migration rather than a surprise. `hobby ls` and the connection
endpoint are the only places that render it, which is what keeps the change
small.

## Naming, which is user-visible forever

The proxy routes on the database name (`docs/proxy/CLAUDE.md`), so:

- **Project names are globally unique on the box** and become the default
  database name.
- **A dot is reserved** in database names, because `blog.analytics` is how a
  second database inside project `blog` is addressed.
- Reject names that collide with Postgres built-ins (`postgres`, `template0`,
  `template1`).

M1 enforces these even though nothing routes yet. Enforcing them later means a
migration.

## `hobby init` preflight

Detects and reports, in this order: a container runtime present and usable, the
filesystem under `~/.hobby` and whether it supports reflinks, free space, and
whether anything already holds the ports we want. **On ext4 it warns loudly and
proceeds**, because refusing to run on the most common VPS filesystem is how a
tool gets uninstalled in the first thirty seconds. The warning states plainly
that branching will be a real copy.

## Testing

**The ADR 0003 invariants, as executable tests running on every commit.** That
ADR says they are enforced by a test suite rather than by intention, so they are
written here, in the milestone that first creates a data directory:

1. `pg_dump` against a managed instance succeeds, with the daemon stopped.
2. A stock upstream `postgres` binary, pointed at the data directory, starts it
   and serves queries.
3. The `hobby eject` output boots unaided and serves the same data.

If any of the three cannot be made to pass, that is not a test failure, it is a
design failure, and the design changes.

**Also required:**

- Kill the container out from under the daemon, restart the daemon, and confirm
  reconciliation converges. `docs/engine/CLAUDE.md` lists this as an open
  question, and M1 is where it stops being open.
- Reboot the host and confirm state survives.
- Create, destroy, and confirm nothing is left behind: no container, no
  directory, no rows.

## Done means

`hobby init` passes preflight on a five dollar VPS and a Mac Mini. `hobby new
blog` produces a Postgres and prints a connection string that `psql` accepts.
`hobby ls` reports truthfully after a daemon restart and after a host reboot.
`hobby rm` leaves nothing behind. All three ADR 0003 invariants pass in CI.

## Explicitly not in M1

Sleeping, waking, the wire proxy, hibernation, branching, Studio, Caddy, TLS,
MCP, and more than one resource kind. M1 is allowed to be boring. It is the
thing the keystone gets tested against.
