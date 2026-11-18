# The proxy outlives the daemon

Status: PROPOSED. Phase A2 of the standby-pair design (branch
`docs/adr-0023-standby-pair`, `docs/availability/specs/2026-11-18-standby-pair-design.md`).
Date:   2026-11-18

## The problem

`startDaemon` (`packages/cli/src/daemon/server.ts`) calls `startPgProxy`
once per bind address, in the daemon's own process. `performShutdown` closes
those listeners and the process exits, so every proxied Postgres session ends
on every daemon restart and every upgrade. Pinned containers already survive a
restart (`resourcesToStopOnShutdown`); their sessions do not, because the
process holding the client sockets is the one exiting.

## The decision: a separate proxy process, adopted by the daemon

The proxy runs as its own long-lived process. The daemon is its client.

**Who spawns it.** The daemon, on start. `hobby daemon` first dials
`$HOBBY_HOME/proxy.sock`. If something answers, the two exchange a hello
(below) and the daemon adopts it. If nothing answers, the stale socket file is
removed and the daemon spawns `packages/cli/bin/hobby-proxy.js` under its own
runtime (`process.execPath`, so Bun in production), detached into its own
session, stdout and stderr appended to `$HOBBY_HOME/proxy.log`, and waits for
its hello. A proxy that cannot bind fails daemon startup, as today.

**The hello.** The proxy sends `{protocol, fingerprint, configKey, pid, ports}`
on every new link. `protocol` is the link's own version (a constant).
`fingerprint` is a hash of the compiled code the proxy process loads
(`packages/proxy/dist/src`, `packages/core/dist/src`, the proxy host's own
files in `packages/cli/dist/src/proxyd`), computed by the proxy over the files
it actually loaded and by the daemon over what is on disk now. `configKey` is a
hash of what the proxy was started with: port, bind addresses, wake timeout,
and the TLS certificate and key file contents. All three equal: adopted, and
every session stays up. Anything differs: the daemon asks the old proxy to
stop, waits for it to exit, spawns a new one, and logs one line naming the
reason and the number of sessions it ended.

**How ProxyDeps crosses the boundary.** One unix socket, newline-delimited
JSON, the proxy listening and the daemon dialing.

| ProxyDeps member | In the proxy process | With the daemon down |
|---|---|---|
| `resolve` | The same resolver the daemon uses, against `state.db` opened read-only (WAL readers do not block the writer) | Works: nothing changes routing while the daemon is down, so the file is exactly as current as the daemon's memory would be |
| `allowlist` | Read from `state.db`, per connection, as today | Works |
| `wake` | A `wake` request on the link; the daemon runs `getOrCreateWake` and answers | Queued until a daemon links, bounded by the connection's own `wakeTimeoutMs`; then 57P03 as for any wake timeout |
| `isWakeRefused` | A local cache filled from failed wake answers (`retryAt`), cleared when a new daemon links (a restart clears refusals today) | Answers from the cache |
| `activity` | A local tracker that forwards `open`/`close` events on the link; a new link gets a snapshot of every live connection | Counted locally; the next daemon gets the snapshot before its hibernator starts |
| `onAccessRefused` | Rate-limited and logged in the proxy's own log | Same |
| cancel keys | `CancelRegistry`, already in the proxy and not a dependency | Unaffected; a cancel for a live session still routes |
| TLS (ADR 0019), serverless (ADR 0021) | Unchanged, inside `startPgProxy` | Unaffected |

The seam is unchanged: the proxy asks (`wake` on the link), the engine acts
(the daemon's existing wake). The proxy process never touches Docker and never
writes the store.

On Linux the daemon also sends `listen {host}` for each project network
gateway (issue #53), on adoption and whenever `ensureNetwork` creates one; the
proxy treats an address it already listens on as a no-op.

**Shutdown semantics.**

- *A restart or an upgrade* is SIGTERM or SIGINT to the daemon (systemd,
  Ctrl-C, `kill`). The daemon detaches: it closes its link and leaves the
  proxy running. While the link is still up it stops the sleepable resources
  that have no proxied session, as today; a sleepable resource that has one is
  left running for the next daemon to put to sleep. Pinned resources are left
  running as today. Wakes that arrive while the daemon is leaving are answered
  "daemon leaving" and the proxy queues them for the next daemon.
- *A full stop* is `hobby daemon stop`, a local verb like `hobby daemon`
  itself: it signals the daemon named in the lock with SIGUSR1, and the
  daemon runs today's whole sequence, telling the proxy to stop (ending its
  sessions) before any resource is stopped, which keeps the ordering rule in
  `performShutdown`. With no daemon running it stops a proxy that is still
  up, directly over its socket. It has no MCP tool and no API route for the
  same reason `hobby daemon` has none: it manages a process on this box, and
  an MCP client talking through the daemon has no business ending it.
- `hobby update` changes code on disk. The running proxy keeps the code it
  loaded; the next daemon start compares fingerprints and restarts the proxy
  only if its code changed. **An upgrade that changes proxy, core or proxyd
  code drops every proxied session once, at the daemon restart that follows
  it.** Upgrades that change only daemon code keep them.

**The daemon lock.** Unchanged and still the daemon's alone. The proxy takes
no lock: `proxy.sock` under `HOBBY_HOME` and the bound ports are what keep it
single, and only the lock holder ever spawns, adopts or stops one. A daemon
under a different `HOBBY_HOME` that finds the port taken by another home's
proxy fails to bind and says so.

**systemd.** The default `KillMode=control-group` kills every process in the
unit on stop and on restart, the proxy included. `scripts/hobby.service` sets
`KillMode=process` so only the daemon is signalled. `systemctl stop hobby`
then leaves the proxy up; `hobby daemon stop` is the full stop.

**`hobby eject`.** Nothing changes. The released-project refusal lives in the
shared resolver, so the proxy process applies it from `state.db`. The emitted
compose file binds each database's own host port, not the proxy's. Someone
leaving hobby entirely runs `hobby daemon stop` so no proxy keeps the port.

## The alternative: listener handoff

Passing the listening socket to the new daemon (HAProxy's technique) keeps the
port bound across a restart, so no connection is refused. It does nothing for
an established session: those sockets belong to the old process and end with
it. Phase A2's goal is established sessions, so handoff alone does not meet
it. It is also harder here: Bun's support for passing file descriptors to a
child is not something this codebase has exercised, while a detached child and
a unix socket are both already in use (`docker` child processes, the control
socket). A separate process meets the goal and keeps new connections working
too, since they are accepted by the proxy that never went away.

## What it costs, stated plainly

- A second process to supervise. A proxy that crashes is respawned at the
  next daemon start, not sooner. The daemon notices a dropped link and logs
  it; respawning it mid-life is not built.
- Activity reported while the daemon was down is not replayed in detail: the
  next daemon gets the live connections, and reconcile's existing `touch` of
  every running resource starts the idle clocks from its own start.
- A proxy session that is open when its container is stopped by a full stop,
  a hibernation or a settings restart still ends, as today.
- The single-process mode stays (`startDaemon` without a proxy process), for
  tests and as `HOBBY_PROXY_MODE=in-process`.
