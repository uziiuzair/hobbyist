# `docs/compute/` workers and apps

**Status:** IN PROGRESS. **Phase 2.** The design is ratified and filed at
`specs/2026-08-10-phase-2-compute-design.md`, which is the actionable document;
this file remains the scope guard.

**The gate is gone.** Phase 2 used to be blocked until Phase 1 had been in the
author's daily use for 30 consecutive days. `docs/decisions/0010` removed that on
2026-08-10, two days after Phase 1 merged, and records plainly that the gate was
correct and was removed anyway.

Registers two resource kinds, `app` and `worker`, against the same
`ComputeRuntime` interface Postgres already uses.

**Amended 2026-08-13: creating a compute resource and deploying code into it
are two separate acts, not one.** This file previously described build as
part of resource creation, matching the daemon's original route, which
required a build source before it would commit a row at all. That made Studio
and MCP unable to create an `app` or a `worker`: there was no way to name one
without also handing the daemon a filesystem path to build from, and neither
surface has one. `docs/decisions/0014` records the reversal: `POST
/v1/projects/:name/resources` now produces a row, an id and a hostname on its
own, in a new resting state, `undeployed`, and `POST /v1/resources/:id/deploy`
is the separate act that builds and ships code into it. `hobby deploy`
resolves-or-creates the record and then deploys, so the CLI's one-command path
is unchanged; giving Studio and MCP the create half is sub-project D1, not
built by this ADR.

## Stateless, deliberately

**Phase 2 compute has no persistent local disk.** State lives in Postgres.
Volumes are Phase 3. This is not an oversight: volume lifecycle, backup and
branching interactions are real work, and putting them in the same phase as a new
runtime, a build pipeline and HTTP wake would make the hardest phase harder.

## What "many runtimes work" means

**For `app`, it means containers, and only containers.** A Next.js app, a Python
service and a Go binary are the same thing to us: an image that listens on a
port. We do not ship per-language buildpacks. Bring a `Dockerfile`, or bring an
image.

That is a smaller promise than "Python and JS and many others just work," and it
is the honest version of it.

**For `worker`, it means workerd.** Amended 2026-08-10: a `worker` is not a
container of your choosing running a background process. It is a Cloudflare
Worker, running on Cloudflare's own open-source runtime, configured from your own
`wrangler.toml`. See `docs/decisions/0011`. The container is ours, not yours, and
what you bring is a Worker.

## Wake on request

The sleep wedge is the reason compute belongs here at all. An app that sleeps and
wakes on the first HTTP request is the same mechanism as a database that wakes on
connection, behind one router. **A compute kind that cannot sleep does not
belong in Hobbyist**, because without that it is Coolify with fewer features.

The request path for a sleeping app: client, Caddy, our router, wake, upstream.
Caddy holds the request while the container comes up but never triggers the wake,
which stays in `@hobby.sh/proxy`. See `docs/decisions/0009`.

## In scope

- The `app` and `worker` resource kinds
- Build: from a `Dockerfile` or a prebuilt image
- HTTP wake, and the cold start budget for it, which is a different number from
  the Postgres one and needs setting separately
- Hostname allocation per app, and custom domains via Caddy on-demand TLS
- Logs, and enough of them to debug a deploy without SSH
- Scheduled workers, if and only if daily use demands them

## Out of scope

- Buildpacks, language autodetection, framework-specific magic
- Global edge execution. One box.
- Persistent volumes, which are Phase 3
- Multi-node scheduling, autoscaling, replicas

## Open questions

The three questions this file has carried since 2026-08-07 are answered in
`specs/2026-08-10-phase-2-compute-design.md` and repeated here in one line each,
because the answers are scope-shaped and belong in the scope guard:

- **HTTP cold start budget:** 1 second target, 3 second hard ceiling, both kinds,
  with a 300ms stretch target for `worker`. Unmeasured until M10, and therefore
  still an assertion.
- **Builds:** on the box, one at a time globally, capped at `--memory=2g` and
  `--cpu-shares=512` so a build always loses to a database serving a query.
- **Eject:** yes, and verified by running it, not by asserting it. A kind that
  cannot be ejected does not ship.

Answered on 2026-08-10 by running it, not by reading:

- **Miniflare's Durable Object layout** is workerd's own,
  `<uniqueKey>/<objectId>.sqlite`, provided `durableObjectsPersist` is set
  explicitly rather than through `defaultPersistRoot`. See
  `research/2026-08-10-http-cold-start-measurements.md` for the run that
  settled it and `docs/durable-objects/` for what depends on it.

Still open, and all real:

- ~~**A Durable Object alarm cannot fire inside a stopped container.**~~ Closed
  2026-08-10. `@hobby.sh/do` holds the schedule outside the runtime: the
  `worker` handler's `guard` refuses to sleep a worker with an alarm due soon,
  and the daemon's alarm mirror wakes one whose deadline arrives while it is
  asleep. workerd reloads and fires the alarm itself once running. See
  `docs/durable-objects/`. The seam marked in `packages/worker/src/kind.ts` is
  filled.
- **Cold start on a five dollar VPS is unmeasured.** The Mac numbers pass
  comfortably and are the easy end of the matrix.

## Amendment, 2026-10-29: readiness and rollback (issues #79, #161, #78)

**The app probe accepts a slow homepage (#79).** `tcpProbe`
(`packages/app/src/readiness.ts`) sent `GET /` with a 500ms window and read
a quiet socket as "not listening", so an app whose `/` took longer (a
server-rendered page that queries the database) could never deploy and
failed with the loopback-bind hint while listening on 0.0.0.0 the whole
time. Docker's port proxy produces exactly two shapes for a container with
nothing listening inside, a refused dial and an accept followed at once by a
close, and never a socket it holds open: it only keeps the host side open
once its own dial into the container has succeeded. So a connection held
quietly for the window now counts as listening. A fast server still answers
in milliseconds and pays nothing; the loopback-bind failure still closes at
once and still gets its hint. `GET /` is still sent, so an app's `/` handler
still runs once per wake; a user-defined health path is #90 and is the
answer to that.

**The worker probe never calls the user's worker (#161).** It sent `GET /`
to the worker's own port on every start, queue and alarm wakes included, so
a `fetch` with side effects ran once per wake with no request from anyone.
Readiness is now the control port alone: the runner starts its control
server only after `await mf.ready`, which is workerd listening on the
worker port, and the control server answers `GET /` itself with a 404
before anything reaches user code. The same single probe covers consumers,
which is the guarantee the control-port check was originally added for. A
worker image built before the control server existed will not pass this
probe until it is redeployed.

**A failed redeploy rolls back (#78).** The previous tag was always kept on
disk for exactly this and nothing ever rolled back to it: `deployApp`
committed the new image before the readiness probe, so a `server.js` that
threw on line 1 replaced a working site with a 504. Both `deployApp` and
`deployWorker` now end a failed redeploy in `rollBackDeploy`: a failure
before anything was replaced (the build) leaves the resource exactly as it
was; a failure after it writes the previous config back, recreates the
container from the previous image and leaves it `sleeping`, which is where
every successful deploy ends too; a resource that was already `failed` has
nothing known good to go back to and stays `failed`. The error's hint says
which happened.

**A start that fails readiness stops its container.** All three container
kinds now do what `startPostgres` does (engine amendment of the same date,
#59), so the next start is a real one.

## Amendment, 2026-10-29: `DATABASE_URL` goes through the proxy (issue #53)

`databaseUrlFor` (`packages/app/src/app.ts`) and the worker kind's
`hyperdriveUrl` used to build `postgres://...@hobby-blog-primary:5432/blog`,
straight at the container, on the reasoning that an app just woken should
not wake the proxy in turn. That reasoning was wrong in both directions: the
app could not wake a sleeping database at all, and its traffic never counted
as activity, so the database slept under it. Both strings now go through the
wake-on-connect proxy by `host.docker.internal:<proxyPort>` with the routing
key `hobby connect` prints, and the container spec maps that name to the
host gateway on Linux. The proxy half, including the Linux listener, is in
`docs/proxy/CLAUDE.md`'s amendment of the same date. Eject is unchanged: an
ejected stack has no proxy, so its compose file names the database service
directly, as before.

## Amendment, 2026-10-29: named reasons for the wrangler keys real projects use (issues #149, #152, #76)

`IGNORED_WITH_REASON` (`packages/worker/src/manifest.ts`) gained entries for
every top-level key a sixteen-manifest production monorepo turned out to
carry: `ai`, `services`, `env`, `assets`, `hyperdrive`, `migrations`, and the
long tail of Cloudflare-only services and bundler options. The point is the
distinction between "not built" and "meaningless here", which `not recognised
by hobby` could not make. `ai` is the one that matters most: Workers AI is
not provided and will not be (AI compute is out of scope, root CLAUDE.md),
and before this the only trace was a daemon stderr line while the worker
failed at runtime on an undefined `env.AI`. The deploy now says so where the
user is looking (CLI amendment of the same date), and the workers guide on
the site has a table of these keys. `migrations` was reworded from "not
recognised" because it is required on Cloudflare and the old wording read as
a fault. An app deployed with `--kind app` from a directory that also holds
a wrangler manifest gets a stderr note from `cmdDeploy` that the manifest,
including its `vars`, is not read.

Not done here, and still open: `[env.*]` selection (there is no `--env`),
service bindings, and cron `[triggers]` (#75) are reported, not built.

## Amendment, 2026-10-29: env vars and secrets after creation (issue #74)

`hobby deploy --env-file` existed for apps and nothing else did: no `--env`,
no way to change variables after creation, workers refused `--env-file`
with "use `[vars]`", which is plaintext in the repository. Every real app
needs a secret somewhere, and a vault is out of scope (root CLAUDE.md), so
this is the plain per-resource answer.

`WorkerConfig.env` (`packages/core/src/types.ts`) is new, optional for rows
written before it, above the manifest split so a redeploy that rebuilds the
manifest from the file does not lose it. `buildRunnerManifest`
(`packages/worker/src/worker.ts`) merges it over `manifest.vars`, the
precedence `wrangler secret put` has over `[vars]` on Cloudflare. The wire
shape redacts its values like an app's (`redactConfig`,
`packages/cli/src/daemon/wire.ts`).

`POST /v1/resources/:id/env` (`envRoute`, `packages/cli/src/daemon/routes.ts`)
takes `{ set, unset, replace }`, persists to config, stops a running
resource, and removes its container so the next wake creates one from the
new config; nothing is rebuilt. (Amended 2026-10-30 after running it: both
kinds hand the environment to docker at container creation and both start
paths call `ensureCreated`, a no-op for an existing container, so a stopped
container restarted on the next wake came back with the old values. The
route removes it now.) It returns key
names and `stopped`, never values. Keys are validated against the POSIX name
rule at the route, not only in the CLI, since MCP and raw POSTs reach it too.

`hobby deploy --env K=V` is repeatable (`multi` flags in `parseArgs`,
`packages/cli/src/cli/main.ts`) and wins over `--env-file`. A worker deploy
given neither reads `.dev.vars` beside its manifest when present, the file
`wrangler dev` reads. `hobby env set|ls|unset <target>` (`cmdEnv`,
`packages/cli/src/cli/commands.ts`) follow the link like every target verb;
`ls` reads names off the redacted wire config, so the CLI has no code path
that could print a value. MCP mirrors the three as `hobby_env_set`,
`hobby_env_ls`, `hobby_env_unset` (`packages/mcp/src/tools.ts`).

## Amendment, 2026-10-29: building from a monorepo (issues #146, #147, #148, #151)

A real production monorepo (four Next.js apps and eleven workers) could
deploy one app and none of the workers from their real directories. Four
causes, four fixes, all in how a build is described and assembled.

`AppConfig.source` (`packages/core/src/types.ts`) keeps `path` as the build
context and `dockerfile` relative to it, and gains `buildArgs`, persisted so
a redeploy rebuilds the same way. `hobby deploy <root> --dockerfile <f>
--build-arg K=V --name <n>` is the CLI for it; the daemon's
`readSourceInput` / `appSourceFrom` (`packages/cli/src/daemon/routes.ts`)
default a create to `Dockerfile` and a redeploy to what the app was last
built with, so a plain `hobby deploy` no longer resets a custom Dockerfile.
`BuildSpec.buildArgs` reaches docker as `--build-arg`; values are redacted
on the wire like env (and documented as not a place for a secret, since an
`ARG` bakes them into the image). Eject's compose file carries them as
`build.args`.

Workers get `--context <root>` (`WorkerManifest.source.context`,
`resolveBuildContext` in `packages/worker/src/worker.ts`): the context is
the root, the generated Dockerfile installs there and bundles from the
worker's directory inside it, and a context that does not contain the
worker is refused before any build. Persisted, kept on redeploy, cleared
with `context: null`.

`BuildSpec.exclude` (`packages/core/src/docker.ts`) is the answer to the
missing `.dockerignore`: docker's only exclusion mechanism is a file at the
context root, which for a worker is the user's directory, so the runtime
streams the context itself, as a tar with the patterns left out and the
generated Dockerfile appended under `.hobby.Dockerfile`, to `docker build
-`. Workers always exclude `node_modules` and `.git`
(`WORKER_CONTEXT_EXCLUDES`). A failing tar fails the build with tar's own
words. Apps are unchanged: they have their own `.dockerignore`.

The worker install step no longer discards its errors (`2>/dev/null ||
true`): it runs only when there is a `package.json`, uses pnpm when there
is a `pnpm-lock.yaml` (bun does not read pnpm workspaces), and otherwise
`bun install`, and its failure is the deploy's failure. With `nodejs_compat`
(or `_v2`) in `compatibility_flags`, `nodeBuiltinExternals`
(`packages/worker/src/runtime-image.ts`) marks `node:*` and every bare
builtin from node's own `builtinModules` external, as wrangler does, so a
worker importing `dns` or `tls` bundles and workerd provides them.

Not verified against a real docker daemon in this change; the tar flags
used (`-cf - --exclude P -C dir .`) are the subset GNU tar and bsdtar share.

## Amendment, 2026-10-29: cron triggers (issue #75)

`[triggers] crons` was reported as "scheduled workers are not built yet".
It is built: `triggers` is honoured in `packages/worker/src/manifest.ts`,
each expression is validated at deploy by `parseCron`
(`packages/core/src/cron.ts`, five-field UTC, lists, ranges, steps, names,
either/or day semantics as Vixie cron and Cloudflare), and the list is
persisted as `WorkerManifest.crons`. The runner's control channel
(`RUNNER_SOURCE` and `CONTROL_SOURCE`, `packages/worker/src/runtime-image.ts`)
accepts `POST /scheduled` beside `/queue` and calls `env.USER.scheduled()`
through the same service binding, which `service_binding_extra_handlers`
already made possible for `queue()`.

The daemon keeps the clock: `startCronScheduler`
(`packages/cli/src/daemon/crons.ts`), started in `server.ts` on the alarm
mirror's ten-second tick, computes for every (worker, cron) the first match
after its last firing (or after the daemon started), and when it has passed
wakes the worker through `getOrCreateWake` and posts the firing. State is
in memory on purpose: missed firings while the daemon was down are not
replayed, and several missed in a row collapse to one, both documented in
the module header. `GET /v1/projects/:name/crons` and `hobby cron ls`
(`cmdCronLs`) show next and last per schedule.

Not done: a scheduled() run that outlasts the hibernation window with no
other activity can be slept mid-run; the control request itself does not
count as activity. Noted in the workers guide rather than fixed here.
