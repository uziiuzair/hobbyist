# `docs/cli/` the `hobby` binary

**Status:** PROPOSED. Nothing built.

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
hobby init                       prepare the host, check the filesystem, start the daemon
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
