---
title: Workers
description: Cloudflare-style Workers on workerd, with the bindings that survive a sleep and the ones that do not exist.
sidebar:
  order: 3
---

<p class="state state--starting">works, rough edges</p>

A `worker` runs your Worker script on workerd, the same runtime Cloudflare runs,
driven through the Miniflare package. Cold start measured at p50 299ms, p95
321ms on an Apple M5 Pro, 2026-08-10.

## Deploy

```sh
cd ./my-worker
hobby deploy
```

A `wrangler.toml`, `wrangler.jsonc` or `wrangler.json` in the directory is what
makes it a worker rather than an [app](/docs/guides/apps/). Your existing
wrangler manifest is read directly; there is no second config format to learn.

## Monorepos

The build context defaults to the worker's own directory. A worker inside a
workspace imports siblings and installs from the root lockfile, neither of
which is reachable from there, so point `--context` at the root:

```sh
hobby deploy ./apps/workers/indexer --project cl --context .
```

The manifest stays where it is; the install runs at the root (`bun install`,
or `pnpm install --frozen-lockfile` when there is a `pnpm-lock.yaml`), and the
bundle runs in the worker's directory. The context is persisted, so a later
`hobby deploy ./apps/workers/indexer` keeps it. The context is streamed to
docker without `node_modules` or `.git`, so the host's own installs never
reach the image and a large workspace does not upload them on every deploy.

Install errors are shown. A worker with no `package.json` skips the install
and must still build; one with a `package.json` whose install fails stops
there, with the installer's own message, rather than at a bundle error
blaming an import you wrote correctly.

## Cron triggers

```toml
[triggers]
crons = ["0 3 * * *", "*/15 * * * *"]
```

The daemon keeps the clock (`packages/cli/src/daemon/crons.ts`). Every ten
seconds it checks each deployed worker's schedules; when one is due it wakes
the worker if it is asleep, through the same wake a request or a queue
message uses, and calls the worker's `scheduled()` handler with the `cron`
string and the `scheduledTime` it was due. Expressions are the five-field UTC
form Cloudflare uses, with lists, ranges, steps and month and weekday names.
A malformed one fails the deploy with the expression and field named.

```sh
hobby cron ls blog
blog/nightly  "0 3 * * *"  next 2026-10-30T03:00:00.000Z  last not yet
```

Two limits, on purpose. Missed firings are not replayed: a daemon that was
down from 02:00 to 09:00 runs a daily 03:00 job tomorrow, as cron on any box
would. And a late schedule fires once, not once per minute missed. A
`scheduled()` handler that runs long keeps the control request open for up to
fifteen minutes; hibernation can still put the worker to sleep under a long
run with no other activity, so keep handlers short or pin the project.

## Node builtins

`compatibility_flags = ["nodejs_compat"]` (or `nodejs_compat_v2`) makes the
bundler leave `node:*` and the bare builtin names (`dns`, `tls`,
`util/types`, the rest) external, the way wrangler does, and workerd provides
what it provides at runtime. Without the flag a Node builtin import fails the
build with `Browser build cannot import Node.js builtin`, which is the same
thing wrangler would tell you.

## Secrets

`[vars]` in the manifest are plain variables, in the repository, exactly as on
Cloudflare. A secret goes in one of three places, all of which end up as
`env.NAME` in the worker, over the manifest's own `vars` where a name
collides:

```sh
# a .dev.vars beside the manifest, the file wrangler dev reads, gitignored
echo 'API_KEY=sk-...' >> .dev.vars
hobby deploy

# or on the command line, which replaces .dev.vars rather than merging with it
hobby deploy --env API_KEY=sk-...
hobby deploy --env-file .env.production

# or after the fact, with no rebuild
hobby env set blog/api API_KEY=sk-...
hobby env ls blog/api
hobby env unset blog/api API_KEY
```

A redeploy without any of these keeps the secrets the worker already has. A
running worker whose variables change is stopped, and the next request (or
queue message, or alarm) wakes it with the new values. Values are redacted on
every API response and never printed.

`hobby env` is also how a worker that declared `[ai]` or another binding hobby
does not provide reaches an external API instead: put the key in a secret and
call the service over HTTP.

## What is honoured, and what is ignored

Your manifest is for a platform with regions, tiers and a global network. This
is one box. Rather than fail on the keys that cannot mean anything here,
`packages/worker/src/manifest.ts` reads what it can and reports the rest as
explicitly ignored, with the reason.

For example `queues.consumers.max_concurrency` is ignored and honoured as 1,
because there is one box and one consumer container. A dead letter queue named
by something other than a string queue name is ignored, and the consumer ends up
with none.

Read the ignored list after your first deploy. It is printed by `hobby deploy`
as one `ignoring <key>: <reason>` line per key, on every deploy, and comes back
as `ignored` under `--json`. A silently dropped setting is the failure mode
this is designed to avoid.

The keys a real production monorepo is most likely to carry, and what hobby
says about each:

| Key | What happens |
|---|---|
| `[ai]` | **Workers AI is not provided.** AI compute is out of scope for hobby, by design. A worker that needs a model calls one over HTTP instead. `env.AI` is undefined at runtime, and the deploy says so. |
| `[[services]]` | Service bindings are not built. Call the other worker over HTTP at its own hostname. |
| `[env.*]` | Named environments are not read. Hobby deploys the top-level config only. |
| `[assets]` | Static assets are not served for a worker. A site with assets deploys as an [app](/docs/guides/apps/), from a Dockerfile. |
| `[[hyperdrive]]` | Not read. `hobby deploy --database <name>` binds the project's Postgres as `DB`; see Bindings below. |
| `[[migrations]]` | Nothing to migrate. Every class in `durable_objects` is bound directly. |
| `[observability]`, `[[tail_consumers]]`, `logpush` | Cloudflare-side telemetry. Use `hobby logs`. |
| `[build]`, `rules`, `define`, `minify`, `no_bundle` and the other bundler keys | Hobby bundles `main` with its own settings. |

A key with no entry in the table inside `manifest.ts` is reported as
`not recognised by hobby`, which means exactly that: nobody has decided what it
should mean here yet.

## Bindings

| Binding | State |
|---|---|
| Durable Objects | Works, and [alarms survive a sleep](/docs/guides/durable-objects/) |
| KV, R2, D1, Cache | Work, persisted under the resource's `state` directory |
| Queues, consuming | Works. A message wakes a sleeping consumer |
| Queues, producing | **Broken on Linux.** [Why](/docs/guides/queues/#the-linux-producer-gap) |
| Hyperdrive | Works, pointed at a [Postgres](/docs/guides/postgres/) resource in the same project |
| Workers AI | **Not provided, and will not be.** AI compute is out of scope. The deploy reports `[ai]` as ignored |
| Cron triggers | Work. The daemon wakes the worker and calls `scheduled()` at each `[triggers] crons` time, see below |

## Where state lives

```
~/.hobby/projects/blog/api/
  bundle/    the built script and the manifest generated from your wrangler file
  state/     KV, R2, D1, cache
  do/        Durable Object sqlite, one directory per namespace
```

Each namespace directory also holds Miniflare's own `metadata.sqlite`, which is
not an object.

## The runtime, honestly

Miniflare's own documentation says it is a development tool.
[ADR 0011](/docs/decisions/0011-workerd-via-miniflare-as-the-worker-runtime/)
runs it as a server anyway, records that this is what it is doing, and names the
fallback: drop Miniflare from the runtime path and generate workerd capnp
configuration directly, at the cost of the KV, R2 and D1 storage APIs.

It is pinned to `4.20260730.0`, because npm's `latest` is a 5.x alpha.

Two things learned by running it, worth knowing if you are debugging a build:

- **Miniflare does not work under Bun.** It asserts on a control pipe file
  descriptor that Bun's `child_process` does not provide. The worker image is
  therefore two stages: Bun builds, Node runs.
- **workerd ships no musl binary.** On Alpine it fails with an `ENOENT` on the
  workerd binary, which reads like a missing file and is a missing platform.

## Eject

```sh
hobby eject blog
```

You get the built bundle, the manifest, and the storage directories. A worker is
not as portable as a Postgres data directory, because workerd is the thing
running it, but nothing is held hostage.
