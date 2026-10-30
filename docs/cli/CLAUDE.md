# `docs/cli/` the `hobby` binary

**Status:** BUILT. Thirty verbs in the `USAGE` table of
`packages/cli/src/cli/main.ts`, documented at
`site/src/content/docs/docs/reference/cli.md` and checked against the source
in CI. The body below is the original scope guard; where it has drifted from
what shipped, the dated amendments at the end say so.

The single user-facing entry point. Every capability in this repo is reachable
through `hobby`, and nothing is reachable any other way. There is no web
dashboard, no REST API for humans, and no config file that has to be hand-edited
to do something the CLI cannot.

## Why this is capability 1

The CLI is the product surface. Managed Postgres platforms are not bought for
their storage engines, they are bought because provisioning is one click and the
connection string is right there. Our equivalent of that click is one command,
so the command has to be exceptional.

## The shape

```
hobby init                       prepare the host, check the filesystem, say how to start the daemon
hobby new <name>                 project + postgres + connection string, one command
hobby ls                         everything, with sleep state
hobby pg create --project <p>    the explicit form, for a second database
hobby sleep|wake <target>        manual override
hobby connect <target>           open psql against it
hobby studio                     print the URL, open the browser
hobby studio passwd              set the operator credential, on the box only
hobby branch <src> <dst>         a new project from a clone of <src>'s data
hobby rm <target>                destroy, with a confirmation
hobby eject <project>            emit docker-compose.yml plus data
hobby eject <project> --release  the same, and hobby stops acting on it
hobby adopt <project>            manage a released project again
hobby snapshot <project>         a local, quiesced snapshot (ADR 0016)
hobby snapshot ls <project>      its snapshots
hobby snapshot restore <p> <id>  into a new project, or --in-place
```

Verb-noun-target. No subcommand deeper than three levels.

**`hobby new` carries the promise.** The root `CLAUDE.md` says one command gives
you a Postgres, and that has to survive Projects existing. `hobby new blog`
creates the project, creates the `postgres` resource in it, and prints the
connection string. Everything else is the explicit form for when you want
something other than the common case. A second postgres in the same project
(`hobby pg create --project blog analytics`) is reached through the proxy as
`blog.analytics`, which is the string `hobby connect blog/analytics` prints;
the first one's string keeps working (issue #66, `docs/proxy/CLAUDE.md`).

## In scope

- Command surface, argument parsing, help text
- Config resolution: flags, then env, then project file, then global defaults
- The daemon: lifecycle, supervision, IPC with the CLI, where state lives on disk
- Output conventions: human-readable by default, `--json` on every command that
  returns data, exit codes that scripts can trust
- `hobby init` host preflight, including the reflink capability check

## Out of scope

- Anything that talks the Postgres wire protocol, which is `proxy/`
- Container start and stop mechanics, which is `engine/`
- The MCP surface, which is `mcp/`, though it wraps these same verbs and must not
  drift from them

## Decisions made

- **Language and runtime: TypeScript on Bun**, shipped as a compiled single
  binary. See `docs/decisions/0006`.
- **Daemon, not daemonless.** Hibernation needs something always watching, and
  the proxy has to be resident to answer connections at all.
- **State lives in one SQLite file the daemon owns.** The most boring thing that
  survives a hard reboot.
- **`hobby init` warns loudly on ext4 and proceeds.** Refusing to run on the most
  common VPS filesystem is how a tool gets uninstalled in the first thirty
  seconds. Branching degrades to a real copy there and says so.

## The daemon API is the only control surface

The daemon serves one HTTP API on two listeners: a **unix socket** for the CLI
and MCP, where filesystem permissions are the authentication and no credential
exists to leak, and a **loopback TCP port** for Studio, reached only through
Caddy and gated by the operator credential (`docs/decisions/0008`).

Same routes for all three clients. This is what makes the "CLI and MCP must never
diverge" rule in `docs/mcp/CLAUDE.md` structural rather than a matter of
discipline: there is only one surface to drift from.

## Open questions

- What is the story on macOS? APFS supports reflinks, so a Mac Mini is a valid
  target, but the container runtime differs.
- Does the daemon supervise itself, or does it hand that to systemd and launchd?
  Handing it over is less code and worse on the boxes that have neither.

## Amendment, 2026-10-29: help, version, and what a link means (issues #96, #98, #76)

`hobby <verb> --help`, `hobby <verb> -h` and `hobby help <verb>` print that
verb's rows from the `USAGE` table in `packages/cli/src/cli/main.ts`, the same
table `printHelp` prints in full. The table replaced a run of `io.out` calls
so one verb's help could be printed without a second copy of the text;
`site/scripts/check-cli-reference.mjs` parses the verb column out of it.
`hobby version` (and `--version`) prints `CLI_VERSION`
(`packages/cli/src/version.ts`, read from the package's own package.json) and
the daemon's, from a new `GET /v1/version`. That is a separate route rather
than a field on `/v1/health` because health is the one path the studio
listener answers without a session (`UNAUTHENTICATED_PATHS`,
`packages/cli/src/daemon/studio/routes.ts`), and a build number should not
be readable from the network unauthenticated.

`hobby link` now means what its own message said. `cmdDeploy` takes the
linked project when `--project` is absent (it used to create a project named
after the directory). The single-target verbs (`connect`, `sleep`, `wake`,
`logs`, `pin`, `unpin`, `eject`, `adopt`, `snapshot`, `snapshot ls`) act on
the linked project when given no target, through `targetOrLinked`
(`packages/cli/src/cli/commands.ts`). `resolveTarget` takes the link as a
third argument and tries a bare name as a resource of the linked project
before reading it as a project name, so `hobby logs web` beside a hobby.json
pointing at `blog` means `blog/web`. A target with a slash never consults the
link. `rm`, `snapshot restore`, `snapshot rm` and the `queue` verbs are
deliberately still explicit.

Wrangler keys a worker deploy ignored used to reach only the daemon's
stderr. `createResourceRoute` and `deployResourceRoute`
(`packages/cli/src/daemon/routes.ts`) now put them on the response as
`ignored: [{ key, reason }]` (`ignoredEntries`,
`packages/worker/src/manifest.ts`), and `cmdDeploy` prints one
`ignoring <key>: <reason>` line each, on create and redeploy, and includes
the list under `--json`. The response shape for `ignored` changed from a
list of keys to a list of objects; Studio's `DeployResult` type was updated
and nothing in Studio read the field.

## Amendment, 2026-10-30: where the body above has drifted (issues #142, #145)

Three statements in the body were true when written and are not now. They
are left in place as the record and corrected here.

- **`hobby init` does not start the daemon.** It prepares the host, runs the
  preflight, and ends with `host is ready. run \`hobby daemon\` to start the
  daemon.` (`cmdInit`, `packages/cli/src/cli/commands.ts`). The daemon is
  started by `hobby daemon` in the foreground, or by an init system. The shape
  table above now says so.
- **The binary runs on Node, not Bun.** `packages/cli/bin/hobby.js` begins
  `#!/usr/bin/env node`, and the install script builds with `tsc`. ADR 0006
  chose Bun as runtime and compiler and, in the same breath, required the code
  to be written against Node-compatible APIs precisely so the runtime could be
  swapped; that is what happened. ADR 0006 is immutable and stands as the
  record of the original choice; the shipped runtime is Node.
- **There are no configuration flags.** "Config resolution: flags, then env,
  then project file, then global defaults" describes `resolveConfig`'s
  signature, which accepts `flags`, but its one caller
  (`packages/cli/src/cli/main.ts`) passes `{ env, cwd }`. Resolution is
  `HOBBY_*` environment, then a `hobby.json` found walking up from the
  working directory, then `DEFAULT_CONFIG` (`packages/core/src/config.ts`).
  Flags that exist on verbs (`--sleep-after`, `--port`, `--pin`) act on one
  project or resource, never on the daemon's config.

Two things the body does not mention that the reference page now does: the
CLI's six exit codes (`packages/cli/src/cli/exit.ts`, `EXIT_CODE_BY_ERROR`),
and the fact that `site/scripts/check-cli-reference.mjs` now compares flags
per verb and the exit code table as well as the verb list, so a flag added to
a `parseArgs` spec without a line on the page fails CI.

## Amendment, 2026-10-30: CLI papercuts (issues #97, #106, #107, #109, #110, #111, #114, #103)

`parseArgs` (`packages/cli/src/cli/main.ts`) treats a single-dash token as a
flag: `-h` sets `help` (an alias for `--help`, which `run` already handles
before the verb's parse), any other `-x` is `unknown flag: -x`, and a
negative number stays a positional. Before this `hobby logs -h` reached the
daemon as the target `-h` and `hobby ls -j` ignored `-j`.

`readFileConfig` (`packages/core/src/config.ts`) wraps `JSON.parse` and
throws `HobbyError('usage', 'hobby.json at <absolute path> is not valid
JSON: <parse message>')`. `assertSocketPathFits` in the same file refuses a
socket path over `SOCKET_PATH_MAX_BYTES` (103, the macOS `sun_path` limit
less the NUL) naming the path, its length and `HOBBY_HOME`; `cmdInit`
(`commands.ts`) and `startDaemon` (`packages/cli/src/daemon/server.ts`)
both call it, so `hobby init` fails where `hobby daemon` used to fail with
a raw `listen EINVAL`. No `HOBBY_SOCKET` override was added.

Under `--json`, `handleError` (`main.ts`) prints every failure as the API
envelope `{"error":{"code","message","hint"}}` on stderr, one line, exit
code unchanged; `errorEnvelope` (`commands.ts`) is the one place that
builds it, and `daemon_unreachable` is its one code that is not a core
`ErrorCode`. `hobby token rm`, `hobby logout`, `hobby update` (both
`--check` and "already on") and `hobby studio` print a JSON object under the
flag; `hobby studio` reads its subcommand from the positionals, so
`hobby studio --json` is the verb with a flag, and `studio passwd` accepts
and ignores `--json`.

`cmdUnpin` with no `--sleep-after` sends no field (`setSleepPolicy`,
`client.ts`, omits it for `undefined`), and `setSleepPolicyRoute`
(`packages/cli/src/daemon/routes.ts`) fills `ctx.config.sleepAfterSeconds`,
the daemon's own default; it refuses with `usage` when that default is
null. The CLI's own `sleepAfterSeconds` is no longer consulted. `GET
/v1/projects` carries `defaultSleepAfterSeconds` so `cmdLs` can print
`(pinned)` for a null threshold and `(sleeps after Ns)` for one that differs
from it (`sleepPolicyTrailer`, `output.ts`); a daemon without the field gets
only the pin marker. `cmdPin` fetches the project after setting the policy
and prints `pinned: it will not sleep once woken` when any resource is not
running. Pin still wakes nothing.

`renderResourceLine` (`output.ts`) ends a postgres line with `connect: hobby
connect <project>/<name>` (the project name is a new third argument, which
`cmdLs` passes) instead of `port <hostPort>`; `hostPort` stays in `--json`
as `config.hostPort`. `destroyResourceRoute` removes the resource's
directory with a non-recursive `rmdir` once the kind has torn down what it
owns, so only an empty shell goes and a worker's kept `do/` and `state/`
stay; `deleteProjectRoute` tries the same on the project directory when a
teardown step failed and the recursive removal was skipped. `cmdConnect`
without psql prints the connection string, then install hints for Homebrew's
`libpq` and Debian's `postgresql-client`, and exits 1 as before. The third
bullet of #114 (a manual sleep clearing a wake refusal) is in PR #213's
`stopResourceRoute`, not here.

## Amendment, 2026-10-30: install, update and remote rough edges (issues #112, #113, #135, #136, #138)

- **`hobby token` and `hobby studio` know about the remote (#112).** `run`
  (`packages/cli/src/cli/main.ts`) reads `activeRemote` before dispatching
  them. `token` refuses with a `usage` error naming the remote, because
  tokens live in files on the box that holds them (`readTokens`, `issueToken`,
  `revokeToken` in `packages/cli/src/daemon/studio/tokens.ts`); `studio`
  prints and opens the remote's URL, since the daemon serving the API serves
  Studio on the same origin (`cmdStudio`, `remoteUrl`).
- **Login order and messages (#113).** `cmdLogin` builds the anonymous remote
  client, which is what refuses plain http off loopback, before it prompts
  for the password. A TLS handshake against a daemon speaking plain http is
  reported as "does not speak https" with the `http://` form to try. A 401
  from a remote on any verb is reported as that box rejecting this machine's
  token, with `hobby login <url>` as the way back (`run`'s catch). `hobby
  connect` against a remote notes when the address it was handed is loopback
  on that box.
- **`hobby update` finds the checkout it runs from (#136).**
  `runningCheckout` resolves four directories up from the compiled module and
  is used when `HOBBY_SRC_DIR` is unset, before falling back to
  `$HOBBY_HOME/src`. `--check` exits `EXIT_UPDATE_AVAILABLE` (6) when a newer
  tag exists. The before/after pair is `git describe --tags --always` on both
  sides. The rebuild runs `install.sh` with `HOBBY_INSTALL_QUIET=1`, which
  skips the first-install welcome text.
- **The web installer handles a tag ref (#135).** `scripts/web-install.sh`
  fetches tags and resets to `refs/tags/<ref>` when the ref names one, and
  clones with `advice.detachedHead=false`.
- **First-run papercuts (#138).** `ensureCreated` (`packages/core/src/docker.ts`)
  pulls a missing image explicitly with a log line and a bounded error;
  `install.sh` checks for curl and mentions psql and the systemd unit;
  `hobby init` warns when `HOBBY_HOME` is on tmpfs (`PreflightReport.filesystem.tmpfs`,
  `tmpfsWarning`) and the reflink note names XFS `reflink=1`; `hobby eject`
  says where it writes the queue backlogs before writing them; a missing
  daemon socket reads "no daemon is listening at <path>" instead of the
  runtime's URL wording. The install guide gained a section on running the
  daemon under systemd and an uninstall list that covers containers,
  networks, images and the lock file.

## Amendment, 2026-10-30: daemon and API bugs (issues #108, #117, #118, #64, #132)

**`hobby init` checks what `hobby daemon` will do (issue #108).**
`runPreflight` (`packages/cli/src/daemon/preflight.ts`) used to probe
`proxyPort` and `studioPort` on loopback and nothing else, so it said `host
is ready` for `HOBBY_PROXY_HOST=bogus`, for a taken `apiPort`, and with a
daemon already running; `studioPort` is a port nothing listens on. It now
reports `ports.proxy`, `ports.api`, `ports.http`, `ports.queue` and, with
Caddy on, `ports.caddy` (80 and 443), each a `PortCheck { port, host, bound,
error }`: `bound` is EADDRINUSE, `error` is the errno when the probe could
neither bind nor learn it was taken (EADDRNOTAVAIL, ENOTFOUND), which is
what the daemon's own bind would get. The proxy is probed on the address
`resolveProxyHosts` resolves (moved from `server.ts` to `proxy-hosts.ts` so
preflight can call it without a cycle), and the resolution itself is
reported as `proxyHost { setting, hosts, error }`, so `tailnet` with no
tailscaled carries the daemon's own refusal. 80 and 443 are probed by
connecting, not binding, since a non-root process cannot bind them to find
out. `daemon` is the machine-wide lock (`inspectDaemonLock`,
`single-instance.ts`): pid, home, `running`, and `self` when the lock is the
answering daemon's own, which is what Studio's call to `/v1/preflight`
sees. `studio { listen, publicHost }` is what ADR 0008 asked init to state.
`ports.studio` is gone from the report. `renderPreflight`,
`preflightBlockers`, `studioExposureNote` and `diskWarning`
(`packages/cli/src/cli/output.ts`) turn that into lines; `cmdInit` says `a
hobby daemon is already running (pid N)` and stops when the lock is live,
prints `host is not ready` and exits 4 when a port is taken or unbindable,
and only otherwise says `host is ready`. Low free space (under 1 GiB) is a
note on stderr, not a blocker.

**Status codes (issue #117).** Two new `ErrorCode`s in
`packages/core/src/errors.ts`: `too_many_attempts` (429) and `not_found`
(404). `LoginThrottle.check` (`packages/cli/src/daemon/studio/auth.ts`)
throws `ThrottledError`, a `HobbyError('too_many_attempts')` whose message
is `too many attempts, retry in Ns` and which carries `retryAfterSeconds`;
the studio router and the auth gate (`studio/routes.ts`) send it with a
`Retry-After` header. `cmdLogin` (`packages/cli/src/cli/commands.ts`) prints
the daemon's message on a 429 instead of `invalid credentials`. `dispatch`
(`routes.ts`) throws `not_found` for an unknown route, both for a path
outside `/v1` and for an unmapped one inside it; `usage` is kept for a
malformed request to a route that exists. A missing file under `/assets/`
is 404 rather than the SPA fallback (`serveStudioStatic`,
`studio/static.ts`). Exit codes: `not_found` is exit 3, `too_many_attempts`
exit 1; no seventh exit code, since neither is a new kind of outcome for a
script. The one thing the issue lists that did not change: `HEAD /` still
answers through the auth gate like any other method, since static serving
is GET-only on purpose.

**Bearer tokens (issue #118).** `ApiTokenRecord` gained `lookup`, the first
8 hex characters of SHA-256 of the plaintext, written by `issueToken`
(`packages/cli/src/daemon/studio/tokens.ts`). `verifyToken` computes the
same key for the presented token and runs argon2 only against the record
with that key, so a bogus token costs a hash and a file read (measured under
20 ms for ten attempts against three issued tokens in `auth.test.ts`, versus
about 55 ms per request before). Records written before the field existed
are verified the old way and re-keyed on their first success, so an upgrade
locks nobody out. `isAuthenticated` (`studio/routes.ts`) counts a bearer
failure against the same per-address `LoginThrottle` as a wrong password
and clears it on success; inside the window it answers 429 exactly as the
login route does. The lookup key is not a secret and is never logged;
neither is any token byte.

**A lock another user owns (issue #64).** `acquireDaemonLock`
(`single-instance.ts`) used to swallow every `unlinkSync` failure on a stale
lock and end with `another daemon reclaimed it while this one was starting.
Try again.`, which on Linux's sticky `/tmp` can never come true for a file
root left behind. EPERM and EACCES on the unlink now throw `conflict` with
the owner (`root (uid 0)`, or the uid), the user this daemon runs as, the
dead daemon's pid and home from the record, and the two things that work:
`sudo rm /tmp/hobby-daemon.lock` or running the daemon as that user.
ENOENT (someone else reclaimed it first) still retries. Pinned with a
read-only parent directory in `single-instance.test.ts`, skipped as root.

**`HOBBY_CADDY_ADMIN_PORT` is honoured (issue #132).** `caddyAdminPort` was
read into config and used only as the port the daemon polled; the container
started from the image's default Caddyfile with the admin API on 2019, and
`buildConfig` (`packages/cli/src/daemon/caddy.ts`) pushed configs with no
`admin` block, so any other value waited 1500 ms and failed. `ensureRunning`
now writes `$HOBBY_HOME/caddy/Caddyfile` holding `{ admin
127.0.0.1:<port> }` (`renderBootstrapCaddyfile`) on every start and
bind-mounts it over `/etc/caddy/Caddyfile`; every pushed config carries
`admin.listen` with the same address, since a config without it would move
the listener back to Caddy's default. `startDaemon` (`server.ts`) passes the
path. A `hobby-caddy` container created before this has no bind and keeps
2019; the unreachable-admin error now names the configured port and says to
`docker rm -f hobby-caddy` once. The fixed `:80, :443` listen and the fixed
container name the issue also mentions are unchanged.
