# M1: the daemon, the control API, and the command surface

Status: PROPOSED
Date:   2026-08-07
Sibling: `../../engine/specs/2026-08-07-m1-resource-model-and-postgres-lifecycle.md`,
which owns the resource model and Postgres. This document owns the daemon, the
API and everything a user types.

## The shape

One daemon. One HTTP API. Three clients that all render it and none that bypass
it.

```
hobby (cli) ---- unix socket ----\
                                  >--- daemon ---- core, pg, runtime
mcp server  ---- unix socket ----/       |
                                         |
studio ---- caddy ---- loopback tcp -----/
```

**Two listeners, identical routes.** The unix socket at `~/.hobby/daemon.sock`,
mode `0600`, where filesystem permissions are the authentication and there is no
credential to leak. A loopback TCP port for Studio, which is the only client that
carries a session cookie, reached only through Caddy (ADRs 0008 and 0009).

Neither Studio nor MCP arrives in M1. **The API is still designed for all three
now**, because the reason the CLI and MCP cannot diverge is that there is only
one surface to diverge from, and retrofitting that property is how it gets lost.

## The API

`/v1`, JSON, no versioning ceremony beyond the prefix.

```
GET    /v1/health
GET    /v1/preflight                      what init checks, re-runnable

GET    /v1/projects
POST   /v1/projects                       { name }
GET    /v1/projects/:name
DELETE /v1/projects/:name                 ?force=true

POST   /v1/projects/:name/resources       { kind, name, config }
GET    /v1/resources/:id
DELETE /v1/resources/:id
POST   /v1/resources/:id/start
POST   /v1/resources/:id/stop
GET    /v1/resources/:id/connection       the connection string
GET    /v1/resources/:id/logs             streaming

POST   /v1/projects/:name/eject
```

The API says `start` and `stop` because those are mechanical operations on a
container. The CLI says `sleep` and `wake` because that is the domain. M2 builds
connection-triggered waking on top of `start`, and M3 builds idle-triggered
sleeping on top of `stop`, so neither needs a new route.

**Errors are one shape**, because three clients have to render them:

```json
{ "error": { "code": "resource_not_found", "message": "...", "hint": "..." } }
```

`code` is machine-readable and stable. `message` is for a human. `hint` says what
to do next and is optional. HTTP status carries the class.

## The command surface

```
hobby init                       preflight, then start the daemon
hobby new <name>                 project + postgres + connection string
hobby ls                         everything, with state
hobby pg create --project <p>    the explicit form
hobby connect <target>           exec psql against it
hobby sleep|wake <target>        manual, and the only way to sleep until M3
hobby logs <target>              tail
hobby rm <target>                destroy, with confirmation
hobby eject <project>            compose file, data, and we stop managing it
```

**The user-facing verbs are `sleep` and `wake` from M1 onward**, even though M1
has no idle detection and no proxy. `hobby sleep blog` stops the container, which
is exactly what sleeping is; M3 adds a policy that calls it automatically, and M2
adds a connection that calls `wake` for you. Shipping `start` and `stop` now and
renaming them later would be a rename of the most visible verbs in the tool, so
the API keeps `start` and `stop` as its mechanical operations and the CLI does
not.

**`hobby new` carries the promise.** The root `CLAUDE.md` says one command gives
you a Postgres, and Projects existing must not cost that. `hobby new blog`
creates the project, creates the `postgres` resource, waits for readiness, and
prints a connection string you can paste. Everything else is the explicit form
for the uncommon case.

`hobby branch` and `hobby studio` are **not** in M1. They appear in the
milestones that make them real. A command that exists and does nothing is worse
than one that does not exist.

## Conventions

**Target resolution.** `<target>` is `project` when the project has one resource,
and `project/resource` otherwise. Ambiguity is an error that lists the
candidates, never a guess.

**`--json` on every command that returns data**, emitting the API response
unmodified. Human output is a rendering of the same thing, never a separate code
path that can disagree with it.

**Exit codes scripts can trust:**

| Code | Meaning |
|---|---|
| 0 | success |
| 1 | operation failed |
| 2 | usage error |
| 3 | not found |
| 4 | conflict, for example the name is taken |
| 5 | daemon unreachable |

**Config resolution, highest first:** flags, environment, `hobby.json` in the
working directory or above, then `~/.hobby/config.json`. Deliberately boring.

**Human output rules.** Never print a spinner when there is nothing to wait for.
Always print the connection string on its own line so it can be selected cleanly.
Confirm destructive operations by requiring the name to be typed, and skip that
only for `--yes`.

## The daemon

**Lifecycle.** `hobby init` starts it. It reconciles state against the runtime on
every start, as the sibling spec requires. It writes a pidfile and refuses to run
twice.

**Supervision is delegated.** systemd on Linux, launchd on macOS, and a plain
foreground mode for everything else. Writing our own supervisor is work that two
mature ones already did. Whether the daemon should instead supervise itself is
listed as open in `docs/cli/CLAUDE.md`; M1 takes the delegated path and that
question stays open until something forces it.

**Shutdown is clean and it matters more than it looks.** On `SIGTERM` the daemon
stops accepting, finishes in-flight operations, and stops managed Postgres
instances cleanly. An unclean stop here becomes recovery time inside a user's
first query in M2, which is exactly the budget M0 measured.

## Testing

- Every CLI verb tested against the API, and the API tested against a fake
  `ComputeRuntime`, so the whole surface runs in CI without Docker.
- `--json` output validated against a schema, so a shape change is a test failure
  rather than a silent break in someone's script.
- Every documented exit code produced by a real failure path in a test.
- The daemon killed with `SIGKILL` mid-operation, then restarted, and state
  converges.

## Done means

A user who has never seen this runs `hobby init`, then `hobby new blog`, pastes
the connection string into `psql`, and it works. `hobby ls` is honest after a
reboot. `hobby rm blog` leaves nothing behind. Every command supports `--json`
and every exit code means what the table says.

## Explicitly not in M1

Waking, sleeping, hibernation, the wire proxy, Studio, Caddy, TLS, auth,
sessions, MCP, branching. The daemon API is shaped so those slot in. None of them
are built here.
