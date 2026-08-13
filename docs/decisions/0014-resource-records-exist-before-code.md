# 0014. Resource records exist before code

Status: ACCEPTED
Date:   2026-08-13

Extends `app` and `worker`, the two resource kinds ADR 0007 places in Phase 2
and ADR 0010 unblocks. Does not touch `postgres`. Sub-project A of five (A
record before code, B wire Caddy, D1 Studio and MCP for all kinds, D2 Studio
API tokens, C remote deploy); the full design is filed at
`docs/compute/specs/2026-08-13-record-before-code-design.md`.

## Context

### Creation and deploy were one indivisible operation

`POST /v1/projects/:name/resources` (`createResourceRoute`,
`packages/cli/src/daemon/routes.ts:217`) required a build source for `app` and
`worker`, built the image, and only committed the row once the container
proved it served. There was no such thing as a compute resource without code
already on disk.

That is not a browser limitation. It is why Studio could not create compute at
all: `packages/studio/src/api.ts:152` hardcodes `createResource` to send
`kind: 'postgres'`, because postgres was the only kind Studio's API client
could construct without a filesystem path to hand the daemon. `packages/mcp/src/tools.ts:116`
hardcodes the same thing in `newTool`, for the same reason. Neither surface can
name an `app` or a `worker` today, because the daemon offers no way to name one
without also building it, and neither a browser tab nor an MCP client has a
build context to send.

The fix is the model Fly and Cloudflare both use: creating a resource is a
control-plane act that produces a row, an id and a hostname. Deploying is a
separate act, run from a working directory, that puts code into that row.
`hobby deploy ./site --project blog` now resolves-or-creates the record and
then deploys, so the CLI's one-command ergonomic is unchanged; Studio and MCP
gain the ability to do the first half on their own, which is sub-project D1's
job, not this one's.

### The invariant this reverses

`packages/app/src/app.ts` carried this comment, now at lines 231 to 233, and
kept verbatim rather than deleted:

> The build happens BEFORE the resource row exists. A Dockerfile that does not
> compile should leave nothing behind at all: no row to clean up, no allocated
> name, nothing for the user to `hobby rm` before retrying.

That reasoning was correct for the model it was written against, where
creating and deploying were the same act: if the only way to get a row was to
build first, then a build failure had to leave nothing, because there was no
other legitimate reason for a codeless row to exist.

It is wrong for this model. Once a resource can be named in Studio and its
hostname published (`packages/proxy/src/http.ts`'s `allowHostname` needs that
hostname to exist before any code ships, so Caddy's on-demand TLS has
something to issue a certificate for), a failed build leaving the record
behind is the desired outcome. The user retries the deploy; they do not
recreate the app. The row surviving a failed build changes from litter into
information: it says exactly what a retry needs to know, the id, the name, the
hostname, and that the address is already live.

The replacement is recorded immediately above the old comment,
`packages/app/src/app.ts:192-201`, stating explicitly that it reverses the
invariant and why. Both invariants are readable in the file today: the old
reasoning was not deleted, because a reader has to be able to see that it was
considered and not merely forgotten.

### `undeployed` is a state, not a derived condition

`ResourceState` (`packages/core/src/types.ts:15-31`) gains `undeployed` as a
member, alongside `creating`, `running`, `sleeping` and the rest, rather than
being computed on the fly from `config.image === null`.

The alternative was considered and rejected. `state` is the field almost every
consumer in the codebase dispatches on directly: `hibernator.ts`'s `shouldSleep`
and `tick` both gate on `state !== 'running'` (`packages/cli/src/daemon/hibernator.ts:35`
and `:100`), `reconcile.ts` buckets observed container status against
`recorded` state, and `renderResourceLine`
(`packages/cli/src/cli/output.ts:44-45`) prints `resource.state` into `hobby
ls` output literally, with no other check. If a codeless resource were instead
stored with some existing state value, say `sleeping`, chosen because it is
the natural resting label for "nothing running right now," and "has code ever
been deployed" lived only in `config.image`, then every one of those direct
readers would need to remember to also check `config.image`, and any that
forgot would be wrong in a way nothing catches at compile time. `hobby ls`
printing `sleeping` for a resource that has never had a build and can never
wake, because the wedge's entire promise is that `sleeping` means "the next
request wakes it," is the concrete failure this rules out. A resource that
cannot wake must not carry the same label as one that can.

`reconcile.ts` makes the same argument from the other direction: `bucket ===
'missing'` maps unconditionally to `'failed'` at `correctedState`
(`packages/cli/src/daemon/reconcile.ts:137`, checked before the `sleeping`
carve-out at `:138`), so storing any existing resting state for a codeless
resource would still get relabelled `failed` on the daemon's very next tick,
regardless of which value was chosen. The thing every consumer dispatches on
must not lie, and the only way to make that true is for the state column
itself to say "no code has ever landed here," not a second field a caller has
to remember to cross-check.

### A project no longer implies a Postgres

`hobby new <name>` (`packages/cli/src/cli/commands.ts:405-451`) still creates
a project and a `primary` postgres resource in one call, and that stays
unchanged: it is the one-command ergonomic root `CLAUDE.md` sells as the whole
point of the product, and there is no reason to spend it. `hobby new <name>
--empty` (`commands.ts:420-430`) is the new door: a project and nothing else,
because a **project** is a namespace holding typed resources (root
`CLAUDE.md`'s Scope section), not a database with a name, and Studio and MCP
creating compute (D1) needs an empty project to create compute *into*.

The ergonomic default and the underlying model now disagree on purpose. `hobby
new` keeps assuming a Postgres because that assumption is worth more in the
common case than consistency with the model would be. `--empty` is the escape
hatch for the case where it is not.

### The no-migration decision

`WorkerConfig`'s shape changed (the manifest split, ADR-adjacent detail filed
in the spec, not repeated here), and `packages/core/src/store.ts:122` parses
every stored config with an unchecked cast, `JSON.parse(row.config) as
ResourceConfig`. A pre-existing flat worker row would arrive with `manifest:
undefined` and fail somewhere unhelpful, deep inside whatever function first
tried to read `manifest.source`.

No normaliser was written. `hobby ls` on the author's own box shows six
postgres resources and nothing else; both `app` and `worker` were three days
old and unreleased at the time this shipped. `packages/worker/src/assert-config.ts`'s
`assertWorkerConfig` (`:11-20`) instead asserts the shape on every read and
fails loudly:

> this worker row predates the manifest split and cannot be read

with a hint naming `hobby rm` and pointing out that no data is actually lost,
because a worker holds no state outside its Durable Object storage, which is
keyed on the resource id and unaffected by the config shape. This applies root
`CLAUDE.md`'s "prefer deleting a feature to deferring it" to a migration:
carrying a normaliser for rows that do not exist anywhere is cost with no
offsetting benefit.

**The condition that reverses this:** if a worker row is ever found on another
box, on a box this project does not control, running an older build, write the
normaliser then, against that real row and its actual shape, not against a
guess of what it might contain.

### `ResourceKindHandler.skipReconcile`

Added mid-branch, at the direct request of a parallel session building a
`queue` resource kind, whose own decision record asked that the exemption
`reconcile.ts` needed for `undeployed` be kept general rather than
per-kind, reasoning that two exemptions for one idea is how the mechanism
rots.

`ResourceKindHandler` (`packages/core/src/kinds.ts:89-102`) gained an optional
`skipReconcile?(resource): boolean`. Absent means "reconcile me normally."
`app` and `worker` both answer `resource.state === 'undeployed'`
(`packages/app/src/kind.ts:39-40`, `packages/worker/src/kind.ts:45-46`);
`postgres` declares nothing, since it never reaches `undeployed`. `reconcile.ts`
dispatches through the registry (`:239`) before it costs a single Docker round
trip (`ctx.runtime.inspect` at `:252`), rather than naming a state inline, so a
`queue` resource with no container in any state can answer `true`
unconditionally without a second branch being added beside this one.

The predicate answers one specific question: does reconcile have a container
to inspect for this resource at all. The hibernator asks a different question:
is calling `stop()` on this resource a meaningful sleep transition right now.
`hibernator.ts`'s `shouldSleep` and `tick` already answer that by gating on
`resource.state === 'running'` (`hibernator.ts:35`, `:100`), a check that
already excludes `undeployed` by construction, since `undeployed` is never
`running`. Reusing `skipReconcile` there would be dead code for `app` and
`worker`, because their `state !== 'running'` guard fires first and makes
`skipReconcile` unreachable, and it would be load-bearing only for a kind that
does not exist on this branch. A predicate that is inert for two of three
callers and essential only for the third is the same "one idea forced into an
unrelated shape" failure the exemption itself was written to prevent, one
level up. The hibernator gets its own predicate if and when a kind needs one,
coexisting with `guard?` and `skipReconcile?` as separate questions, not a
reused one.

## Decision

1. `ResourceState` gains `undeployed` as a real state, reachable only by `app`
   and `worker`.
2. The build-before-row invariant in `app.ts` is reversed and the reversal is
   recorded next to the original reasoning, not in place of it.
3. `hobby new` keeps its Postgres default; `--empty` is the new way to get a
   bare project.
4. No normaliser is written for pre-split worker rows. `assertWorkerConfig`
   fails loudly instead, reversible the day a real legacy row is found
   somewhere this project does not control.
5. `ResourceKindHandler.skipReconcile` is the one shared seam for "reconcile
   has nothing to inspect here," and the hibernator does not reuse it; sleep
   eligibility gets its own predicate per kind if one is ever needed.

## A subtlety worth preserving

`hobby eject`'s skip condition for an undeployed compute resource,
`isDeployed` (`packages/cli/src/daemon/routes.ts:418-419`), keys on
`resource.config.image !== null`, not on `resource.state === 'undeployed'`.
The two are **not** equivalent, and the difference is documented in the
comment directly above the function (`:404-417`):

`deployApp` writes the freshly built image into the stored config
(`packages/app/src/app.ts:462-463`) before the readiness check that can still
throw (`:469-477`). If that probe times out, the `catch` block
(`:488-490`) rolls `state` back to `undeployed` when the deploy was a first
deploy (the `wasUndeployed` flag captured at `:453`, before anything could
throw), but it does **not** clear `config.image` back to `null`. The result is
a resource that is `undeployed` in `state` while already holding a real,
renderable image from the build that produced the failure.

Keying the eject skip on `state === 'undeployed'` would wrongly drop that
resource from the compose file it is fully able to render into. Keying it on
`config.image === null`, as `isDeployed` does, correctly keeps it, because the
question eject actually needs answered is "is there an image to put in a
compose service," and that question has its own field. `state` answers "has
this resource ever finished a deploy," which is a related but different
question, and the two diverge in exactly this one window: a build that
succeeded followed by a readiness probe that did not.

## Consequences accepted

- **Two fields now jointly describe a compute resource's history**, `state`
  and `config.image`, and they are deliberately not collapsed into one,
  because the case above shows they answer different questions. Any future
  consumer of either has to know which question it is actually asking.
- **`ResourceState`'s dispatch sites are not exhaustively checked by the
  compiler.** `correctedState` (`reconcile.ts:134-139`) is an if/else chain
  with an unconditional final `return 'failed'`, so adding `undeployed` to the
  union produced zero compile errors on this branch, and a future
  `ResourceState` member will produce zero again. Nothing currently enforces
  that a new state gets handled everywhere it needs to be; this was found and
  is recorded rather than fixed, because fixing it is a refactor of
  `correctedState`'s shape and out of scope for this change.
- **Studio and MCP still cannot create compute** after this ADR alone.
  `packages/studio/src/api.ts:152` and `packages/mcp/src/tools.ts:116` are
  untouched by sub-project A; the daemon route they would call now supports an
  optional source, but neither client sends one yet. That is sub-project D1,
  named here so it is not mistaken for done.

## What would have to change to revisit

**If a legacy flat worker row is found on a real box**, write the normaliser
against that row, not speculatively now.

**If `correctedState`'s non-exhaustive shape causes a real incident**, a new
`ResourceState` member silently falling through to `failed`, convert it to an
exhaustive switch so the compiler becomes the safety net it currently is not.

**If a `queue` or other future kind needs sleep eligibility**, give it its own
named predicate rather than reusing `skipReconcile`, per the reasoning above.
Reusing it anyway, under time pressure, is the mistake this record exists to
prevent.
