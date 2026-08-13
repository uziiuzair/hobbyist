# Record Before Code Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Decouple compute resource creation from deploy, so an `app` or `worker`
exists as a row with an id, hostname and port before any code is uploaded.

**Architecture:** `ResourceState` gains a resting member `undeployed`.
`ResourceConfigBase.image` becomes nullable. `WorkerConfig`'s wrangler-derived
fields move into a nullable `manifest` sub-object, leaving
`durableObjectUniqueKeyModifier` above the split because it is derived from
`resource.id` at row creation. Creation routes accept a sourceless app or worker;
the existing deploy route becomes the transition out of `undeployed`.

**Tech Stack:** TypeScript, Node's built-in test runner (`node:test`,
`node:assert/strict`), compiled with `tsc --build` to `packages/*/dist`, run with
`npm test` from the repo root.

**Spec:** `docs/compute/specs/2026-08-13-record-before-code-design.md`

**Worktree:** `.claude/worktrees/record-before-code`, branch `record-before-code`,
based on `bff0459`. Baseline is 453 tests passing.

## Global Constraints

- **No em-dashes anywhere**, in code, comments, commit messages or output. Use
  commas, colons, parentheses, or restructure. Root `CLAUDE.md`.
- **`core` never imports Docker, Postgres or HTTP.** `packages/core/src/types.ts`
  is data only, no behaviour.
- **`durableObjectUniqueKeyModifier` is never regenerated.** It is derived once
  from `resource.id`. If it changes, every Durable Object sqlite file is orphaned
  and the user silently loses state. This is the sharpest data-loss edge in the
  codebase.
- **Ports bind loopback only.** `DEFAULT_PORT_BIND` in
  `packages/core/src/runtime.ts`, never `0.0.0.0`.
- **Existing 453 tests stay green** after every task. Run `npm test` from the
  repo root before every commit.
- **Test command for one file:** `npx tsc --build && node --test packages/<pkg>/dist/test/<name>.test.js`
- **Ground claims in code.** Comments cite `path/to/file.ts` with a symbol name.

---

### Task 1: The `undeployed` state, and reconcile's exemption

The smallest possible change that everything else depends on. Adding the state
alone would make the daemon mark every code-less resource `failed` on its next
tick, so the reconcile exemption ships in the same task: a reviewer cannot
sensibly approve one without the other.

**Files:**
- Modify: `packages/core/src/types.ts:15-22` (the `ResourceState` union)
- Modify: `packages/cli/src/daemon/reconcile.ts:221` (the per-resource loop)
- Test: `packages/cli/test/reconcile.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `ResourceState` now includes the literal `'undeployed'`. Every later
  task narrows against it.

- [ ] **Step 1: Write the failing test**

Append to `packages/cli/test/reconcile.test.ts`. Match the fixture style already
in that file: an in-memory store and a fake runtime, no Docker.

```ts
test('an undeployed resource survives a reconcile tick unchanged', async () => {
  // An app that has never been deployed has no container by definition.
  // Without an explicit exemption, correctedState() buckets that as
  // `missing` (reconcile.ts:137) and maps it to `failed`, so the daemon
  // would mark every code-less resource broken on its first tick.
  const ctx = await makeContext()
  const project = ctx.store.createProject({ name: 'blog', sleepAfterSeconds: null })
  const resource = ctx.store.createResource({
    projectId: project.id,
    kind: 'app',
    name: 'site',
    config: {
      image: null,
      containerName: 'hobby-blog-site',
      hostPort: 15500,
      containerPort: 8080,
      hostname: 'blog-site.hobby.local',
      source: null,
      env: {},
      databaseResourceId: null,
    },
  })
  ctx.store.setResourceState(resource.id, 'undeployed')

  await reconcile(ctx)

  assert.equal(ctx.store.getResource(resource.id)?.state, 'undeployed')
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsc --build && node --test packages/cli/dist/test/reconcile.test.js`
Expected: FAIL. Either a type error on `'undeployed'` not being assignable to
`ResourceState`, or, once the type lands, an assertion failure reading
`'failed' !== 'undeployed'`.

- [ ] **Step 3: Add the state**

In `packages/core/src/types.ts`, replace the `ResourceState` union:

```ts
export type ResourceState =
  | 'creating'
  | 'running'
  | 'starting'
  | 'sleeping'
  | 'stopping'
  | 'failed'
  | 'destroying'
  // A RESTING state, unlike every other member above except `running` and
  // `sleeping`. It means the row exists and no code has ever been uploaded
  // into it, which is the normal condition for an `app` or `worker` created
  // from Studio or MCP. Distinct from `creating`, which means a deploy is in
  // flight right now and which reconcile.ts:43 correctly marks `failed` when
  // no container appears. Here, having no container is expected, forever.
  // Unreachable for `postgres`: its image is a registry reference known at
  // creation, so it has nothing to deploy.
  | 'undeployed'
```

- [ ] **Step 4: Exempt it in reconcile**

In `packages/cli/src/daemon/reconcile.ts`, inside `for (const resource of ctx.store.listResources())`,
immediately after the existing `destroying` branch:

```ts
    if (resource.state === 'destroying') {
      await resumeDestroy(ctx, resource)
      continue
    }

    // Skipped whole, for the same structural reason `destroying` is above:
    // this resource's recorded state is not a claim about a container. An
    // undeployed app has never had one, so `inspect` reports missing, which
    // correctedState() buckets as `missing` and maps to `failed` (:137).
    // That would relabel every resource created from Studio as broken on the
    // daemon's first tick after it was created.
    if (resource.state === 'undeployed') {
      continue
    }
```

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: 454 passing, 0 failures. The new state is additive, so no existing
test should change behaviour. If `correctedState`'s exhaustiveness check fails
to compile, that is the compiler doing its job: add `undeployed` to the
`recorded` handling by returning it unchanged.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/types.ts packages/cli/src/daemon/reconcile.ts packages/cli/test/reconcile.test.ts
git commit -m "feat(core): a resource can exist before its code does

Adds `undeployed` to ResourceState as a resting member, not a transitional
one. The distinction is the whole point: `creating` means a deploy is in
flight and reconcile correctly marks it failed when no container appears,
while for `undeployed` having no container is the expected condition
indefinitely.

reconcile.ts gets the exemption in the same commit rather than a later one,
because without it correctedState() buckets 'no container observed' as
`missing` and maps that to `failed`, so the daemon would relabel every
code-less resource broken on its next tick."
```

---

### Task 2: A resource can have no image

**Files:**
- Modify: `packages/core/src/types.ts:46-53` (`ResourceConfigBase`)
- Modify: whatever the compiler flags. Expected: `packages/cli/src/daemon/reconcile.ts`,
  `packages/core/src/docker.ts`, `packages/app/src/app.ts`, `packages/worker/src/worker.ts`
- Test: `packages/core/test/types.test.ts` (create if absent)

**Interfaces:**
- Consumes: Task 1's `'undeployed'`.
- Produces: `ResourceConfigBase.image` is `string | null`. Any code path that
  starts a container must narrow it first.

- [ ] **Step 1: Write the failing test**

Create or append to `packages/core/test/types.test.ts`:

```ts
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { AppConfig } from '../src/index.js'

test('an app config can carry no image, which is what an undeployed record is', () => {
  // Not a runtime assertion so much as a compile-time one: this object
  // literal failing to typecheck is the failure this test exists to catch.
  const config: AppConfig = {
    image: null,
    containerName: 'hobby-blog-site',
    hostPort: 15500,
    containerPort: 8080,
    hostname: 'blog-site.hobby.local',
    source: null,
    env: {},
    databaseResourceId: null,
  }
  assert.equal(config.image, null)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsc --build && node --test packages/core/dist/test/types.test.js`
Expected: FAIL at compile: `Type 'null' is not assignable to type 'string'`.

- [ ] **Step 3: Widen the type**

In `packages/core/src/types.ts`, in `ResourceConfigBase`:

```ts
export interface ResourceConfigBase {
  // Null until a first deploy has produced one. A postgres resource always
  // has an image (a registry reference chosen at creation), so in practice
  // this is null only for an `app` or `worker` in state `undeployed`. Every
  // path that starts a container runs from `running` or `sleeping` and must
  // narrow this first: the compiler is the mechanism that finds them, which
  // is the same technique commit abe7582 used to find every place Phase 1
  // assumed postgres.
  image: string | null
  containerName: string
  // Always on loopback, never 0.0.0.0. See DEFAULT_PORT_BIND in runtime.ts
  // for why the bind address, not a host firewall, is the thing that keeps
  // a resource off the network.
  hostPort: number
}
```

- [ ] **Step 4: Follow the compiler**

Run: `npx tsc --build`

Fix each error by narrowing, never by casting. At each container-creating site
the correct shape is a thrown error, because reaching it with a null image is a
daemon bug rather than a user mistake:

```ts
if (config.image === null) {
  throw new HobbyError(
    'internal',
    `resource ${resource.name} has no image, so there is nothing to start`,
    'this is a bug: a resource with no image should be in state undeployed and should never reach a start path'
  )
}
```

Do NOT add `image: null` handling to `allocatePort` or any path that only reads
`containerName` or `hostPort`. Those are why `ResourceConfigBase` exists.

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: 455 passing, 0 failures.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(core): an image is something a deploy produces, not something a record has

ResourceConfigBase.image becomes string | null. A record created before its
code has no image to record, and the compiler is what finds every path that
assumed otherwise, exactly as widening ResourceKind did in abe7582.

Every site it found starts a container, and every one of them now throws
`internal` rather than narrowing quietly: reaching a start path with no image
means the resource should have been `undeployed` and something upstream is
wrong, which is worth a loud failure rather than a confusing Docker error."
```

---

### Task 3: The worker manifest split

The largest type change, and the one that touches Durable Object storage
identity. Read the constraint in this plan's Global Constraints before starting.

**Files:**
- Modify: `packages/core/src/types.ts:86-110` (`WorkerConfig`)
- Modify: `packages/worker/src/worker.ts:304-333` (`createWorkerResource`)
- Modify: `packages/worker/src/kind.ts`, `packages/worker/src/runtime-image.ts`
  (compiler will flag the exact lines)
- Modify: `packages/do/src/catalog.ts` if it reads `config.durableObjects`
- Test: `packages/worker/test/worker.test.ts`, `packages/worker/test/unique-key-stability.test.ts`

**Interfaces:**
- Consumes: Task 2's nullable `image`.
- Produces: `WorkerConfig.manifest` is `WorkerManifest | null`, where
  `WorkerManifest` is exported from `@hobby.sh/core`.
  `WorkerConfig.durableObjectUniqueKeyModifier` stays at the top level and keeps
  its exact current type, `string`.

- [ ] **Step 1: Write the failing tests**

Append to `packages/worker/test/unique-key-stability.test.ts`:

```ts
test('the durable object unique key is assigned at creation, before any manifest exists', () => {
  // The whole reason the modifier sits ABOVE the manifest split: it is
  // derived from resource.id, which the store assigns when the row is
  // created, so it is knowable before there is a wrangler.toml to read.
  // A worker created from Studio has a stable Durable Object identity
  // before it has seen a line of code.
  const config: WorkerConfig = {
    image: null,
    containerName: 'hobby-blog-cron',
    hostPort: 15501,
    containerPort: 8787,
    hostname: 'blog-cron.hobby.local',
    durableObjectUniqueKeyModifier: 'res-abc-123',
    manifest: null,
    databaseResourceId: null,
  }
  assert.equal(config.manifest, null)
  assert.equal(config.durableObjectUniqueKeyModifier, 'res-abc-123')
})

test('a worker row that predates the manifest split fails loudly, not silently', () => {
  // store.ts:122 parses the config column with an unchecked cast, so a
  // legacy flat row would arrive with manifest: undefined and fail
  // somewhere unhelpful and far away. There are zero worker rows in
  // existence (see the spec's "Migration: none, deliberately"), so this
  // asserts rather than migrates.
  const legacy = {
    image: 'hobby-blog-cron:123',
    containerName: 'hobby-blog-cron',
    hostPort: 15501,
    containerPort: 8787,
    hostname: 'blog-cron.hobby.local',
    compatibilityDate: '2026-07-30',
    durableObjectUniqueKeyModifier: 'res-abc-123',
    databaseResourceId: null,
  } as unknown as WorkerConfig

  assert.throws(() => assertWorkerConfig(legacy), /predates the manifest split/)
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx tsc --build && node --test packages/worker/dist/test/unique-key-stability.test.js`
Expected: FAIL at compile on the unknown property `manifest` and the unresolved
import `assertWorkerConfig`.

- [ ] **Step 3: Split the type**

In `packages/core/src/types.ts`, replace `WorkerConfig`:

```ts
// Everything read out of the user's wrangler manifest. Null until a first
// deploy, because none of it can be known before there is a file to read.
// Split out of WorkerConfig rather than left inline so that the boundary
// between "derived at record creation" and "read from the user's code" is
// structural instead of a comment someone has to notice and honour.
export interface WorkerManifest {
  source: { path: string; manifest: string }
  compatibilityDate: string
  compatibilityFlags: string[]
  vars: Record<string, string>
  kvNamespaces: string[]
  r2Buckets: string[]
  d1Databases: string[]
  queues: { producers: string[]; consumers: string[] }
  durableObjects: Array<{ binding: string; className: string }>
}

// A Cloudflare Worker, running on Cloudflare's own runtime. See ADR 0011:
// this is workerd, driven by the miniflare npm package, in a container we
// build, one process per worker resource.
export interface WorkerConfig extends ResourceConfigBase {
  // Ours, not the user's: the port we tell Miniflare to listen on. Known at
  // creation, unlike an app's containerPort, which is whatever the user's
  // process happens to bind and is unknowable before there is code.
  containerPort: number
  hostname: string
  databaseResourceId: ResourceId | null

  // workerd derives every Durable Object's storage identity from this. If
  // it ever changes, every object's sqlite file is orphaned and the user
  // silently loses state on a redeploy, which is the sharpest data-loss
  // edge in the whole kind. So it is DERIVED, once, from the resource's own
  // id (the randomUUID the store assigns in createResource, which survives
  // rename, redeploy, daemon restart and eject/adopt), and never
  // regenerated. Never derive it from the project or class name: both are
  // user-facing strings a rename would change.
  //
  // It sits above the manifest split because it exists before any code
  // does. A worker created from Studio has a stable object identity from
  // the moment the row exists, which is strictly better than deriving it in
  // the same breath as a first build.
  durableObjectUniqueKeyModifier: string

  manifest: WorkerManifest | null
}
```

Export `WorkerManifest` from `packages/core/src/index.ts` alongside `WorkerConfig`.

- [ ] **Step 4: Add the legacy-row assertion**

Create `packages/worker/src/assert-config.ts`:

```ts
// One guard, called wherever a stored worker config is read back out of the
// store. See the spec's "Migration: none, deliberately": there are zero
// worker rows in existence, both kinds are days old and unreleased, so a
// normaliser would be carried for rows that do not exist. A loud failure is
// the honest alternative to a silent `undefined`, because store.ts:122
// parses the config column with an unchecked cast and would otherwise let a
// legacy row travel a long way before breaking.

import { HobbyError, type WorkerConfig } from '@hobby.sh/core'

export function assertWorkerConfig(config: WorkerConfig): WorkerConfig {
  if (!('manifest' in config)) {
    throw new HobbyError(
      'internal',
      'this worker row predates the manifest split and cannot be read',
      'delete it with `hobby rm <project>/<name>` and redeploy. No data is lost: a worker holds no state outside its Durable Object storage, which is keyed on the resource id and is not affected.'
    )
  }
  return config
}
```

Export it from `packages/worker/src/index.ts`.

- [ ] **Step 5: Rewrite `createWorkerResource`**

In `packages/worker/src/worker.ts`, replace the config literal at `:304-323`.
Note that the existing two-step write (placeholder `''` then
`updateResourceConfig`) stays, because the modifier still cannot be known until
the store has assigned the id:

```ts
  const config: WorkerConfig = {
    image: tag,
    containerName,
    hostPort,
    containerPort: CONTAINER_PORT,
    hostname: workerHostname(opts.project.name, opts.name, deps.config.domain),
    // Placeholder until the row exists: the real value is derived from the
    // resource id, which the store assigns. Rewritten immediately below.
    durableObjectUniqueKeyModifier: '',
    databaseResourceId: opts.databaseResourceId,
    manifest: {
      source: { path: opts.sourcePath, manifest: found.file },
      compatibilityDate: manifest.compatibilityDate,
      compatibilityFlags: manifest.compatibilityFlags,
      vars: manifest.vars,
      kvNamespaces: manifest.kvNamespaces,
      r2Buckets: manifest.r2Buckets,
      d1Databases: manifest.d1Databases,
      queues: manifest.queues,
      durableObjects: manifest.durableObjects,
    },
  }
```

- [ ] **Step 6: Follow the compiler through the worker package and `@hobby.sh/do`**

Run: `npx tsc --build`

Every read of `config.vars`, `config.compatibilityDate`, `config.durableObjects`
and friends becomes `config.manifest?.<field>` or a narrowed
`if (config.manifest === null) throw ...`. In `packages/do/src/catalog.ts`, a
worker with a null manifest declares no Durable Objects, so it contributes
nothing to the catalog rather than throwing.

- [ ] **Step 7: Run the full suite**

Run: `npm test`
Expected: 457 passing, 0 failures. Pay particular attention to
`unique-key-stability.test.ts`: if "a redeploy does not change the durable
object unique key" fails, stop and do not proceed. That test guards the
data-loss edge.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat(worker): separate what a record knows from what its code says

WorkerConfig's wrangler-derived fields move into a nullable \`manifest\`
sub-object. Everything inside it is read out of the user's wrangler.toml and
cannot exist before a first deploy; everything left above it is known when
the row is created.

durableObjectUniqueKeyModifier deliberately stays above the split. It is
derived from resource.id, so it exists before any code does, and a worker
created from Studio now has a stable Durable Object identity from the moment
its row exists rather than from its first build. That was previously true by
accident and is now true by shape.

No migration, per the spec: zero worker rows exist anywhere, so a legacy flat
row asserts loudly rather than being normalised for a case that does not
occur."
```

---

### Task 4: Creating a compute resource without code

**Files:**
- Modify: `packages/cli/src/daemon/routes.ts:217-280` (`createResourceRoute`)
- Modify: `packages/app/src/app.ts:167-210` (`createAppResource`)
- Modify: `packages/worker/src/worker.ts:278-300` (`createWorkerResource`)
- Test: `packages/cli/test/kind-dispatch.test.ts`

**Interfaces:**
- Consumes: Tasks 1, 2, 3.
- Produces: `createAppResource` and `createWorkerResource` accept
  `source: null`. With a null source they allocate `hostPort` and `hostname`,
  write the row in state `undeployed`, and perform no build, no container and no
  probe.

- [ ] **Step 1: Write the failing test**

Append to `packages/cli/test/kind-dispatch.test.ts`:

```ts
test('an app created without a source is undeployed, has a hostname, and has no image', async () => {
  const ctx = await makeContext()
  ctx.store.createProject({ name: 'blog', sleepAfterSeconds: null })

  const resource = await createResourceRoute(ctx, jsonRequest({ kind: 'app', name: 'site' }), 'blog')

  assert.equal(resource.kind, 'app')
  assert.equal(resource.state, 'undeployed')
  assert.equal(resource.config.image, null)
  // The hostname is allocated now, not at deploy, so Studio can show the URL
  // before there is anything behind it and Caddy can be asked for a
  // certificate for it. See the spec's "Allocated at creation".
  assert.equal(resource.config.hostname, 'blog-site.hobby.local')
  assert.ok(resource.config.hostPort > 0)
})

test('creating an app without a source builds nothing and starts nothing', async () => {
  const ctx = await makeContext()
  ctx.store.createProject({ name: 'blog', sleepAfterSeconds: null })

  await createResourceRoute(ctx, jsonRequest({ kind: 'app', name: 'site' }), 'blog')

  // The fake runtime records every call. A record is a row, not a container.
  assert.deepEqual(ctx.runtime.calls.filter((c) => c.startsWith('build')), [])
  assert.deepEqual(ctx.runtime.calls.filter((c) => c.startsWith('create')), [])
  assert.deepEqual(ctx.runtime.calls.filter((c) => c.startsWith('start')), [])
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx tsc --build && node --test packages/cli/dist/test/kind-dispatch.test.js`
Expected: FAIL with the existing usage error, "an app needs either a build source
or a prebuilt image, and not both" (`app.ts:170-174`).

- [ ] **Step 3: Allow a sourceless app**

In `packages/app/src/app.ts`, replace the guard at `:169-175` and the build block
at `:184-191`:

```ts
  // Three valid shapes now, not two. A record with neither a source nor an
  // image is the Fly and Cloudflare model: the row, its id and its hostname
  // exist first, and code arrives later through deploy. What is still
  // refused is BOTH, which remains genuinely ambiguous.
  if (opts.source !== null && opts.image !== null) {
    throw new HobbyError(
      'usage',
      'an app takes either a build source or a prebuilt image, not both',
      'pass a directory containing a Dockerfile, or an image reference, or neither to create the record and deploy into it later'
    )
  }

  const now = deps.now ?? Date.now
  const hostPort = deps.store.allocatePort(PORT_RANGE_FROM, PORT_RANGE_TO)
  const containerName = `hobby-${opts.project.name}-${opts.name}`

  // A record with no code: allocate its identity, write the row, do nothing
  // else. No build, no container, no probe, nothing to roll back.
  //
  // This deliberately reverses the invariant this function used to state,
  // that a build happens before the row exists so a broken Dockerfile leaves
  // nothing behind. That was right when creating and deploying were one act.
  // Now that a name and a hostname are published before any build, a failed
  // build leaving the record behind is the desired outcome: the user retries
  // the deploy, they do not recreate the app. See the spec's "The invariant
  // this reverses".
  if (opts.source === null && opts.image === null) {
    const config: AppConfig = {
      image: null,
      containerName,
      hostPort,
      containerPort: opts.containerPort,
      hostname: appHostname(opts.project.name, opts.name, deps.config.domain),
      source: null,
      env: opts.env,
      databaseResourceId: opts.databaseResourceId,
    }
    const created = deps.store.createResource({
      projectId: opts.project.id,
      kind: 'app',
      name: opts.name,
      config,
    })
    deps.store.setResourceState(created.id, 'undeployed')
    return { ...created, kind: 'app', config } as AppResource
  }

  let image = opts.image
  if (opts.source !== null) {
    const built = await buildAppImage(deps.runtime, {
      source: opts.source,
      tag: buildTag(opts.project.name, opts.name, now()),
    })
    image = built.tag
  }
```

- [ ] **Step 4: Allow a sourceless worker**

In `packages/worker/src/worker.ts`, make `opts.sourcePath` nullable and add the
same early return before the manifest read at `:288`:

```ts
  const hostPort = deps.store.allocatePort(PORT_RANGE_FROM, PORT_RANGE_TO)
  const containerName = `hobby-${opts.project.name}-${opts.name}`

  // Same shape as createAppResource's: identity now, code later. The
  // modifier is still written in two steps, because it is derived from the
  // id the store assigns, but there is no build between them any more.
  if (opts.sourcePath === null) {
    const config: WorkerConfig = {
      image: null,
      containerName,
      hostPort,
      containerPort: CONTAINER_PORT,
      hostname: workerHostname(opts.project.name, opts.name, deps.config.domain),
      durableObjectUniqueKeyModifier: '',
      databaseResourceId: opts.databaseResourceId,
      manifest: null,
    }
    const created = deps.store.createResource({
      projectId: opts.project.id,
      kind: 'worker',
      name: opts.name,
      config,
    })
    const withKey: WorkerConfig = { ...config, durableObjectUniqueKeyModifier: created.id }
    deps.store.updateResourceConfig(created.id, withKey)
    deps.store.setResourceState(created.id, 'undeployed')
    return {
      resource: { ...created, kind: 'worker', config: withKey } as WorkerResource,
      ignored: [],
    }
  }
```

- [ ] **Step 5: Make `source` optional at the route**

In `packages/cli/src/daemon/routes.ts`, in `createResourceRoute`, delete the
worker branch's null-source rejection at `:255-262` and update the usage hint on
the `name` error at `:228`:

```ts
      'POST /v1/projects/:name/resources expects { "kind": "postgres" | "app" | "worker", "name": string }'
```

- [ ] **Step 6: Run the full suite**

Run: `npm test`
Expected: 459 passing, 0 failures.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(compute): a project can hold an app or worker that has no code yet

Creating a compute resource stops requiring the code it will eventually run.
Given a kind and a name and nothing else, the daemon allocates the port and
the hostname, writes the row in state \`undeployed\`, and builds nothing.

This is what Studio and MCP were missing. They could not create compute
because there was no such thing as a compute resource without a directory on
disk, which is a model limitation rather than a browser one.

It reverses app.ts's stated invariant that a build precedes the row so a
broken Dockerfile leaves nothing behind. Once a name and hostname are
published before any build, a failed build leaving the record is correct:
the user retries the deploy rather than recreating the app."
```

---

### Task 5: Deploy is the transition out of `undeployed`

**Files:**
- Modify: `packages/cli/src/daemon/routes.ts` (`deployResourceRoute`)
- Modify: `packages/app/src/app.ts` (`deployApp`)
- Modify: `packages/worker/src/worker.ts` (add `deployWorker`)
- Test: `packages/cli/test/kind-dispatch.test.ts`

**Interfaces:**
- Consumes: Task 4.
- Produces: `deployApp(ctx, resource, { source })` and
  `deployWorker(ctx, resource, { sourcePath })` both accept a resource in state
  `undeployed`, and both return it to `undeployed` if the build or the readiness
  probe fails and the resource had no prior image.

- [ ] **Step 1: Write the failing tests**

```ts
test('deploying an undeployed app populates its image and leaves it sleeping', async () => {
  const ctx = await makeContext()
  ctx.store.createProject({ name: 'blog', sleepAfterSeconds: null })
  const created = await createResourceRoute(ctx, jsonRequest({ kind: 'app', name: 'site' }), 'blog')

  await deployResourceRoute(ctx, jsonRequest({ source: { path: FIXTURE_DIR } }), created.id)

  const after = ctx.store.getResource(created.id)
  assert.equal(after?.state, 'sleeping')
  assert.notEqual(after?.config.image, null)
  // The identity allocated at creation survives the deploy. A hostname that
  // changed on first deploy would invalidate anything the user had already
  // written down or pointed DNS at.
  assert.equal(after?.config.hostname, created.config.hostname)
  assert.equal(after?.config.hostPort, created.config.hostPort)
})

test('a failed first deploy returns the resource to undeployed, not failed', async () => {
  // `failed` means "there is code here and it broke". `undeployed` means
  // "there is no code here". Collapsing the two leaves Studio unable to say
  // which command fixes it, which is the whole reason the state exists.
  const ctx = await makeContext({ buildFails: true })
  ctx.store.createProject({ name: 'blog', sleepAfterSeconds: null })
  const created = await createResourceRoute(ctx, jsonRequest({ kind: 'app', name: 'site' }), 'blog')

  await assert.rejects(() =>
    deployResourceRoute(ctx, jsonRequest({ source: { path: FIXTURE_DIR } }), created.id)
  )

  assert.equal(ctx.store.getResource(created.id)?.state, 'undeployed')
})

test('a failed redeploy of a working app leaves it failed, because it does have code', async () => {
  const ctx = await makeContext()
  ctx.store.createProject({ name: 'blog', sleepAfterSeconds: null })
  const created = await createResourceRoute(ctx, jsonRequest({ kind: 'app', name: 'site' }), 'blog')
  await deployResourceRoute(ctx, jsonRequest({ source: { path: FIXTURE_DIR } }), created.id)

  ctx.runtime.failNextBuild()
  await assert.rejects(() =>
    deployResourceRoute(ctx, jsonRequest({ source: { path: FIXTURE_DIR } }), created.id)
  )

  assert.notEqual(ctx.store.getResource(created.id)?.state, 'undeployed')
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx tsc --build && node --test packages/cli/dist/test/kind-dispatch.test.js`
Expected: FAIL. `deployResourceRoute` currently refuses a worker with no prior
source, and nothing returns a resource to `undeployed`.

- [ ] **Step 3: Implement the rollback rule**

Wrap the deploy body in both kinds. The rule is: restore the state the resource
was in before the deploy started, but only when it had no image to fall back on.

```ts
  // A first deploy that fails must not leave the resource looking broken,
  // because it is not: it is exactly as it was, a record with no code. Only
  // a resource that already HAD an image can meaningfully be `failed`.
  const wasUndeployed = resource.state === 'undeployed'
  try {
    // ... existing build, container, probe
  } catch (err) {
    deps.store.setResourceState(resource.id, wasUndeployed ? 'undeployed' : 'failed')
    throw err
  }
```

- [ ] **Step 4: Add `deployWorker`**

Mirror `deployApp`. It reads the manifest from the new source, writes
`config.manifest`, rebuilds the image, and MUST carry
`durableObjectUniqueKeyModifier` through unchanged from the existing config:

```ts
  const next: WorkerConfig = {
    ...resource.config,
    image: tag,
    // Carried through explicitly rather than by spread alone, so that a
    // future edit to this object cannot silently drop it. Regenerating it
    // orphans every Durable Object sqlite file this worker owns.
    durableObjectUniqueKeyModifier: resource.config.durableObjectUniqueKeyModifier,
    manifest: {
      source: { path: sourcePath, manifest: found.file },
      compatibilityDate: manifest.compatibilityDate,
      compatibilityFlags: manifest.compatibilityFlags,
      vars: manifest.vars,
      kvNamespaces: manifest.kvNamespaces,
      r2Buckets: manifest.r2Buckets,
      d1Databases: manifest.d1Databases,
      queues: manifest.queues,
      durableObjects: manifest.durableObjects,
    },
  }
```

- [ ] **Step 5: Refuse a deploy with nothing to deploy**

In `deployResourceRoute`, when the body has no source and the resource has no
recorded one:

```ts
  if (source === null && resource.config.source === null) {
    throw new HobbyError(
      'usage',
      `${resource.name} has never been deployed, so this deploy needs a directory to build from`,
      `run \`hobby deploy <path> --project ${project.name} --name ${resource.name}\` from the directory holding its Dockerfile`
    )
  }
```

- [ ] **Step 6: Run the full suite**

Run: `npm test`
Expected: 462 passing, 0 failures.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(compute): deploy is the transition out of undeployed

One route now serves both doors: the CLI that creates and deploys in one
call, and Studio or MCP that created the record earlier. A deploy behaves
identically whether the resource had code before or not, which is what keeps
the two paths from drifting.

A failed FIRST deploy returns the resource to \`undeployed\` rather than
\`failed\`, because the two mean different things and only one of them is
true: \`failed\` is 'there is code here and it broke', \`undeployed\` is
'there is no code here'. A failed REDEPLOY still reads \`failed\`, because
that resource does have code.

deployWorker carries durableObjectUniqueKeyModifier through explicitly rather
than relying on a spread, so a later edit to that object cannot silently
orphan every Durable Object sqlite file the worker owns."
```

---

### Task 6: Redaction reaches into the manifest

**Files:**
- Modify: `packages/cli/src/daemon/wire.ts:89-100` (`redactConfig`)
- Test: `packages/cli/test/wire.test.ts`

**Interfaces:**
- Consumes: Task 3's `WorkerConfig.manifest`.
- Produces: no new exports. Behaviour only.

- [ ] **Step 1: Write the failing tests**

```ts
test('a worker var is redacted in its nested position', async () => {
  // Moving `vars` inside `manifest` moves the thing redactConfig was
  // reaching for. If this line is not updated, redaction silently stops
  // working while the code still compiles, reintroducing exactly the leak
  // abe7582 closed. This payload reaches --json output, shell history, CI
  // logs and agent transcripts.
  const wire = await toWireResource(ctx, workerWith({ vars: { API_KEY: 'sk-live-secret' } }))

  assert.equal(wire.config.manifest?.vars['API_KEY'], '<redacted>')
  assert.ok(!JSON.stringify(wire).includes('sk-live-secret'))
})

test('a worker with no manifest survives the wire round trip', async () => {
  const wire = await toWireResource(ctx, undeployedWorker())
  assert.equal(wire.config.manifest, null)
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx tsc --build && node --test packages/cli/dist/test/wire.test.js`
Expected: FAIL. The first shows `sk-live-secret` surviving into the payload.

- [ ] **Step 3: Reach one level deeper**

In `packages/cli/src/daemon/wire.ts`:

```ts
  const worker = config as WorkerConfig
  // One level deeper than it used to be, because `vars` moved inside
  // `manifest` in the record-before-code change. A null manifest has no
  // vars to redact and is passed through as null rather than fabricated.
  return {
    ...worker,
    manifest: worker.manifest === null ? null : { ...worker.manifest, vars: redactValues(worker.manifest.vars) },
  }
```

- [ ] **Step 4: Run the full suite**

Run: `npm test`
Expected: 464 passing, 0 failures.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "fix(wire): follow the secret when it moved

\`vars\` moved inside \`manifest\`, and redactConfig was still reaching for
it at the top level. That fails silently: the code compiles, the payload
looks right, and the user's third-party API keys travel into --json output,
shell history and CI logs.

The test asserts on the nested position specifically, and also asserts the
secret does not appear anywhere in the serialised payload, so the next time
this field moves the test fails rather than the redaction."
```

---

### Task 7: An undeployed hostname explains itself

**Files:**
- Modify: `packages/cli/src/daemon/context.ts:261-300` (`createHttpProxyDeps.resolve`)
- Test: `packages/cli/test/http-routing.test.ts`

**Interfaces:**
- Consumes: Task 4.
- Produces: no new exports. `resolve()` throws `HobbyError('conflict', ...)` for
  an undeployed resource, which the router already renders as 503.

- [ ] **Step 1: Write the failing tests**

```ts
test('an undeployed hostname answers 503 naming the command that fixes it', async () => {
  // Deliberately a throw from resolve(), not a failure in wake(). A wake
  // failure is bucketed as `timeout` and rendered 504 (http.ts:186-188),
  // which would tell the user their app was slow. A resolve() throw is
  // bucketed `refused` and rendered 503 with the message (:172-174), which
  // is the same path a released project already uses.
  const res = await get('blog-site.hobby.local')

  assert.equal(res.status, 503)
  assert.match(res.body, /has no code deployed yet/)
  assert.match(res.body, /hobby deploy/)
})

test('an undeployed hostname is still allowed a certificate', async () => {
  // allowHostname wraps resolve() in a try and returns true on throw
  // (context.ts:309-315), deliberately, so a released project still gets a
  // cert for a name that genuinely belongs to this box. An undeployed
  // resource inherits that, and it matters: without it, a user's first
  // deploy is also their first TLS handshake and two things fail together.
  assert.equal(await deps.allowHostname('blog-site.hobby.local'), true)
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx tsc --build && node --test packages/cli/dist/test/http-routing.test.js`
Expected: FAIL. The first returns 504 with a wake timeout message.

- [ ] **Step 3: Throw from `resolve`**

In `packages/cli/src/daemon/context.ts`, in `createHttpProxyDeps.resolve`, after
the kind check at `:289-291`:

```ts
    // Thrown, not returned as null, and the distinction is the whole
    // behaviour. Returning null renders 404 "nothing is deployed at this
    // hostname", which is wrong: something IS here, it was created
    // deliberately and it owns this name. Throwing renders 503 with this
    // message (http.ts:172-174), the same path a released project uses, and
    // it leaves allowHostname's catch free to still issue a certificate.
    if (resource.state === 'undeployed') {
      throw new HobbyError(
        'conflict',
        `${hostname} has no code deployed yet`,
        `run \`hobby deploy <path> --project ${parsed.project} --name ${parsed.resource}\` from the directory holding its code`
      )
    }
```

- [ ] **Step 4: Confirm the 503 body carries the hint**

`resolveAndWake` uses `err.message` only (`http.ts:173`). Check whether
`HobbyError`'s `message` includes the hint; if it does not, the router's
`refused` branch must render both. Adjust the test's second assertion to match
whichever is true, but the user MUST see the command.

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: 466 passing, 0 failures.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(proxy): a hostname with no code says so, and says what to run

An undeployed resource now throws from resolve() rather than returning null.
Returning null renders 404 'nothing is deployed at this hostname', which is
false: something is here, it was created deliberately, and it owns the name.

Throwing reuses the released-project path exactly, so this adds no branch to
the router: 503 with the reason, and the command that fixes it.

It also makes on-demand TLS correct for free. allowHostname already swallows
a resolve() throw and returns true, so a hostname can be issued a certificate
before its code ships. Without that, a user's first deploy would also be
their first TLS handshake and both would fail at once."
```

---

### Task 8: Eject skips what it cannot render

**Files:**
- Modify: `packages/cli/src/daemon/routes.ts:398-440` (`renderCompose`)
- Test: `packages/cli/test/eject-compute.test.ts`

**Interfaces:**
- Consumes: Task 4.
- Produces: no new exports.

- [ ] **Step 1: Write the failing test**

```ts
test('an undeployed compute resource is skipped, with a reason', async () => {
  // Eject's contract is that the emitted file stands on its own. A service
  // with no image cannot start, so emitting one would hand the departing
  // user a file that lies about being able to run. Silence would be worse:
  // it reads as "hobby exported everything" when it did not.
  const result = await ejectRoute(ctx, 'blog')

  assert.ok(!result.compose.includes('site:'))
  assert.match(result.skipped.join('\n'), /site: never deployed, so there is no image to run/)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsc --build && node --test packages/cli/dist/test/eject-compute.test.js`
Expected: FAIL, with a compose file containing `image: null`.

- [ ] **Step 3: Skip and report**

In `renderCompose`, before rendering each app or worker service:

```ts
    if (resource.config.image === null) {
      skipped.push(`${resource.name}: never deployed, so there is no image to run`)
      continue
    }
```

- [ ] **Step 4: Run the full suite**

Run: `npm test`
Expected: 467 passing, 0 failures.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "fix(eject): skip a resource with no image, and say so

A never-deployed app has no image, and a compose service with no image
cannot start. Emitting one would hand the departing user a file that lies
about standing on its own, which is the one promise eject exists to keep.

Reported rather than dropped, reusing the skip-reporting abe7582 added:
silence here reads as 'hobby exported everything' at exactly the moment the
user has stopped being able to ask."
```

---

### Task 9: The CLI catches up

**Files:**
- Modify: `packages/cli/src/cli/commands.ts` (`newCommand`, `deployCommand`,
  `pgCreateCommand`, `lsCommand`)
- Modify: `packages/cli/src/cli/main.ts` (register `create`)
- Test: `packages/cli/test/parse.test.ts`, `packages/cli/test/commands.test.ts`

**Interfaces:**
- Consumes: Tasks 4 and 5.
- Produces: `hobby create <kind> <name> --project <p>`,
  `hobby new <name> --empty`, `hobby deploy [path] --project <p> [--name n]`.

- [ ] **Step 1: Write the failing tests**

```ts
test('hobby new --empty creates a project with zero resources', async () => {
  const c = fakeContext()
  await newCommand(c, ['blog', '--empty'])

  assert.equal(c.api.createProjectCalls.length, 1)
  assert.equal(c.api.createResourceCalls.length, 0)
  assert.match(c.io.stdout, /no resources yet/)
})

test('hobby new without --empty still creates a postgres, unchanged', async () => {
  const c = fakeContext()
  await newCommand(c, ['blog'])

  assert.deepEqual(c.api.createResourceCalls[0]?.body, { kind: 'postgres', name: 'primary' })
})

test('hobby deploy takes one positional path and reads the name from it', async () => {
  // Two optional positionals cannot be disambiguated, so the name is a flag
  // with a derived default. `hobby deploy ./site` targets a resource called
  // `site`, which is the Fly and Wrangler ergonomic.
  assert.deepEqual(parseDeploy(['./site', '--project', 'blog']), {
    path: './site',
    project: 'blog',
    name: 'site',
  })
  assert.deepEqual(parseDeploy(['./site', '--project', 'blog', '--name', 'web']), {
    path: './site',
    project: 'blog',
    name: 'web',
  })
  assert.deepEqual(parseDeploy(['--project', 'blog']), { path: '.', project: 'blog', name: undefined })
})

test('hobby create makes a record and no container', async () => {
  const c = fakeContext()
  await createCommand(c, ['app', 'site', '--project', 'blog'])

  assert.deepEqual(c.api.createResourceCalls[0]?.body, { kind: 'app', name: 'site' })
})

test('deploying onto a name held by another kind refuses rather than replacing', async () => {
  const c = fakeContext({ existing: [{ name: 'site', kind: 'postgres' }] })
  await assert.rejects(() => deployCommand(c, ['./site', '--project', 'blog']), /is a postgres/)
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx tsc --build && node --test packages/cli/dist/test/commands.test.js`
Expected: FAIL. `--empty`, `createCommand` and `parseDeploy` do not exist.

- [ ] **Step 3: Implement `--empty`**

In `newCommand`, guard the postgres creation and change the closing output:

```ts
  const { project } = await c.api.createProject(name)
  if (flags.empty === true) {
    c.io.out(`project ${project.name}`)
    c.io.out('no resources yet. add one with:')
    c.io.out(`  hobby create postgres primary --project ${project.name}`)
    c.io.out(`  hobby deploy ./path --project ${project.name}`)
    return 0
  }
```

- [ ] **Step 4: Implement `hobby create`**

```ts
// The general form. `hobby pg create` becomes an alias for it rather than a
// second implementation, because root CLAUDE.md makes "the CLI and MCP must
// never diverge" structural: both now reach the same route with the same
// body.
export async function createCommand(c: Ctx, argv: string[]): Promise<number> {
  const { positional, flags } = parseArgs(argv)
  const [kind, name] = positional
  if (kind !== 'postgres' && kind !== 'app' && kind !== 'worker') {
    throw new UsageError('usage: hobby create <postgres|app|worker> <name> --project <project>')
  }
  if (typeof name !== 'string' || name.length === 0) {
    throw new UsageError('usage: hobby create <kind> <name> --project <project>')
  }
  const project = requireProjectFlag(flags)
  const { resource } = await c.api.createResource(project, { kind, name })
  ...
}
```

- [ ] **Step 5: Implement `parseDeploy` and the kind-conflict refusal**

```ts
// One positional only. The resource name defaults to the basename of the
// resolved path, so `hobby deploy ./site` targets `site`, and `--name`
// overrides it. Two optional positionals would be ambiguous.
export function parseDeploy(argv: string[]): { path: string; project?: string; name?: string } {
  const { positional, flags } = parseArgs(argv)
  const path = positional[0] ?? '.'
  const explicit = typeof flags['name'] === 'string' ? flags['name'] : undefined
  return {
    path,
    project: typeof flags['project'] === 'string' ? flags['project'] : undefined,
    name: explicit ?? (path === '.' ? undefined : basename(resolve(path))),
  }
}
```

In `deployCommand`, after resolving the project's resources:

```ts
  const existing = resources.find((r) => r.name === name)
  if (existing !== undefined && existing.kind !== kind) {
    throw new UsageError(
      `${project}/${name} is a ${existing.kind}, and a deploy would replace it. Pick another name with --name, or remove it first.`
    )
  }
```

- [ ] **Step 6: Show the state and hostname in `hobby ls`**

```
blog
  primary  postgres  sleeping     port 15432
  site     app       undeployed   blog-site.hobby.local  (no code yet)
  cron     worker    sleeping     blog-cron.hobby.local
```

- [ ] **Step 7: Update the help text**

In the usage block, add:

```
  hobby create <kind> <name> --project <p>  a resource with no code yet
  hobby new <name> --empty             a project with nothing in it
```

- [ ] **Step 8: Run the full suite**

Run: `npm test`
Expected: 472 passing, 0 failures.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "feat(cli): a project is a namespace, not a database with a name

\`hobby new\` still creates a postgres, because that is the one-command
ergonomic the root CLAUDE.md sells and there is no reason to spend it.
\`hobby new --empty\` does not.

\`hobby create <kind> <name>\` is the general form, and \`hobby pg create\`
becomes an alias for it rather than a second implementation. Both reach the
same route with the same body as Studio and MCP, which turns 'the CLI and MCP
must never diverge' from a discipline into a structural fact.

\`hobby deploy\` takes exactly one positional, the path, and derives the
resource name from its basename. Two optional positionals cannot be
disambiguated. Deploying onto a name held by a different kind refuses and
says so rather than replacing anything."
```

---

### Task 10: Write it down

**Files:**
- Create: `docs/decisions/0013-resource-records-exist-before-code.md`
- Modify: `claude_docs/ACTIVE_CONTEXT.md`
- Modify: `claude_docs/PROGRESS.md`
- Modify: `docs/compute/CLAUDE.md`
- Modify: `claude_docs/INDEX.md`

**Interfaces:**
- Consumes: everything.
- Produces: nothing executable.

- [ ] **Step 1: Write ADR 0013**

Follow the format in `docs/decisions/0012-durable-objects-and-the-alarm-mirror.md`.
It must state, in this order:

1. That resource creation and deploy were one indivisible operation, and that
   this was the reason Studio and MCP could not create compute.
2. The reversal of `app.ts:181-183`'s invariant, quoting the original, and why
   the original reasoning was correct for its model and wrong for this one.
3. Why `undeployed` is a state rather than a derived condition
   (`config.image === null`): the thing every consumer dispatches on must not
   lie, and `hobby ls` printing `sleeping` for something that can never wake is
   the concrete failure that rules the alternative out.
4. That a project no longer implies a Postgres, and that `hobby new` keeps
   creating one anyway because the ergonomic is worth more than the consistency.
5. The no-migration decision and the condition that would reverse it: a worker
   row found on another box.

- [ ] **Step 2: Correct `ACTIVE_CONTEXT.md`**

It is stale in a way that predates this work and must be fixed here rather than
left: its header says "Phase 2 compute on `phase-2-compute`" and its next step 3
says "Merge `phase-2-compute` to `main`, or decide not to." Both were true on
2026-08-10 and false since `fe16613` on 2026-08-11. Update the header, the build
order table and the immediate next steps to the current five-part sequence
(A record before code, B wire Caddy, D1 Studio and MCP for all kinds, D2 Studio
API tokens, C remote deploy).

- [ ] **Step 3: Append to `PROGRESS.md`**

Newest entry at the top, per that file's own instruction. What changed, what it
cost, what was learned. The finding worth recording: the 503 path and the
on-demand TLS behaviour both fell out of the released-project pattern that
already existed, so a feature specced as "no new branch" turned out to literally
need none.

- [ ] **Step 4: Update `docs/compute/CLAUDE.md`**

It describes creation and deploy as one operation. Correct it and link ADR 0013.

- [ ] **Step 5: Run the full suite one more time**

Run: `npm test`
Expected: 472 passing, 0 failures.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "docs: file record before code, and correct a stale context file

ADR 0013 records the reversal of app.ts's build-before-row invariant, why
\`undeployed\` is a state rather than a derived condition, and the condition
that would reverse the no-migration decision.

ACTIVE_CONTEXT.md is corrected rather than appended to. It claimed Phase 2
compute was unmerged on a branch and listed merging it as a next step, both
true on 2026-08-10 and false since fe16613 the following morning. A context
file that is wrong about the current state is worse than an empty one."
```

---

## Self-Review

**Spec coverage.** Every section of the spec maps to a task: the state machine
and reconcile exemption to Task 1, `ResourceConfigBase.image` to Task 2, the
`WorkerConfig` manifest split and the no-migration assertion to Task 3, the
creation route to Task 4, the deploy route and the failed-first-deploy rule to
Task 5, wire redaction to Task 6, the HTTP router and `allowHostname` to Task 7,
eject to Task 8, the whole CLI surface to Task 9, and ADR 0013 to Task 10.

**One correction the plan makes to the spec.** The spec said an undeployed
hostname answers 503 via the wake path. That is wrong: a wake failure is
bucketed `timeout` and rendered 504 (`http.ts:186-188`). It must throw from
`resolve()` to be bucketed `refused` and rendered 503 (`:172-174`). Task 7
implements the corrected version and explains why. This also makes
`allowHostname` correct with no extra code, since it already swallows a
`resolve()` throw.

**Test count.** The spec promised fifteen new tests. The plan writes eighteen:
the three extra are the failed-redeploy counterpart in Task 5 (the spec covered
only the failed first deploy, leaving the more common case untested), the
kind-conflict refusal in Task 9, and the "builds nothing, starts nothing"
assertion in Task 4. Final expected total is 472.
