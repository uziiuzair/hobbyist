# The proxy outlives the daemon

Status: RATIFIED, built on 2026-11-18 (see "As built" at the end); not yet
verified against a live daemon under Bun. Phase A2 of the standby-pair design (branch
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
  itself: it signals the daemon named in the lock with SIGUSR2 (SIGUSR1
  belongs to the Node inspector), and the
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
- **The first upgrade onto this design restarts through the supervisor, never
  `hobby daemon restart`.** The daemon still running is the old one: its
  SIGTERM is a full stop with the proxy inside it. `hobby daemon restart` and
  `hobby daemon stop` refuse a daemon whose lock carries no `signals` field
  for exactly this reason (docs/cli/CLAUDE.md, amendment of 2026-11-19).

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

## As built

Code, by piece:

- `packages/cli/src/proxyd/protocol.ts`: the messages (`ProxyMessage`,
  `DaemonMessage`), `PROXY_LINK_PROTOCOL`, newline-delimited JSON framing
  (`send`, `onMessages`), `proxyCodeFingerprint` and `proxyConfigKey`.
- `packages/cli/src/proxyd/host.ts`, `startProxyHost`: the proxy process.
  `startPgProxy` per bind address, `resolveProxyTarget` and `allowlistOf`
  over `openStoreReadOnly` (new in `packages/core/src/store.ts`), the wake
  queue (`pending`, re-sent to each new link, given up with "the hobby daemon
  is not running" just inside `wakeTimeoutMs`), the refusal cache
  (`refusedUntil`), and the activity forwarder.
- `packages/cli/src/proxyd/main.ts` and `packages/cli/bin/hobby-proxy.js`:
  the process entry. SIGTERM and SIGINT stop it; SIGHUP is ignored.
- `packages/cli/src/daemon/proxy-resolve.ts`: the resolver, moved out of
  `createProxyDeps` (`context.ts`) so both processes run the same code.
- `packages/cli/src/daemon/proxy-link.ts`: `dialProxy`, `attachProxy`,
  `adoptOrStartProxy`, `spawnProxyProcess` (detached, `process.execPath`,
  output appended to `$HOBBY_HOME/proxy.log`).
- `packages/cli/src/daemon/server.ts`: `StartDaemonOptions.proxyProcess`
  selects the mode; `ShutdownMode` (`restart` on SIGTERM and SIGINT, `stop`
  on SIGUSR2 and by default for `close()`); `resourcesToStopOnRestart`.
- `packages/cli/src/cli/commands.ts`: `cmdDaemon` uses the process mode
  unless `HOBBY_PROXY_MODE=in-process`; `cmdDaemonStop` is `hobby daemon stop`.
- `packages/cli/src/daemon/preflight.ts`: `hobby init` reports a proxy left
  by a restart as holding `proxyPort` for the daemon to adopt, not as a
  blocker.
- `scripts/hobby.service`: `KillMode=process`.

One change from the design above: a connection to `proxy.sock` gets the hello
and nothing more until it sends `attach`. The proxy then answers `attached`
with the live connections as of that instant, and only an attached link can
send wake results, `listen` or `stop`. Without this, `hobby init` probing the
socket would have displaced the running daemon's link.

Tests: `packages/cli/test/proxy-process.test.ts`. A session through a fake
backend carries bytes across a daemon detaching and a second daemon adopting
(and the second daemon counts it); routing with no daemon, including a
project written to `state.db` after the proxy opened it; a wake held while a
leaving daemon is linked and then detached, and performed by the next one; a
wake with no daemon timing out with a message that says so; a refusal cached
from a failed wake; a fingerprint mismatch replacing the proxy; a probe not
displacing the daemon; the real `bin/hobby-proxy.js` spawned as a child under
Node; `hobby daemon stop` with no daemon; and `startDaemon` itself through a
restart (busy database kept, idle one stopped, proxy adopted) and a full stop.

Not done or not verified:

- Nothing has run under Bun or against a real daemon, Docker or `psql`.
  Bun's `child_process.spawn` with `detached: true` and an fd for stdio, and
  `bun:sqlite` read-only on a WAL database the daemon has open or has closed,
  are the two runtime behaviours most likely to differ.
- A proxy that dies while a daemon is running is not respawned until the next
  daemon start. The daemon logs the dropped link. (Closed later the same day:
  see "Supervision" below.)
- The HTTP router (apps and workers) still runs in the daemon; its
  connections still end on a restart.
- systemd's `KillMode=process` is set in the shipped unit but has not been
  exercised on a real systemd box. (With it, `systemctl stop hobby` left the
  proxy holding its port; see "Stop versus restart under systemd" below.)

### Supervision: a proxy that dies is started again (2026-11-18)

Before the split a proxy crash was a daemon crash, and `Restart=on-failure`
brought both back. After it, a dead proxy left a running daemon with every
database unreachable until the next daemon start. `superviseProxy`
(`packages/cli/src/daemon/proxy-supervisor.ts`) wraps `adoptOrStartProxy` and
watches the link's `closed`:

- The daemon closing the link itself (`beginShutdown`, called first in
  `performShutdown`, then `detach` or `stopProxy`) never triggers anything.
- Otherwise it waits up to `reapGraceMs` for the pid from the hello to be gone.
  Gone: it starts a new proxy through `adoptOrStartProxy` (which dials first,
  so it never starts a second proxy beside one that answers), re-sends the
  docker gateways, re-applies `beginLeaving` if set, and logs the old proxy's
  exit code or signal (`onExit`, new on `adoptOrStartProxy`; unknown for a
  proxy adopted from an earlier daemon, which is not this daemon's child).
  Alive: it re-dials and re-attaches the same pid; if that fails it SIGTERMs,
  then SIGKILLs, the unresponsive proxy so its port frees, then starts anew.
- Backoff 0.5 s, 1 s, 2 s ... capped at 30 s (`DEFAULT_PROXY_BACKOFF`). A
  proxy up for 60 s resets the count. After 5 fast losses in a row it stops,
  logs `proxy: GIVING UP ...` with the last reason and the log path, and
  `health()` says `failed`.
- `GET /v1/health` gains `proxy` (`up`, `recovering`, `failed`) and answers
  `status: degraded` when it is `failed` (`routes.ts`, via
  `DaemonContext.proxyHealth`). Only the state word there, since the route is
  unauthenticated on the studio listener. `GET /v1/preflight` carries the full
  `ProxyHealth` as `proxySupervisor`, and `hobby init` against a running
  daemon prints a line when the proxy has been restarted or given up on
  (`renderPreflight`, `packages/cli/src/cli/output.ts`).
- Startup cannot race it: supervision begins once the first link exists,
  from the same call. A respawn in flight when shutdown starts finishes, and
  `detach` / `stopProxy` then act on the proxy it brought up.

The proxy's control socket is now `chmod`ed to `SOCKET_MODE` (0600, moved to
`packages/cli/src/proxyd/protocol.ts` and shared with `hobby.sock`) right after
`listen` (`startProxyHost`).

Tests: `packages/cli/test/proxy-supervisor.test.ts`, every proxy the real
`bin/hobby-proxy.js` under Node: SIGKILL the proxy, a new one comes up on the
same port, serves a session, counts activity and performs a wake through the
daemon side; a link taken over with the proxy alive is re-attached to the same
pid; a crash loop (the port taken by another listener) gives up after three
attempts and `GET /v1/health` says `degraded`/`failed`; a proxy killed after
`close('restart')` began is not respawned and its port stays free; the socket
mode is 0600.

### Stop versus restart under systemd (2026-11-18)

With `KillMode=process` and SIGTERM meaning "restart", `systemctl stop hobby`
stopped the daemon and left the proxy running, holding `proxyPort`. What
systemd offers, from systemd.service(5):

- A restart is "implemented as stop operations followed by start operations",
  so `ExecStop=` and `ExecStopPost=` run on `systemctl restart` as well as on
  `systemctl stop`. `ExecStop=hobby daemon stop` would end sessions on every
  restart, which is the thing the split exists to avoid.
- `$SERVICE_RESULT`, `$EXIT_CODE` and `$EXIT_STATUS` (set for `ExecStop=` and
  `ExecStopPost=`) describe how the main process ended, not whether a stop or a
  restart was asked for, and nothing else passed to the daemon or to those
  commands names the operation. Asking systemd for the unit's pending job
  type from inside `ExecStop=` is undocumented for this purpose and was not
  used.
- `ExecReload=` is for a configuration reload, and its own documentation
  warns against an asynchronous one; a reload that makes the main process
  exit was not adopted, because how systemd treats the main process exiting
  mid-reload is not something the docs promise.

No mechanism tells stop from restart reliably, so the safe default wins:

- The unit sets `Environment=HOBBY_SIGTERM=stop`. `sigtermModeFromEnv`
  (`packages/cli/src/daemon/restart-request.ts`), read by `cmdDaemon` and
  passed as `StartDaemonOptions.sigterm`, makes a plain SIGTERM the full stop,
  proxy included. `systemctl stop hobby` frees the port. `systemctl restart
  hobby` is now the same full stop followed by a start: **its sessions end.**
  Outside the unit SIGTERM is still a restart, as before.
- The restart that keeps sessions is explicit: **`hobby daemon restart`**
  (`cmdDaemonRestart`, `packages/cli/src/cli/commands.ts`). It writes the
  daemon's pid to `$HOBBY_HOME/restart-request` (0600) and sends SIGTERM. The
  daemon's handler (`onSigterm`) takes the request only if it names this pid
  and is under a minute old, removes it either way, shuts down in restart
  mode and exits `RESTART_EXIT_CODE` (75). The unit's
  `RestartForceExitStatus=75` has systemd start the daemon again after
  `RestartSec`, and with `KillMode=process` the proxy is not touched; the new
  daemon adopts it. The CLI waits for a new pid in the daemon lock and reports
  it, or says that nothing restarted the daemon (a `hobby daemon` started by
  hand has no supervisor), leaving the proxy and its sessions up.
- A daemon crash still leaves the proxy up for `Restart=on-failure` to bring
  the daemon back to.

Tests: `HOBBY_SIGTERM` parsing, the restart request (once, only for its pid,
only while fresh, file mode 0600) and `onSigterm`'s choice of mode and exit
code, in `packages/cli/test/proxy-supervisor.test.ts`. **Not verified on a
real systemd box**: that `RestartForceExitStatus=75` restarts after a clean
restart-mode exit, that `KillMode=process` leaves the proxy alone through it,
and that `systemctl stop` now frees the port within `TimeoutStopSec`.
