# Phase 2 compute: `app` and `worker`

Status: RATIFIED. Approved by the author on 2026-08-10, after the design was
presented in full. Nothing in it is built yet, and every section below describes
intent rather than behaviour until the milestone that ships it says otherwise.
Date:   2026-08-10

Supersedes nothing. Fills in `docs/compute/CLAUDE.md`, which has stood at
PROPOSED since 2026-08-07 and states the scope this spec implements.

Two decisions were taken to write this and are recorded separately, because they
are the kind of thing that must not be discoverable only by reading a spec:
`docs/decisions/0010` overrides ADR 0007's 30-day phase gate, and
`docs/decisions/0011` chooses workerd, via Miniflare, as the `worker` runtime.

## What ships

Two resource kinds, registered against the same model `postgres` already uses.

| Kind | You bring | It runs | It sleeps |
|---|---|---|---|
| `app` | A `Dockerfile`, or a prebuilt image reference | An OCI container listening on `$PORT` | On idle, wakes on the first HTTP request |
| `worker` | A `wrangler.toml` and an entry script | workerd, via Miniflare, in a container | On idle, wakes on the first HTTP request |

Both are stateless in the sense ADR 0007 means: no persistent volume is attached
to an `app`, and persistence comes from a sibling `postgres` resource or, for a
`worker`, from the Workers storage APIs Miniflare provides. Volumes remain Phase
3.

The claim this makes against Coolify and Dokploy is unchanged and remains
narrow: they deploy apps well and never sleep them. Sleep is the only claim.

The claim it makes against Cloudflare Workers is different and worth stating
precisely, because it is easy to overstate. We do not reimplement Workers. We run
Cloudflare's own runtime, which they published under Apache 2.0, on your box. A
`worker` here is a real Worker, running on real workerd, with real Workers
storage APIs behind it. What we do not have is a global edge, and we are not
trying to: the root `CLAUDE.md` puts one box at the centre of everything.

## 0. Prerequisite: Phase 1's model has to be fixed first

ADR 0007 guard 1 is explicit about this case:

> Additive by construction. Registering a resource kind must not modify an
> earlier phase. If Phase 2 requires changing Phase 1's model, the model was
> wrong and gets fixed before Phase 2 proceeds, not during it.

The model is wrong in four specific places, all of which assume exactly one kind
exists. None of this was a mistake at the time: Phase 1 registered one kind and
typed itself honestly around that fact.

| Where | What is wrong |
|---|---|
| `packages/core/src/types.ts`, `ResourceKind` | The union is the single literal `'postgres'`. |
| `packages/core/src/types.ts`, `Resource.config` | Typed `PostgresConfig`, so a resource of any other kind has nowhere to put its config. |
| `packages/core/src/store.ts`, `createResource` and `allocatePort` | Both parse every stored `config` column as `PostgresConfig`. `allocatePort` reads `config.hostPort` off every row to find a free port, which silently returns `undefined` for a row that has no such field. |
| `packages/core/src/config.ts`, `resourceDataDir` | Hard-codes a trailing `pgdata` path segment for every resource of every kind. |

And three consumers dispatch to Postgres unconditionally, because there was
nothing else to dispatch to:

| Where | What it does today |
|---|---|
| `packages/cli/src/daemon/hibernator.ts`, `tick` | Calls `checkActiveQuery` then `stopPostgres` on any sleep candidate. |
| `packages/cli/src/daemon/reconcile.ts` | Probes Postgres readiness to decide `booting` from `ready`. |
| `packages/cli/src/daemon/routes.ts` | Start, stop and destroy routes call the Postgres lifecycle functions directly. |

### The fix: a resource kind registry

`packages/core` gains a `ResourceKindHandler` interface and a registry that maps
a `ResourceKind` to its handler. This is ADR 0007's "later kinds are registered by
implementing an interface" turned from a sentence into a type.

```ts
export interface ResourceKindHandler<TConfig extends ResourceConfig = ResourceConfig> {
  kind: ResourceKind

  // Bring the resource to `running`, or throw. Idempotent: called on a
  // resource that is already running, this must be a cheap no-op, because
  // the wake path calls it without checking first (the same contract
  // startPostgres already honours).
  start(ctx: KindContext, resource: Resource & { config: TConfig }): Promise<void>

  // Bring it to `sleeping`. Clean shutdown, never a kill.
  stop(ctx: KindContext, resource: Resource & { config: TConfig }): Promise<void>

  // Remove it and everything it owns on disk.
  destroy(ctx: KindContext, resource: Resource & { config: TConfig }): Promise<void>

  // Observed reality for reconcile: is the thing inside the container
  // actually serving, not merely running? `postgres` answers with a real
  // connection attempt (packages/pg/src/readiness.ts's pgProbe); `app` and
  // `worker` answer with a TCP connect to the published port.
  probe(ctx: KindContext, resource: Resource & { config: TConfig }): Promise<boolean>

  // The pre-sleep guard. `postgres` refuses to sleep mid-transaction via
  // pg_stat_activity (packages/pg/src/activity-guard.ts). `app` and
  // `worker` have no equivalent and answer 'idle'. Optional: an absent
  // guard means 'idle'.
  guard?(ctx: KindContext, resource: Resource & { config: TConfig }): Promise<ActivityGuardResult>
}
```

`KindContext` is the subset of `DaemonContext` a handler is allowed to see:
`store`, `runtime`, `paths`, `config`, `activity`. Deliberately not the HTTP
server, not Caddy, and not the proxy, because a kind that can reach those can
break the seam the whole architecture rests on.

`hibernator.ts`, `reconcile.ts` and `routes.ts` stop naming Postgres and start
looking a handler up by `resource.kind`. `@hobby.sh/pg` gains a
`postgresKindHandler` that wraps its existing exported functions, and its
behaviour must not change: the M6 acceptance test is that the existing suite
passes untouched.

### Config becomes a union, discriminated by the column that already exists

`Resource.kind` is already its own column in the store schema
(`packages/core/src/store.ts`, `CREATE TABLE resources`). Discriminating on it
rather than on a tag inside the JSON means no existing row needs migrating, and
`migrate()` in `store.ts` gains nothing for this change.

```ts
export type ResourceKind = 'postgres' | 'app' | 'worker'
export type ResourceConfig = PostgresConfig | AppConfig | WorkerConfig

export interface Resource {
  // ...unchanged...
  kind: ResourceKind
  config: ResourceConfig
}
```

`allocatePort` stops assuming every config has a `hostPort` and instead reads it
through a type guard, treating a config without one as holding no port. Every
kind in this spec does allocate a host port, so the guard is defensive rather
than load-bearing today, which is exactly when it is cheap to add.

### Paths become kind-aware

`resourceDataDir(project, resource)` is replaced by
`resourcePath(project, resource, part)`, with `part` one of `'pgdata'`,
`'bundle'`, `'state'`, `'do'`. Postgres keeps `pgdata`, so no data directory
moves and ADR 0003's invariants are untouched.

```
<home>/projects/<project>/<resource>/pgdata/   postgres data directory, unchanged
<home>/projects/<project>/<resource>/bundle/   worker: built script and generated manifest
<home>/projects/<project>/<resource>/state/    worker: Miniflare persistence root
<home>/projects/<project>/<resource>/do/       worker: Durable Object storage
```

The `do/` convention is a commitment to the session building Durable Objects,
which scans that directory read-only to recover pending alarm deadlines from
stopped objects. It is theirs to read and nothing else writes there.

## 1. The `app` kind

### Config

```ts
export interface AppConfig {
  // Either a built image we own, or a user-supplied image reference. Set
  // to the tag we built for source-based apps, and to the user's string
  // for image-based ones.
  image: string
  // Absent for an image-based app. Present for a source-based one, and it
  // is what `hobby deploy` rebuilds from.
  source: { path: string; dockerfile: string } | null
  containerName: string
  hostPort: number
  // The port the process inside listens on. Passed in as $PORT, and
  // published to hostPort on loopback.
  containerPort: number
  hostname: string
  env: Record<string, string>
  // Resource id of a sibling postgres, if the user bound one. Resolved to
  // a connection string and injected as $DATABASE_URL at start, never
  // stored expanded, so a password rotation does not leave a stale copy.
  databaseResourceId: ResourceId | null
}
```

### Build

`docker build` on the box, through a new optional `build` method on
`ComputeRuntime`. Optional so `createFakeRuntime` and any future microVM runtime
are not forced to implement it, which keeps ADR 0002's escape hatch honest.

Tagged `hobby/<project>-<resource>:<unix-seconds>`, with the previous tag left in
place so a failed deploy can roll back to an image that is known to have served.

`docs/compute/CLAUDE.md` asks what stops a build from starving the box that is
also serving a database. The answer is two mechanisms, both boring:

1. **One build at a time, globally.** A daemon-level mutex, not a per-project one.
   A second `hobby deploy` queues and says so.
2. **The build is capped**: `--memory=2g` and `--cpu-shares=512`, so it loses to
   anything else contending for CPU. A build that is slow is a nuisance. A build
   that makes a database miss its wake budget is a broken promise.

### Contract with the user's image

One requirement, stated once and enforced by a readiness probe rather than by
documentation: **listen on `$PORT`, on `0.0.0.0`, inside the container.**
Binding to `127.0.0.1` inside a container is the single most common way this
fails, so the failure message says exactly that rather than "readiness timed
out".

## 2. The `worker` kind

### Runtime

A container running Bun, the `miniflare` npm package, and a small entry script
of ours that reads a generated manifest and starts Miniflare listening on
`0.0.0.0:$PORT`. One workerd process per worker resource, which is the author's
explicit choice: the alternative, sharing a workerd across a project, would have
bought isolate-speed cold starts at the cost of restarting every worker in the
project on any deploy.

The consequence, stated plainly rather than buried: **a `worker` cold start is a
container start, not an isolate start.** The sub-5ms isolate figure that makes
Workers famous applies only once the container is already running. This is the
conservative choice and it is the one that was made.

Miniflare's own README describes it as a simulator for developing and testing
Workers, and says it is "not intended for production use". We are using it as a
server anyway. The reasoning and the fallback are in ADR 0011.

### Config

```ts
export interface WorkerConfig {
  image: string            // the hobby-built miniflare runner image
  containerName: string
  hostPort: number
  containerPort: number
  hostname: string
  source: { path: string; manifest: string }   // manifest is the wrangler file we read
  compatibilityDate: string
  compatibilityFlags: string[]
  vars: Record<string, string>
  kvNamespaces: string[]
  r2Buckets: string[]
  d1Databases: string[]
  queues: { producers: string[]; consumers: string[] }
  durableObjects: Array<{ binding: string; className: string }>
  // Derived once, from the resource id, and never regenerated. See below.
  durableObjectUniqueKeyModifier: string
  databaseResourceId: ResourceId | null
}
```

### `durableObjectUniqueKeyModifier` is derived, never generated

workerd derives every Durable Object's storage identity from this value. If it
changes, every object's `.sqlite` file is orphaned and the user silently loses
state on a redeploy.

It is derived from the resource's `id`, which is the `randomUUID()` the store
assigns in `createResource` and which never changes for the life of the
resource. Not from the project name and not from the class name, because both are
user-facing strings that a rename would change. Two tests pin this: state
survives a redeploy, and state survives a rename.

### `wrangler.toml`

We read a documented subset and ignore the rest **loudly**, printing every
ignored key at deploy time. Silently ignoring a key in a config file the user
believes is authoritative is how a platform earns a reputation for lying.

Honoured: `name`, `main`, `compatibility_date`, `compatibility_flags`, `vars`,
`kv_namespaces`, `r2_buckets`, `d1_databases`, `durable_objects`, `queues`.

Not honoured, and why: `routes` and `workers_dev` describe Cloudflare's edge, not
your box, so hostnames come from us. `account_id` has no meaning here. `triggers`
(cron) is deferred to the same work that resolves alarms, below.

Bundling is `Bun.build`, already the project's runtime, so no node toolchain is
added to the box.

### Bindings to the rest of the project

The interesting half, and the thing neither Fly nor Coolify nor a bare workerd
gives you: a `worker` in a project can bind to that project's `postgres`.
workerd has a `hyperdrive` binding, which is a Postgres connection binding, and
we wire it from the sibling resource's stored config. The user writes
`env.DB` and gets their own database, with no connection string in their source
and no secret in their repository.

### Alarms are an unsolved wake trigger, and this spec does not solve them

A Durable Object alarm fires at a time. A stopped container has no timer. So a
worker with a pending alarm either never sleeps or misses the alarm, and neither
is acceptable.

The fix lives outside this spec, in the Durable Objects work: the daemon reads
pending alarm deadlines directly from stopped objects' sqlite files
(`_cf_METADATA` key 1, int64 nanoseconds since the Unix epoch) and wakes the
resource at the deadline. This spec's obligation is to consult that predicate
before sleeping a worker, and to leave the seam open for it.

**Until that lands, a worker that sets an alarm will miss it.** That is a known
gap, written here so nobody discovers it in production.

## 3. The HTTP wake path

Caddy does not trigger wakes. ADR 0009 says so and it remains true: nothing in
Caddy knows how to start a stopped container. So every request to an `app` or a
`worker` passes through us.

```
browser :443 -> caddy -> 127.0.0.1:<httpPort> hobby http router -> wake -> upstream
```

New file `packages/proxy/src/http.ts`, which is to port 443 what `proxy.ts` is to
port 5432: it resolves, it wakes, it splices, and it is the activity sensor
hibernation reads. It never starts a container itself. It calls `wake(resourceId)`
and waits, exactly as the Postgres proxy does, so it is testable against a fake
with no Docker in the loop.

Responsibilities, in order:

1. Resolve the `Host` header to a resource. Unknown host is a 404 from us, with a
   body that names the hostnames that do exist.
2. If the resource is sleeping, call `wake` and hold the request. The client sees
   a slow response, never an error, which is the entire point.
3. Proxy the request and the response, including streaming bodies, WebSocket
   upgrades and Server-Sent Events. A response that is held open, which is
   normal for SSE and WebSockets, counts as continuous activity.
4. Report activity to the `ActivityTracker` on request start and release it on
   response end, using the handle-based `open`/`close` pair that
   `packages/proxy/src/activity.ts` already exposes.

### Caddy configuration goes static

Today `createCaddyManager` pushes a route table on every change. With apps and
workers appearing and disappearing constantly, that would mean a Caddy admin API
call per deploy.

Instead, Caddy gets two routes at init and then nothing: the Studio route, and a
catch-all to the HTTP router. All per-resource routing lives in our router, which
already has to resolve the host anyway in order to know what to wake.

The exception is custom domains, which need certificates. Those use Caddy's
on-demand TLS with an ask endpoint on the daemon, which answers "is this hostname
real" before a certificate is issued. That endpoint is a public, unauthenticated
surface by necessity, so it answers only yes or no and never enumerates.

### Hostnames

`<resource>.<project>.<domain>`, with `domain` a new `HobbyConfig` field
defaulting to `localhost`. `*.localhost` already resolves to loopback in
browsers and in curl, so a laptop install works with no DNS and no `/etc/hosts`
edit.

## 4. The cold start budget

Postgres is 1 second target and 3 seconds hard ceiling, because that is where ORM
and pool connect timeouts start firing (`docs/proxy/`). HTTP is judged by a person
watching a blank tab, which is a harsher critic, but a container start is still a
container start.

**Target 1 second, hard ceiling 3 seconds, for both kinds.** Stretch target of
300ms for `worker`.

This number is an assertion until M10 measures it on a five dollar VPS and a Mac
Mini and publishes both, with the hardware stated, the same way M0 was required to
for Postgres. If `worker` misses badly, the named lever is dropping Miniflare from
the runtime path and generating workerd capnp directly, keeping Miniflare only as
the deploy-time config translator. That lever is in ADR 0011.

## 5. Eject

ADR 0007 is unambiguous: a kind that cannot be ejected does not ship.

- An `app` ejects as a compose service with `build:` or `image:`, its environment,
  and its Caddy configuration.
- A `worker` ejects as the same Miniflare runner image with its bundle, its state
  directory and its Durable Object directory mounted, and its Caddy
  configuration.

Both are verified the way eject was verified for Postgres on 2026-08-08: not
asserted, run. An actual `docker compose up` against the emitted file, and an
actual HTTP request that returns the user's own response body, in an isolated
`HOBBY_HOME`.

## 6. Surfaces

### CLI

```
hobby deploy [path]            detect Dockerfile or wrangler.toml, create or update
hobby app create --project <p> <name> --image <ref>
hobby worker create --project <p> <name> --path <dir>
hobby logs <target>            already exists, works unchanged for both kinds
hobby sleep|wake <target>      already exist, dispatch through the kind registry
hobby rm <target>              already exists
hobby eject <project>          already exists, gains app and worker services
```

`hobby deploy` with no path uses the working directory. Detection is
`wrangler.toml` or `wrangler.jsonc` first, then `Dockerfile`. Both present is an
error that asks which, rather than a guess.

### Daemon API

Additive only. `POST /v1/projects/:name/resources` already takes a `kind`, and
gains `app` and `worker`. New: `POST /v1/resources/:id/deploy`, and
`GET /v1/resources/:id/builds` for build history and logs.

### Studio

Out of scope for this spec, deliberately. The daemon API is the only control
surface, so Studio picks these up as a client like everything else, and it gets
its own spec.

## 7. Packages

Two new, one package per kind, mirroring how `@hobby.sh/pg` owns exactly one:

- `@hobby.sh/app`, the `app` kind and the build pipeline
- `@hobby.sh/worker`, the `worker` kind, the wrangler manifest reader, and the
  Miniflare runner image

Both depend only on `@hobby.sh/core`. Neither depends on the other. Neither is
imported by `@hobby.sh/proxy`, which continues to know nothing about kinds.

## 8. Milestones

| M | Ships | Done when |
|---|---|---|
| M6 | Model fix and the kind registry | The existing test suite passes untouched, and `postgres` behaviour is provably unchanged |
| M7 | HTTP wake router, static Caddy catch-all | A fake sleeping resource wakes on a real HTTP request, streaming and WebSocket paths covered |
| M8 | `app` kind | A real Dockerfile deploys, sleeps, wakes on request, and ejects to a compose file that serves |
| M9 | `worker` kind | A real `wrangler.toml` deploys, binds to a sibling Postgres, sleeps, wakes, and ejects |
| M10 | Cold start measured | Numbers published with hardware stated, for both kinds |

## 9. Risks accepted

- **Miniflare is a dev and test tool being used as a server.** ADR 0011, with a
  named fallback.
- **`caddy.ts` uses `network: 'host'`,** which does not exist on Docker Desktop
  for macOS. Phase 1 never ran it, because nothing called `createCaddyManager`.
  Phase 2 makes Caddy load-bearing, so this fails on the author's Mac on day one
  and M7 has to solve it rather than discover it.
- **One workerd per worker costs a container start per wake** and roughly 40MB
  per awake worker. Chosen deliberately over a shared process.
- **Alarms miss until the Durable Objects work lands.** Written above, not
  hidden.
- **Scope.** This spec adds two resource kinds, a build pipeline, an HTTP router
  and a new runtime, in a project whose named failure mode is abandonment at 40
  percent. M6 through M10 are ordered so that the first two are useful even if
  the rest never ship: a kind registry and an HTTP wake router are what Phase 3
  needs regardless.

## 10. Open questions

- **Does Miniflare lay Durable Object storage out as workerd's bare
  `<uniqueKey>/<id>.sqlite`, or does it wrap it?** The Durable Objects work
  depends on scanning that directory. Unverified. M9 confirms it against a
  running Miniflare before anyone writes a scanner.
- **Does `wrangler.toml` parsing need TOML dependencies?** Bun has no built-in
  TOML reader for arbitrary files at the time of writing. Either a small
  dependency, or restrict to `wrangler.jsonc`, and the choice should be made
  against real user files rather than in the abstract.
- **What is the right sleep threshold for an app?** 300 seconds is the Postgres
  default (`packages/core/src/config.ts`). Cloudflare ships 600 for containers
  that cost their owner money
  (`docs/hibernation/research/2026-08-10-cloudflare-containers-sleep-after.md`).
  A web app that sleeps between two page views is worse than a database that
  does, because the user is watching.
