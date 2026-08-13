# Record before code

**Date:** 2026-08-13
**Status:** approved, implemented
**Capability:** `compute`, with changes reaching into `core`, `cli` and `proxy`
**Sub-project:** A of five (A record before code, B wire Caddy, D1 Studio and MCP
for all kinds, D2 Studio API tokens, C remote deploy)

## The problem

A project cannot hold an app or a worker unless the caller already has the code
on disk. `POST /v1/projects/:name/resources` with `kind: 'worker'` requires
`source: { path }`, builds the image, and proves the container serves before the
row is committed (`packages/cli/src/daemon/routes.ts`, `createResourceRoute`).
Resource creation and first deploy are one indivisible operation.

Three consequences, all of them the same bug wearing different clothes:

- **Studio cannot create compute.** Not because a browser cannot upload a
  directory, but because there is no such thing as a compute resource without
  one. `packages/studio/src/api.ts:152` hardcodes `kind: 'postgres'` because
  postgres is the only kind Studio can construct.
- **MCP cannot either**, for the same reason
  (`packages/mcp/src/tools.ts:116`).
- **A project is assumed to contain a Postgres.** `hobby new`
  (`packages/cli/src/cli/commands.ts:337-340`), MCP and Studio
  (`packages/studio/src/views/Projects.tsx:223-224`) all chain
  `createProject` into `createResource(postgres, 'primary')`. The daemon does
  not require this. Every front door does.

The model these front doors should implement is the one Fly and Cloudflare use:
creating a compute resource is a control-plane act producing a row, an id and a
hostname. Deploying is a separate act, run from a working directory, that puts
code into that row.

## What ships

Resource creation is decoupled from deploy. An `app` or `worker` can exist as a
row with an id, a hostname and an allocated port, holding no code, indefinitely.

```
POST /v1/projects/blog/resources  { "kind": "app", "name": "site" }
  -> row, id, hostname blog-site.hobby.local, hostPort allocated
  -> state: undeployed, config.image: null
  -> Studio and MCP can call this. No code is involved.

POST /v1/resources/:id/deploy     { "source": { "path": "/home/me/site" } }
  -> build, start, prove it serves, sleep
  -> state: sleeping, config.image populated
  -> identical whether the resource was undeployed or already running
```

`hobby deploy ./site --project blog` resolves-or-creates the record and then
deploys, so today's one-command ergonomic survives unchanged. Both doors reach
the same route, which is what stops the CLI and MCP from diverging (root
`CLAUDE.md` makes that structural rather than a discipline).

Postgres is no longer implied by a project. `hobby new <name>` still creates one,
because that is the headline ergonomic root `CLAUDE.md` sells. `hobby new <name>
--empty` does not.

## The state machine

`undeployed` joins `ResourceState` (`packages/core/src/types.ts:15`) as a
**resting** state.

The distinction from the existing `creating` is load-bearing. `creating` means
"in flight right now", and `reconcile.ts:43` correctly marks it `failed` when no
container appears, because a create that stalled is a create that broke. For
`undeployed`, having no container is the expected condition, forever.

```
  created ---> undeployed ---deploy---> [creating ---> sleeping] <---> running
                   |                          |
                   |                          +--build fails--> undeployed
                   |                                            (not failed)
                   +---rm---> gone
```

`creating` in brackets is the existing transient state, held only while a deploy
is in flight. `undeployed`, `sleeping` and `running` are the resting states, and
a resource left alone stays in one of them.

Three rules follow:

1. **`reconcile` exempts it**, in the same shape as the `destroying` early
   return at `packages/cli/src/daemon/reconcile.ts:221`. Without this the daemon
   marks every code-less resource `failed` on its next tick, because
   `correctedState` buckets "no container observed" as `missing` and `:137` maps
   `missing` to `failed`.
2. **`hibernator` needs no change.** It already gates on `state === 'running'`
   at `packages/cli/src/daemon/hibernator.ts:35` and `:100`.
3. **A failed first deploy returns to `undeployed`, not `failed`.** `failed`
   means "there is code here and it broke". `undeployed` means "there is no code
   here". Collapsing the two leaves Studio unable to say which command fixes it.

`undeployed` is reachable only by `app` and `worker`. Postgres has no code to
deploy: its image is a registry reference known at creation.

### The invariant this reverses

`packages/app/src/app.ts:181-183` states:

> The build happens BEFORE the resource row exists. A Dockerfile that does not
> compile should leave nothing behind at all: no row to clean up, no allocated
> name, nothing for the user to `hobby rm` before retrying.

That reasoning is correct for a model where creating and deploying are one act,
and wrong for this one. Once a resource has been named in Studio and its hostname
published, a failed build leaving the record behind is the desired outcome: the
user retries the deploy, they do not recreate the app. The row surviving a failed
build changes from litter into information.

This is recorded as a deliberate reversal rather than deleted, per root
`CLAUDE.md`: a reader must be able to see that the old reasoning was considered.

## Config changes

### `ResourceConfigBase`

`image` becomes `string | null` (`packages/core/src/types.ts:47`). Every consumer
that starts a container runs only from `running` or `sleeping`, so the compiler
flags exactly the paths that must handle null. This is the M6 pattern from commit
`abe7582`, where widening a type let the compiler find every site by hand-free
means.

### `WorkerConfig`

Splits along a line that currently exists only as a comment:

```ts
export interface WorkerConfig extends ResourceConfigBase {
  hostname: string
  containerPort: number
  databaseResourceId: ResourceId | null

  // Derived from resource.id at row creation, never regenerated. If this
  // changes, every Durable Object's sqlite file is orphaned and the user
  // silently loses state. It exists before any code does, which is why it
  // sits above the manifest split rather than inside it.
  durableObjectUniqueKeyModifier: string

  // Everything read out of wrangler.toml. Null until the first deploy,
  // because none of it can be known before there is a manifest to read.
  manifest: {
    source: { path: string; manifest: string }
    compatibilityDate: string
    compatibilityFlags: string[]
    vars: Record<string, string>
    kvNamespaces: string[]
    r2Buckets: string[]
    d1Databases: string[]
    queues: { producers: string[]; consumers: string[] }
    durableObjects: Array<{ binding: string; className: string }>
  } | null
}
```

This makes the Durable Object stability rule structural instead of a comment
someone has to read and honour. `uniqueKeyFor()` keeps working unchanged, and a
worker created from Studio has a stable DO identity before it has seen a line of
code, which is strictly better than today, where the identity is assigned in the
same breath as the first build.

### `AppConfig`

`source` is already `| null` (`:68`), for image-based apps. `containerPort` moves
to a deploy-time input defaulting to `8080`, because it describes the user's code
rather than the record.

`WorkerConfig.containerPort` does **not** move, and stays at the top level. The
difference is who chooses it: an app's port is whatever the user's process binds,
and is unknowable before there is code, whereas a worker's port is the one we
tell Miniflare to listen on, so it is ours and is known at creation.

### Allocated at creation, for both compute kinds

`hostname` and `hostPort`. This is what lets Studio show the URL before anything
is deployed, and it is what Caddy's on-demand TLS ask
(`packages/proxy/src/http.ts:47`, `allowHostname`) needs in order to issue a
certificate for a hostname whose code has not shipped. Otherwise a user's first
deploy is also their first TLS handshake and two things fail together.

## Surfaces

### Daemon API

One new capability, no new route.

| Route | Change |
|---|---|
| `POST /v1/projects/:name/resources` | `source` becomes optional for `app` and `worker`. Without it: an `undeployed` record. With it: create-then-deploy, exactly today's behaviour. |
| `POST /v1/resources/:id/deploy` | Already exists (`deployResourceRoute`). Now also valid as a transition out of `undeployed`. Still answers `usage` for postgres. |

### CLI

`hobby pg create` generalises rather than growing two siblings:

```
hobby create <kind> <name> --project <p>     postgres | app | worker. No code.
hobby deploy [path] --project <p> [--name n] build and ship code into a record
hobby new <name>                             unchanged: project + postgres primary
hobby new <name> --empty                     bare project
```

`hobby pg create --project <p> <name>` stays as an alias for
`hobby create postgres <name> --project <p>`, not as a second implementation.

`hobby create` takes no port. An app's port is a property of its code and is
supplied at deploy, defaulting to `8080`.

`hobby deploy` takes exactly one positional argument, the path, defaulting to
`.`. The resource name is **not** positional, because two optional positionals
in one command cannot be disambiguated. It is resolved in this order:

1. `--name <n>` if given.
2. Otherwise the basename of the resolved path, so `hobby deploy ./site` targets
   a resource named `site`.

If no resource of that name exists in the project, `hobby deploy` creates the
record and then deploys into it, which is what preserves today's one-command
path. If one exists, it is redeployed. If one exists with a different kind (a
postgres named `site`), that is a `usage` error naming the conflict rather than a
silent replacement.

`hobby ls` shows the state and, for compute, the hostname:

```
blog
  primary  postgres  sleeping     port 15432
  site     app       undeployed   blog-site.hobby.local  (no code yet)
  cron     worker    sleeping     blog-cron.hobby.local
```

### HTTP router

No new branch. `resolve()` returns the target, the wake path refuses with a
reason, and the existing `{ kind: 'unavailable', reason }` path at
`packages/proxy/src/http.ts:246` renders it:

```
hobby: blog-site.hobby.local has no code deployed yet.
       run: hobby deploy --project blog site
```

`allowHostname` returns **true** for an undeployed resource, per the TLS
reasoning above.

### Wire format

`redactConfig` (`packages/cli/src/daemon/wire.ts:99`) currently redacts
`worker.vars` at the top level. Moving `vars` inside `manifest` means that line
must reach one level deeper. If it does not, redaction silently stops working
while the code still compiles, reintroducing the leak commit `abe7582` closed.
This gets a dedicated test asserting redaction in the nested position.

### Eject

An undeployed app or worker has no image, so it is skipped with a stated reason,
reusing the skip-reporting `abe7582` built rather than emitting a service
definition that cannot start.

## Migration: none, deliberately

`WorkerConfig`'s shape changes, and `packages/core/src/store.ts:122` parses the
config column with an unchecked cast (`JSON.parse(row.config) as ResourceConfig`),
so a pre-existing flat worker row would arrive with `manifest: undefined` and
fail somewhere unhelpful.

There are zero `app` and `worker` rows on the author's box (`hobby ls` shows six
postgres resources and nothing else), and both kinds are three days old and
unreleased. Rather than carry a normaliser for rows that do not exist, the worker
kind asserts the shape on read and fails loudly:

> this worker row predates the manifest split. Delete it and redeploy.

This applies root `CLAUDE.md`'s "prefer deleting a feature to deferring it" to a
migration. If a worker row is later found on another box, write the normaliser
then, against a real row.

## Errors

All `usage`, all naming the command that fixes them.

| Situation | Response |
|---|---|
| wake or start an `undeployed` resource | names the deploy command for that resource |
| deploy with no source, and no source previously recorded | says a first deploy needs a directory |
| deploy against a postgres resource | existing message, unchanged |

## Test plan

Test-driven, fifteen new tests. The existing 453 stay green.

| Area | Assertion |
|---|---|
| state | an app created without a source is `undeployed`, has a hostname, has no image |
| state | a failed first deploy returns to `undeployed`, not `failed` |
| reconcile | an `undeployed` resource survives a reconcile tick unchanged |
| hibernator | never selects an `undeployed` resource |
| worker | `durableObjectUniqueKeyModifier` is assigned at creation, before any manifest exists |
| worker | it does not change across the first deploy |
| worker | a legacy flat worker row fails loudly rather than silently |
| wire | `manifest.vars` is redacted in its nested position |
| wire | a null manifest survives the round trip |
| http | an undeployed hostname answers 503 naming the deploy command |
| http | `allowHostname` is true for an undeployed resource |
| deploy | `undeployed` to deploy to `sleeping`, with the image populated |
| deploy | redeploying a running app keeps the same hostname and port |
| eject | an undeployed compute resource is skipped with a stated reason |
| cli | `hobby new --empty` creates a project with zero resources |

## Out of scope for A

- **Remote deploy** (laptop to VPS). The CLI talks to a unix socket
  (`packages/cli/src/cli/client.ts:41`), so it must run on the daemon's box.
  Sub-project C, and it needs its own ADR for putting the control plane on a
  network.
- **Studio and MCP surfacing the new kinds.** Sub-project D1. A only makes it
  possible.
- **Wiring Caddy.** Sub-project B. `createCaddyManager` still has no production
  caller.

## Decisions this spec makes that deserve an ADR

ADR 0013, to be written with the implementation: resource records exist before
code. It should state the reversal of the `app.ts:181-183` invariant, the removal
of the implied Postgres from a project, and the reasoning for `undeployed` as a
resting state rather than a derived condition.
