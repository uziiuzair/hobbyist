# Project Snapshots Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A project can be snapshotted with everything in it quiesced, restored
into a new project, and the restore path is exercised weekly without anyone
asking it to be.

**Architecture:** One new primitive in core (`cloneTree`, reflink where the
filesystem allows it) and one new daemon module (`snapshots.ts`) that quiesces
through the existing kind handlers, clones the project directory, and writes a
manifest of the rows the directory does not carry. Restore replays that manifest
into fresh rows, rewriting every field that names the old project, the old
resource id, or a machine-unique resource. No new workspace package.

**Tech Stack:** TypeScript, `node:test` + `node:assert/strict`, `tsc --build` to
`packages/*/dist`, `npm test` from the repo root.

**Spec:** `docs/backups/specs/2026-08-16-project-snapshots-design.md`

**Decision:** `docs/decisions/0016-project-snapshots-and-no-pitr.md`

**Worktree:** `.claude/worktrees/snapshots`, branch `snapshots`, based on
`d342464` (main as of 2026-08-16, after `studio-tag-apply2` merged). Baseline was
699 tests at the queues merge; run `npm install` then `npm test` once before Task
1 and record the real number, because several branches have merged since.

## Global Constraints

- **NO EM-DASHES anywhere**, in code, comments, commit messages or output.
- **Narrowing, never casting.** No `as`, `!` or `any` to resolve a type error.
- **Comments cite `path/to/file.ts` with a symbol name**, and every line number
  cited must be verified against the current file before committing.
- **`packages/core` never imports Docker, Postgres or HTTP.** `copy.ts` is pure
  `node:fs`, which is why it is allowed to live there.
- **Two gates before every commit:** `npm test` from the worktree root AND
  `npm run build`. The second is not optional; it is what typechecks Studio.
- **`packages/cli/test/caddy.test.ts` hangs forever if a hobby daemon is already
  running on the box** (decision `hobbyist.caddy-test-hangs-against-a-running-daemon`).
  Stop the daemon before `npm test`, or the suite never returns and it looks like
  your change did it.
- **A snapshot that cannot confirm a resource was idle must fail, never
  proceed.** This is the one behavioural rule the whole feature rests on.
- **ADR 0015 is reserved for the Tailscale ingress ADR.** Do not file anything
  under that number. Snapshots are 0016.

---

### Task 1: `cloneTree` in core

**Files:**
- Create: `packages/core/src/copy.ts`
- Modify: `packages/core/src/index.ts` (export the new symbols)
- Test: `packages/core/test/copy.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  ```ts
  export type CloneMechanism = 'reflink' | 'copy'
  export interface CloneResult { mechanism: CloneMechanism; files: number; bytes: number }
  export function cloneTree(src: string, dst: string): Promise<CloneResult>
  ```

Reflink is attempted for the whole tree first, with `COPYFILE_FICLONE_FORCE`,
which throws rather than silently degrading. On failure the partial destination
is removed and the tree is copied again with plain `copyFile`. Reflink support is
a property of the filesystem, not of an individual file, so in practice this
fails on the first file or not at all.

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/test/copy.test.ts
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { copyFile, mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from 'node:fs/promises'
import { lstat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { cloneTree } from '../src/copy.js'

const roots: string[] = []
after(async () => {
  for (const root of roots) {
    await rm(root, { recursive: true, force: true })
  }
})

async function scratch(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `hobby-copy-${randomUUID()}-`))
  roots.push(root)
  return root
}

// The oracle for what this filesystem can actually do, using exactly the
// mechanism cloneTree uses, so the assertion below is not a guess about the
// machine the test happens to run on.
async function reflinkWorksIn(dir: string): Promise<boolean> {
  const a = join(dir, 'probe-a')
  const b = join(dir, 'probe-b')
  await writeFile(a, 'probe', 'utf8')
  try {
    await copyFile(a, b, constants.COPYFILE_FICLONE_FORCE)
    return true
  } catch {
    return false
  }
}

test('cloneTree copies a nested tree byte for byte', async () => {
  const root = await scratch()
  const src = join(root, 'src')
  const dst = join(root, 'dst')
  await mkdir(join(src, 'deep', 'deeper'), { recursive: true })
  await writeFile(join(src, 'top.txt'), 'top', 'utf8')
  await writeFile(join(src, 'deep', 'mid.txt'), 'mid', 'utf8')
  await writeFile(join(src, 'deep', 'deeper', 'leaf.bin'), Buffer.from([0, 1, 2, 3]))

  const result = await cloneTree(src, dst)

  assert.equal(await readFile(join(dst, 'top.txt'), 'utf8'), 'top')
  assert.equal(await readFile(join(dst, 'deep', 'mid.txt'), 'utf8'), 'mid')
  assert.deepEqual(await readFile(join(dst, 'deep', 'deeper', 'leaf.bin')), Buffer.from([0, 1, 2, 3]))
  assert.equal(result.files, 3)
  assert.equal(result.bytes, 3 + 3 + 4)
})

test('cloneTree preserves a symlink as a symlink', async () => {
  const root = await scratch()
  const src = join(root, 'src')
  const dst = join(root, 'dst')
  await mkdir(src, { recursive: true })
  await writeFile(join(src, 'real.txt'), 'real', 'utf8')
  await symlink('real.txt', join(src, 'link.txt'))

  await cloneTree(src, dst)

  const stat = await lstat(join(dst, 'link.txt'))
  assert.equal(stat.isSymbolicLink(), true)
  assert.equal(await readlink(join(dst, 'link.txt')), 'real.txt')
})

test('cloneTree reports the mechanism the filesystem actually supports', async () => {
  const root = await scratch()
  const src = join(root, 'src')
  const dst = join(root, 'dst')
  await mkdir(src, { recursive: true })
  await writeFile(join(src, 'a.txt'), 'a', 'utf8')

  const expected = (await reflinkWorksIn(root)) ? 'reflink' : 'copy'
  const result = await cloneTree(src, dst)

  assert.equal(result.mechanism, expected)
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx tsc --build && node --test packages/core/dist/test/copy.test.js`
Expected: FAIL. The build errors first, with `Cannot find module '../src/copy.js'`.

- [ ] **Step 3: Write the implementation**

```ts
// packages/core/src/copy.ts
// The one primitive snapshots and Phase 1.5 branching share. Snapshots clone a
// whole project directory; ADR 0005's branching clones a single stopped PGDATA
// one level down. Two copiers would mean two ext4 fallbacks, and the second one
// would eventually be wrong.
//
// Pure node:fs on purpose: core must never import Docker, Postgres or HTTP
// (packages/core/src/types.ts:3), and a file copier has no business knowing
// what it is copying.

import { constants } from 'node:fs'
import { copyFile, lstat, mkdir, readdir, readlink, rm, symlink } from 'node:fs/promises'
import { join } from 'node:path'

export type CloneMechanism = 'reflink' | 'copy'

export interface CloneResult {
  mechanism: CloneMechanism
  files: number
  bytes: number
}

interface Tally {
  files: number
  bytes: number
}

// COPYFILE_FICLONE_FORCE rather than COPYFILE_FICLONE: the plain flag falls
// back to a full copy silently, which would make `mechanism` a claim we cannot
// support. Reflink support is a property of the filesystem, so this either
// throws on the first regular file or does not throw at all.
async function copyEntry(src: string, dst: string, mode: number, tally: Tally): Promise<void> {
  const stat = await lstat(src)

  if (stat.isSymbolicLink()) {
    await symlink(await readlink(src), dst)
    tally.files += 1
    return
  }

  if (stat.isDirectory()) {
    await mkdir(dst, { recursive: true })
    for (const entry of await readdir(src)) {
      await copyEntry(join(src, entry), join(dst, entry), mode, tally)
    }
    return
  }

  // Sockets and fifos. A cleanly stopped Postgres leaves none behind (its
  // socket lives outside PGDATA), and copying one would either fail or produce
  // something meaningless, so they are skipped rather than counted.
  if (!stat.isFile()) {
    return
  }

  await copyFile(src, dst, mode)
  tally.files += 1
  tally.bytes += stat.size
}

export async function cloneTree(src: string, dst: string): Promise<CloneResult> {
  const tally: Tally = { files: 0, bytes: 0 }
  try {
    await copyEntry(src, dst, constants.COPYFILE_FICLONE_FORCE, tally)
    return { mechanism: 'reflink', files: tally.files, bytes: tally.bytes }
  } catch {
    // Whatever landed before the throw is unusable and must not be left for the
    // retry to trip over: a half-cloned directory with the right name is worse
    // than no directory at all.
    await rm(dst, { recursive: true, force: true })
  }

  const retry: Tally = { files: 0, bytes: 0 }
  await copyEntry(src, dst, 0, retry)
  return { mechanism: 'copy', files: retry.files, bytes: retry.bytes }
}
```

- [ ] **Step 4: Export it**

Add to `packages/core/src/index.ts`, beside the other `export * from` lines:

```ts
export * from './copy.js'
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx tsc --build && node --test packages/core/dist/test/copy.test.js`
Expected: PASS, 3 tests.

- [ ] **Step 6: Full gates and commit**

```bash
npm test && npm run build
git add packages/core/src/copy.ts packages/core/src/index.ts packages/core/test/copy.test.ts
git commit -m "feat(core): cloneTree, reflink where the filesystem allows it"
```

---

### Task 2: Snapshot identity and paths

**Files:**
- Create: `packages/cli/src/daemon/snapshots.ts`
- Test: `packages/cli/test/snapshots.test.ts`

**Interfaces:**
- Consumes: `Paths` from `@hobby.sh/core`.
- Produces:
  ```ts
  export function snapshotId(nowMs: number, suffix: string): string
  export function snapshotsRoot(paths: Paths): string
  export function projectSnapshotsDir(paths: Paths, project: string): string
  export function snapshotDir(paths: Paths, project: string, id: string): string
  export function verifyProjectName(id: string): string
  ```

The id is lowercase because restore builds project names from it and
`validateName` (`packages/core/src/names.ts:10`) enforces
`/^[a-z][a-z0-9-]{1,62}$/`. An uppercase `T` from an ISO timestamp would produce
snapshots that take cleanly and refuse to restore.

- [ ] **Step 1: Write the failing test**

```ts
// packages/cli/test/snapshots.test.ts
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { resolvePaths, validateName } from '@hobby.sh/core'
import { projectSnapshotsDir, snapshotDir, snapshotId, verifyProjectName } from '../src/daemon/snapshots.js'

test('snapshotId is lowercase, sortable, and safe inside a project name', () => {
  const id = snapshotId(Date.UTC(2026, 7, 16, 14, 30, 0), 'a1b2c3')
  assert.equal(id, '20260816t143000z-a1b2c3')
  assert.equal(id, id.toLowerCase())
  // The whole reason for lowercase: verify names are built from this.
  assert.doesNotThrow(() => validateName(verifyProjectName(id)))
})

test('snapshotIds sort chronologically as strings', () => {
  const earlier = snapshotId(Date.UTC(2026, 7, 16, 9, 0, 0), 'aaaaaa')
  const later = snapshotId(Date.UTC(2026, 7, 16, 14, 0, 0), 'aaaaaa')
  assert.equal([later, earlier].sort()[0], earlier)
})

test('verify project names stay inside the 63 character limit', () => {
  const id = snapshotId(Date.UTC(2026, 7, 16, 14, 30, 0), 'a1b2c3')
  assert.equal(verifyProjectName(id), 'verify-a1b2c3')
  assert.ok(verifyProjectName(id).length <= 63)
})

test('snapshot paths hang off the hobby home, not the project directory', () => {
  const paths = resolvePaths({ HOBBY_HOME: '/tmp/hobby-test-home' })
  assert.equal(projectSnapshotsDir(paths, 'blog'), '/tmp/hobby-test-home/snapshots/blog')
  assert.equal(snapshotDir(paths, 'blog', '20260816t143000z-a1b2c3'), '/tmp/hobby-test-home/snapshots/blog/20260816t143000z-a1b2c3')
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx tsc --build && node --test packages/cli/dist/test/snapshots.test.js`
Expected: FAIL, `Cannot find module '../src/daemon/snapshots.js'`.

- [ ] **Step 3: Write the implementation**

```ts
// packages/cli/src/daemon/snapshots.ts
// Whole-project snapshots: quiesce, clone, manifest. ADR 0016.
//
// The unit is the project rather than the resource because a project holds a
// postgres, the workers with Durable Object state, and the queue holding
// undelivered messages about all of it. Backing one up without the others
// produces a copy that is internally inconsistent in a way nobody notices until
// they restore it.

import { join } from 'node:path'
import type { Paths } from '@hobby.sh/core'

// Sortable, and lowercase because restore builds project names out of this and
// validateName (packages/core/src/names.ts:10) allows only /^[a-z][a-z0-9-]/.
// An uppercase T or Z from toISOString would produce a snapshot that takes
// cleanly and cannot be restored, discovered on the worst day.
export function snapshotId(nowMs: number, suffix: string): string {
  const iso = new Date(nowMs).toISOString()
  const stamp = iso.replace(/[-:]/g, '').replace(/\.\d{3}/, '').toLowerCase()
  return `${stamp}-${suffix}`
}

// The verify project is named from the suffix alone, never
// `<project>-verify-<id>`: project names cap at 63 characters, and a long
// project name plus a full id crosses it, so verification would start failing
// on exactly the installs that have been running longest.
export function verifyProjectName(id: string): string {
  const suffix = id.slice(id.indexOf('-') + 1)
  return `verify-${suffix}`
}

export function snapshotsRoot(paths: Paths): string {
  return join(paths.home, 'snapshots')
}

export function projectSnapshotsDir(paths: Paths, project: string): string {
  return join(snapshotsRoot(paths), project)
}

export function snapshotDir(paths: Paths, project: string, id: string): string {
  return join(projectSnapshotsDir(paths, project), id)
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx tsc --build && node --test packages/cli/dist/test/snapshots.test.js`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
npm test && npm run build
git add packages/cli/src/daemon/snapshots.ts packages/cli/test/snapshots.test.ts
git commit -m "feat(daemon): snapshot identity and paths, lowercase so restore can name a project"
```

---

### Task 3: Quiesce and resume

**Files:**
- Modify: `packages/cli/src/daemon/snapshots.ts`
- Test: `packages/cli/test/snapshots.test.ts`

**Interfaces:**
- Consumes: `snapshotId` (Task 2), `guardFor` and `KindRegistry` from
  `@hobby.sh/core`, `DaemonContext` from `./context.js`.
- Produces:
  ```ts
  export interface QuiesceOptions {
    attempts?: number
    waitMs?: number
    sleepFor?: (ms: number) => Promise<void>
    guard?: (resource: Resource) => Promise<ActivityGuardResult>
  }
  export function quiesce(ctx: DaemonContext, project: Project, opts?: QuiesceOptions): Promise<ResourceId[]>
  export function resume(ctx: DaemonContext, ids: ResourceId[]): Promise<string[]>
  ```
  `quiesce` returns the ids it stopped, in stop order. `resume` returns failure
  messages, one per resource that did not come back, and starts them in reverse.

The strictness here is the whole feature. The hibernator treats a guard result
of `unreachable` as "leave it alone and try next tick"
(`packages/cli/src/daemon/hibernator.ts:154-165`). A snapshot must fail instead:
a skipped sleep costs idle memory, a skipped resource inside a snapshot produces
a backup missing a database that does not say so.

- [ ] **Step 1: Write the failing tests**

```ts
// append to packages/cli/test/snapshots.test.ts
import { randomUUID } from 'node:crypto'
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { after } from 'node:test'
import {
  createFakeRuntime,
  openStore,
  type ActivityGuardResult,
  type HobbyConfig,
  type PostgresConfig,
  type Resource,
  type Store,
} from '@hobby.sh/core'
import { ActivityTracker } from '@hobby.sh/proxy'
import { createDefaultKindRegistry, type DaemonContext } from '../src/daemon/context.js'
import { quiesce, resume } from '../src/daemon/snapshots.js'

const homes: string[] = []
after(() => {
  for (const home of homes) {
    rmSync(home, { recursive: true, force: true })
  }
})

function testConfig(): HobbyConfig {
  return {
    image: 'postgres:18-alpine',
    proxyPort: 5432,
    studioPort: 8443,
    apiPort: 7432,
    httpPort: 7433,
    domain: 'localhost',
    sleepAfterSeconds: 300,
    wakeTimeoutMs: 150,
    readinessPollMs: 20,
    caddyEnabled: false,
    caddyAdminPort: 2019,
    caddyStudioHost: null,
  }
}

function buildContext(): DaemonContext {
  const home = join(tmpdir(), `hobby-snapshots-${randomUUID()}`)
  homes.push(home)
  const store: Store = openStore(':memory:')
  return {
    store,
    runtime: createFakeRuntime(),
    paths: resolvePaths({ HOBBY_HOME: home }),
    config: testConfig(),
    activity: new ActivityTracker(),
    kinds: createDefaultKindRegistry(),
  }
}

function postgresConfig(name: string): PostgresConfig {
  return {
    image: 'postgres:18-alpine',
    containerName: `hobby-test-${name}`,
    hostPort: 15432,
    dataDir: `/tmp/hobby-test/${name}/pgdata`,
    superuser: 'postgres',
    password: 'secret',
    database: 'app',
  }
}

test('quiesce stops running resources and reports them', async () => {
  const ctx = buildContext()
  const project = ctx.store.createProject({ name: 'blog', sleepAfterSeconds: null })
  const running = ctx.store.createResource({
    projectId: project.id,
    kind: 'postgres',
    name: 'primary',
    config: postgresConfig('primary'),
  })
  ctx.store.setResourceState(running.id, 'running')

  const stopped = await quiesce(ctx, project, { guard: async () => 'idle' })

  assert.deepEqual(stopped, [running.id])
})

test('quiesce leaves an already sleeping resource alone', async () => {
  const ctx = buildContext()
  const project = ctx.store.createProject({ name: 'blog', sleepAfterSeconds: null })
  const asleep = ctx.store.createResource({
    projectId: project.id,
    kind: 'postgres',
    name: 'primary',
    config: postgresConfig('primary'),
  })
  ctx.store.setResourceState(asleep.id, 'sleeping')

  const stopped = await quiesce(ctx, project, { guard: async () => 'idle' })

  assert.deepEqual(stopped, [])
  assert.equal(ctx.store.getResource(asleep.id)?.state, 'sleeping')
})

test('quiesce refuses when the guard cannot answer', async () => {
  const ctx = buildContext()
  const project = ctx.store.createProject({ name: 'blog', sleepAfterSeconds: null })
  const running = ctx.store.createResource({
    projectId: project.id,
    kind: 'postgres',
    name: 'primary',
    config: postgresConfig('primary'),
  })
  ctx.store.setResourceState(running.id, 'running')

  await assert.rejects(
    quiesce(ctx, project, { guard: async () => 'unreachable' }),
    /could not confirm/
  )
  // And it must not have stopped anything on its way to failing.
  assert.equal(ctx.store.getResource(running.id)?.state, 'running')
})

test('quiesce retries an active resource, then fails rather than snapshotting it', async () => {
  const ctx = buildContext()
  const project = ctx.store.createProject({ name: 'blog', sleepAfterSeconds: null })
  const running = ctx.store.createResource({
    projectId: project.id,
    kind: 'postgres',
    name: 'primary',
    config: postgresConfig('primary'),
  })
  ctx.store.setResourceState(running.id, 'running')

  let calls = 0
  const guard = async (): Promise<ActivityGuardResult> => {
    calls += 1
    return 'active'
  }

  await assert.rejects(
    quiesce(ctx, project, { guard, attempts: 3, waitMs: 1, sleepFor: async () => {} }),
    /still active/
  )
  assert.equal(calls, 3)
})

test('quiesce proceeds when a retry finds the resource gone idle', async () => {
  const ctx = buildContext()
  const project = ctx.store.createProject({ name: 'blog', sleepAfterSeconds: null })
  const running = ctx.store.createResource({
    projectId: project.id,
    kind: 'postgres',
    name: 'primary',
    config: postgresConfig('primary'),
  })
  ctx.store.setResourceState(running.id, 'running')

  let calls = 0
  const guard = async (): Promise<ActivityGuardResult> => {
    calls += 1
    return calls === 1 ? 'active' : 'idle'
  }

  const stopped = await quiesce(ctx, project, { guard, attempts: 3, waitMs: 1, sleepFor: async () => {} })
  assert.deepEqual(stopped, [running.id])
})
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npx tsc --build && node --test packages/cli/dist/test/snapshots.test.js`
Expected: FAIL, `quiesce is not exported`.

- [ ] **Step 3: Write the implementation**

```ts
// append to packages/cli/src/daemon/snapshots.ts
import { guardFor, HobbyError, type ActivityGuardResult, type Project, type Resource, type ResourceId } from '@hobby.sh/core'
import type { DaemonContext } from './context.js'

const DEFAULT_QUIESCE_ATTEMPTS = 5
const DEFAULT_QUIESCE_WAIT_MS = 2000

export interface QuiesceOptions {
  attempts?: number
  waitMs?: number
  sleepFor?: (ms: number) => Promise<void>
  guard?: (resource: Resource) => Promise<ActivityGuardResult>
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function defaultSleepFor(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// Deliberately stricter than the hibernator, which treats both non-idle results
// as "skip this one, try again next tick" (hibernator.ts:154-165). A skipped
// sleep costs a few idle megabytes. A skipped resource inside a snapshot
// produces a backup that is missing a database and does not say so.
async function waitForIdle(
  resource: Resource,
  guard: (resource: Resource) => Promise<ActivityGuardResult>,
  attempts: number,
  waitMs: number,
  sleepFor: (ms: number) => Promise<void>
): Promise<void> {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const result = await guard(resource)
    if (result === 'idle') {
      return
    }
    if (result === 'unreachable') {
      throw new HobbyError(
        'conflict',
        `could not confirm ${resource.name} is idle`,
        'a snapshot taken while a resource cannot answer its activity guard would be recorded as good without being known to be'
      )
    }
    if (attempt < attempts) {
      await sleepFor(waitMs)
    }
  }
  throw new HobbyError(
    'conflict',
    `${resource.name} is still active after ${attempts} attempts`,
    'retry when it is idle, or stop it yourself first'
  )
}

export async function quiesce(ctx: DaemonContext, project: Project, opts: QuiesceOptions = {}): Promise<ResourceId[]> {
  const attempts = opts.attempts ?? DEFAULT_QUIESCE_ATTEMPTS
  const waitMs = opts.waitMs ?? DEFAULT_QUIESCE_WAIT_MS
  const sleepFor = opts.sleepFor ?? defaultSleepFor
  const guard = opts.guard ?? ((resource: Resource): Promise<ActivityGuardResult> => guardFor(ctx.kinds, ctx, resource))

  const running = ctx.store.listResources(project.id).filter((resource) => resource.state === 'running')

  // Every guard is consulted before anything is stopped. Stopping resource one
  // and then failing on resource two would leave the project half down with no
  // snapshot to show for it, which is a worse outcome than refusing outright.
  for (const resource of running) {
    await waitForIdle(resource, guard, attempts, waitMs, sleepFor)
  }

  const stopped: ResourceId[] = []
  for (const resource of running) {
    await ctx.kinds.get(resource.kind).stop(ctx, resource)
    stopped.push(resource.id)
  }
  return stopped
}

// Failures are returned rather than thrown: by the time this runs the clone is
// already on disk and good, and reporting "the snapshot failed" because one
// container did not come back would send a reader looking in the wrong place.
export async function resume(ctx: DaemonContext, ids: ResourceId[]): Promise<string[]> {
  const failures: string[] = []
  for (const id of [...ids].reverse()) {
    const resource = ctx.store.getResource(id)
    if (resource === null) {
      continue
    }
    try {
      await ctx.kinds.get(resource.kind).start(ctx, resource)
    } catch (err: unknown) {
      failures.push(`restart ${resource.name}: ${errorMessage(err)}`)
    }
  }
  return failures
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx tsc --build && node --test packages/cli/dist/test/snapshots.test.js`
Expected: PASS, 9 tests total in the file.

- [ ] **Step 5: Commit**

```bash
npm test && npm run build
git add packages/cli/src/daemon/snapshots.ts packages/cli/test/snapshots.test.ts
git commit -m "feat(daemon): quiesce a project, and refuse when a guard cannot answer"
```

---

### Task 4: Take a snapshot

**Files:**
- Modify: `packages/cli/src/daemon/snapshots.ts`
- Test: `packages/cli/test/snapshots.test.ts`

**Interfaces:**
- Consumes: `cloneTree` (Task 1), `snapshotId` / `snapshotDir` (Task 2),
  `quiesce` / `resume` (Task 3).
- Produces:
  ```ts
  export interface SnapshotResourceEntry {
    id: string
    kind: ResourceKind
    name: string
    stateAtSnapshot: ResourceState
    config: ResourceConfig
    durableObjectClasses: string[]
  }
  export interface SnapshotVerification {
    status: 'unverified' | 'verified' | 'failed'
    at: string | null
    detail: string | null
  }
  export interface SnapshotManifest {
    version: 1
    snapshotId: string
    createdAt: string
    clone: CloneMechanism
    project: { name: string; sleepAfterSeconds: number | null }
    resources: SnapshotResourceEntry[]
    verification: SnapshotVerification
  }
  export interface TakeSnapshotOptions {
    now?: () => number
    suffix?: () => string
    quiesce?: QuiesceOptions
  }
  export function takeSnapshot(ctx: DaemonContext, projectName: string, opts?: TakeSnapshotOptions): Promise<SnapshotManifest>
  ```

`durableObjectClasses` is read from `WorkerConfig.manifest.durableObjects`
(`packages/core/src/types.ts:139`) and exists only so restore can compute the old
storage keys. `networkName` is deliberately not carried: a restored project gets
a fresh Docker network, and a stale name in a manifest is a fact that is true in
the file and false on the machine.

- [ ] **Step 1: Write the failing tests**

```ts
// append to packages/cli/test/snapshots.test.ts
import { readFile, stat } from 'node:fs/promises'
import { mkdir, writeFile } from 'node:fs/promises'
import { takeSnapshot } from '../src/daemon/snapshots.js'

test('takeSnapshot clones the project directory and writes a manifest', async () => {
  const ctx = buildContext()
  const project = ctx.store.createProject({ name: 'blog', sleepAfterSeconds: 900 })
  const resource = ctx.store.createResource({
    projectId: project.id,
    kind: 'postgres',
    name: 'primary',
    config: postgresConfig('primary'),
  })
  ctx.store.setResourceState(resource.id, 'sleeping')

  // A stand-in for a PGDATA: what matters here is that the bytes travel.
  await mkdir(ctx.paths.resourcePath('blog', 'primary', 'pgdata'), { recursive: true })
  await writeFile(join(ctx.paths.resourcePath('blog', 'primary', 'pgdata'), 'PG_VERSION'), '18\n', 'utf8')

  const manifest = await takeSnapshot(ctx, 'blog', {
    now: () => Date.UTC(2026, 7, 16, 14, 30, 0),
    suffix: () => 'a1b2c3',
  })

  assert.equal(manifest.snapshotId, '20260816t143000z-a1b2c3')
  assert.equal(manifest.project.name, 'blog')
  assert.equal(manifest.project.sleepAfterSeconds, 900)
  assert.equal(manifest.resources.length, 1)
  assert.equal(manifest.resources[0]?.name, 'primary')
  assert.equal(manifest.resources[0]?.stateAtSnapshot, 'sleeping')
  assert.equal(manifest.verification.status, 'unverified')

  const dir = snapshotDir(ctx.paths, 'blog', manifest.snapshotId)
  assert.equal(await readFile(join(dir, 'data', 'primary', 'pgdata', 'PG_VERSION'), 'utf8'), '18\n')
  const written: unknown = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8'))
  assert.deepEqual(written, manifest)
})

test('takeSnapshot restarts what it stopped', async () => {
  const ctx = buildContext()
  const project = ctx.store.createProject({ name: 'blog', sleepAfterSeconds: null })
  const resource = ctx.store.createResource({
    projectId: project.id,
    kind: 'postgres',
    name: 'primary',
    config: postgresConfig('primary'),
  })
  ctx.store.setResourceState(resource.id, 'running')
  await mkdir(ctx.paths.resourcePath('blog', 'primary', 'pgdata'), { recursive: true })

  await takeSnapshot(ctx, 'blog', {
    now: () => Date.UTC(2026, 7, 16, 14, 30, 0),
    suffix: () => 'a1b2c3',
    quiesce: { guard: async () => 'idle' },
  })

  assert.equal(ctx.store.getResource(resource.id)?.state, 'running')
})

test('takeSnapshot leaves nothing listable when the clone fails', async () => {
  const ctx = buildContext()
  ctx.store.createProject({ name: 'blog', sleepAfterSeconds: null })
  // No project directory on disk at all, so the clone throws.

  await assert.rejects(
    takeSnapshot(ctx, 'blog', { now: () => Date.UTC(2026, 7, 16, 14, 30, 0), suffix: () => 'a1b2c3' })
  )

  await assert.rejects(stat(snapshotDir(ctx.paths, 'blog', '20260816t143000z-a1b2c3')))
})
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npx tsc --build && node --test packages/cli/dist/test/snapshots.test.js`
Expected: FAIL, `takeSnapshot is not exported`.

- [ ] **Step 3: Write the implementation**

```ts
// append to packages/cli/src/daemon/snapshots.ts
import { randomUUID } from 'node:crypto'
import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import {
  cloneTree,
  type CloneMechanism,
  type ResourceConfig,
  type ResourceKind,
  type ResourceState,
} from '@hobby.sh/core'

export interface SnapshotResourceEntry {
  id: string
  kind: ResourceKind
  name: string
  stateAtSnapshot: ResourceState
  config: ResourceConfig
  durableObjectClasses: string[]
}

export interface SnapshotVerification {
  status: 'unverified' | 'verified' | 'failed'
  at: string | null
  detail: string | null
}

export interface SnapshotManifest {
  version: 1
  snapshotId: string
  createdAt: string
  clone: CloneMechanism
  project: { name: string; sleepAfterSeconds: number | null }
  resources: SnapshotResourceEntry[]
  verification: SnapshotVerification
}

export interface TakeSnapshotOptions {
  now?: () => number
  suffix?: () => string
  quiesce?: QuiesceOptions
}

// Only a worker has Durable Object classes, and only once it has deployed. The
// names exist in the manifest for exactly one consumer: restore, which needs
// them to compute the OLD storage keys it is renaming away from.
function durableObjectClassesOf(config: ResourceConfig): string[] {
  if (!('manifest' in config)) {
    return []
  }
  const manifest = config.manifest
  if (manifest === null) {
    return []
  }
  return manifest.durableObjects.map((entry) => entry.className)
}

function projectOrThrow(ctx: DaemonContext, name: string): Project {
  const project = ctx.store.getProjectByName(name)
  if (project === null) {
    throw new HobbyError('project_not_found', `no project named ${name}`, 'run `hobby ls` to see what exists')
  }
  return project
}

export async function takeSnapshot(
  ctx: DaemonContext,
  projectName: string,
  opts: TakeSnapshotOptions = {}
): Promise<SnapshotManifest> {
  const nowMs = (opts.now ?? Date.now)()
  const suffix = (opts.suffix ?? (() => randomUUID().slice(0, 6)))()
  const project = projectOrThrow(ctx, projectName)

  const id = snapshotId(nowMs, suffix)
  const finalDir = snapshotDir(ctx.paths, project.name, id)
  // Built under .partial and renamed only once the manifest is on disk, so a
  // crash mid-clone leaves nothing that list will ever offer on the worst day.
  const partialDir = `${finalDir}.partial`

  const stopped = await quiesce(ctx, project, opts.quiesce)
  let clone: CloneMechanism
  try {
    await mkdir(partialDir, { recursive: true })
    const result = await cloneTree(join(ctx.paths.projectsDir, project.name), join(partialDir, 'data'))
    clone = result.mechanism

    const manifest: SnapshotManifest = {
      version: 1,
      snapshotId: id,
      createdAt: new Date(nowMs).toISOString(),
      clone,
      project: { name: project.name, sleepAfterSeconds: project.sleepAfterSeconds },
      resources: ctx.store.listResources(project.id).map((resource) => ({
        id: resource.id,
        kind: resource.kind,
        name: resource.name,
        stateAtSnapshot: resource.state,
        config: resource.config,
        durableObjectClasses: durableObjectClassesOf(resource.config),
      })),
      verification: { status: 'unverified', at: null, detail: null },
    }
    await writeFile(join(partialDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
    await rename(partialDir, finalDir)

    return manifest
  } catch (err: unknown) {
    await rm(partialDir, { recursive: true, force: true })
    throw err
  } finally {
    const failures = await resume(ctx, stopped)
    for (const failure of failures) {
      console.error(`snapshot: ${failure}`)
    }
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx tsc --build && node --test packages/cli/dist/test/snapshots.test.js`
Expected: PASS, 12 tests total in the file.

- [ ] **Step 5: Commit**

```bash
npm test && npm run build
git add packages/cli/src/daemon/snapshots.ts packages/cli/test/snapshots.test.ts
git commit -m "feat(daemon): take a project snapshot, atomically or not at all"
```

---

### Task 5: List, find and delete snapshots

**Files:**
- Modify: `packages/cli/src/daemon/snapshots.ts`
- Test: `packages/cli/test/snapshots.test.ts`

**Interfaces:**
- Consumes: Task 4's `SnapshotManifest`, Task 2's path helpers.
- Produces:
  ```ts
  export interface FoundSnapshot { manifest: SnapshotManifest; dir: string; project: string }
  export function listSnapshots(ctx: DaemonContext, projectName: string): Promise<SnapshotManifest[]>
  export function findSnapshot(ctx: DaemonContext, id: string): Promise<FoundSnapshot | null>
  export function deleteSnapshot(ctx: DaemonContext, id: string): Promise<void>
  export function writeVerification(found: FoundSnapshot, verification: SnapshotVerification): Promise<void>
  ```

Ids are unique across the install, not per project, so `findSnapshot` scans
`<home>/snapshots/*/` rather than needing a project in the path. Directories
ending `.partial` are never listed.

- [ ] **Step 1: Write the failing tests**

```ts
// append to packages/cli/test/snapshots.test.ts
import { deleteSnapshot, findSnapshot, listSnapshots } from '../src/daemon/snapshots.js'

async function seedProject(ctx: DaemonContext, name: string): Promise<void> {
  ctx.store.createProject({ name, sleepAfterSeconds: null })
  await mkdir(ctx.paths.resourcePath(name, 'primary', 'pgdata'), { recursive: true })
}

test('listSnapshots returns newest first and skips partials', async () => {
  const ctx = buildContext()
  await seedProject(ctx, 'blog')

  await takeSnapshot(ctx, 'blog', { now: () => Date.UTC(2026, 7, 16, 9, 0, 0), suffix: () => 'aaaaaa' })
  await takeSnapshot(ctx, 'blog', { now: () => Date.UTC(2026, 7, 16, 14, 0, 0), suffix: () => 'bbbbbb' })
  await mkdir(join(projectSnapshotsDir(ctx.paths, 'blog'), '20260816t150000z-cccccc.partial'), { recursive: true })

  const listed = await listSnapshots(ctx, 'blog')

  assert.deepEqual(
    listed.map((manifest) => manifest.snapshotId),
    ['20260816t140000z-bbbbbb', '20260816t090000z-aaaaaa']
  )
})

test('findSnapshot resolves an id without being told the project', async () => {
  const ctx = buildContext()
  await seedProject(ctx, 'blog')
  const taken = await takeSnapshot(ctx, 'blog', { now: () => Date.UTC(2026, 7, 16, 9, 0, 0), suffix: () => 'aaaaaa' })

  const found = await findSnapshot(ctx, taken.snapshotId)

  assert.equal(found?.project, 'blog')
  assert.equal(found?.manifest.snapshotId, taken.snapshotId)
})

test('findSnapshot returns null for an id that does not exist', async () => {
  const ctx = buildContext()
  assert.equal(await findSnapshot(ctx, '20260816t090000z-zzzzzz'), null)
})

test('deleteSnapshot removes the directory', async () => {
  const ctx = buildContext()
  await seedProject(ctx, 'blog')
  const taken = await takeSnapshot(ctx, 'blog', { now: () => Date.UTC(2026, 7, 16, 9, 0, 0), suffix: () => 'aaaaaa' })

  await deleteSnapshot(ctx, taken.snapshotId)

  assert.equal(await findSnapshot(ctx, taken.snapshotId), null)
})
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npx tsc --build && node --test packages/cli/dist/test/snapshots.test.js`
Expected: FAIL, `listSnapshots is not exported`.

- [ ] **Step 3: Write the implementation**

```ts
// append to packages/cli/src/daemon/snapshots.ts
import { readdir, readFile } from 'node:fs/promises'

export interface FoundSnapshot {
  manifest: SnapshotManifest
  dir: string
  project: string
}

async function readManifest(dir: string): Promise<SnapshotManifest | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8'))
    if (!isSnapshotManifest(parsed)) {
      return null
    }
    return parsed
  } catch {
    return null
  }
}

// Narrowing rather than casting, per the repo's global constraint. A manifest
// written by a future version with a higher `version` is refused here rather
// than half-read, because a restore driven by a partly understood manifest is
// the one failure this whole feature exists to prevent.
function isSnapshotManifest(value: unknown): value is SnapshotManifest {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  const record: Record<string, unknown> = { ...value }
  return (
    record.version === 1 &&
    typeof record.snapshotId === 'string' &&
    typeof record.createdAt === 'string' &&
    Array.isArray(record.resources)
  )
}

async function readdirOrEmpty(dir: string): Promise<string[]> {
  try {
    return await readdir(dir)
  } catch {
    return []
  }
}

export async function listSnapshots(ctx: DaemonContext, projectName: string): Promise<SnapshotManifest[]> {
  const dir = projectSnapshotsDir(ctx.paths, projectName)
  const entries = (await readdirOrEmpty(dir)).filter((entry) => !entry.endsWith('.partial'))
  const manifests: SnapshotManifest[] = []
  for (const entry of entries.sort().reverse()) {
    const manifest = await readManifest(join(dir, entry))
    if (manifest !== null) {
      manifests.push(manifest)
    }
  }
  return manifests
}

export async function findSnapshot(ctx: DaemonContext, id: string): Promise<FoundSnapshot | null> {
  for (const project of await readdirOrEmpty(snapshotsRoot(ctx.paths))) {
    const dir = snapshotDir(ctx.paths, project, id)
    const manifest = await readManifest(dir)
    if (manifest !== null) {
      return { manifest, dir, project }
    }
  }
  return null
}

export async function deleteSnapshot(ctx: DaemonContext, id: string): Promise<void> {
  const found = await findSnapshot(ctx, id)
  if (found === null) {
    throw new HobbyError('resource_not_found', `no snapshot ${id}`, 'run `hobby snapshot list <project>`')
  }
  await rm(found.dir, { recursive: true, force: true })
}

export async function writeVerification(found: FoundSnapshot, verification: SnapshotVerification): Promise<void> {
  const updated: SnapshotManifest = { ...found.manifest, verification }
  await writeFile(join(found.dir, 'manifest.json'), `${JSON.stringify(updated, null, 2)}\n`, 'utf8')
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx tsc --build && node --test packages/cli/dist/test/snapshots.test.js`
Expected: PASS, 16 tests total in the file.

- [ ] **Step 5: Commit**

```bash
npm test && npm run build
git add packages/cli/src/daemon/snapshots.ts packages/cli/test/snapshots.test.ts
git commit -m "feat(daemon): list, find and delete snapshots"
```

---

### Task 6: Restore into a new project

**Files:**
- Modify: `packages/cli/src/daemon/snapshots.ts`
- Test: `packages/cli/test/snapshot-restore.test.ts` (new file: this task's
  rewrite rules deserve their own suite, and `snapshots.test.ts` is already long)

**Interfaces:**
- Consumes: Task 5's `findSnapshot`, `cloneTree`, `Store`.
- Produces:
  ```ts
  export interface RestoreOptions { as?: string; inPlace?: boolean }
  export interface RestoreResult { project: Project; resources: Resource[] }
  export function restoreSnapshot(ctx: DaemonContext, id: string, opts: RestoreOptions): Promise<RestoreResult>
  ```

Six rewrites, every one of which is a silent failure if missed. The spec's
"Restore" section is the authority; the list is repeated here because the
implementer may be reading this task alone:

1. `hostPort` (on `ResourceConfigBase`, `types.ts:55`) and
   `WorkerConfig.controlPort` (`types.ts:152`), reallocated via
   `store.allocatePort`.
2. `containerName` (on `ResourceConfigBase`), re-derived. Docker names are
   unique per daemon.
3. `PostgresConfig.dataDir` (absolute, written at `packages/pg/src/postgres.ts:124`,
   mounted at `:105`). Left alone, a restored Postgres writes into the original
   project's data directory.
4. `AppConfig.hostname` and `WorkerConfig.hostname`, re-derived from the new
   project name, or both copies claim one Caddy route.
5. `WorkerConfig.queueToken`, regenerated. Two resources holding one credential
   means the copy can enqueue as the original.
6. Durable Object storage directories, renamed `${oldId}-${class}` to
   `${newId}-${class}`, because `worker.ts:174` builds the storage key from the
   resource id. Miss this and every object comes up empty rather than erroring.

- [ ] **Step 1: Write the failing tests**

```ts
// packages/cli/test/snapshot-restore.test.ts
// The rewrites restore has to make, one test each. Every one of these is a
// silent failure in production: the restore succeeds and the copy quietly
// shares something with the original.

import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { rmSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import {
  createFakeRuntime,
  openStore,
  resolvePaths,
  type HobbyConfig,
  type PostgresConfig,
  type Store,
  type WorkerConfig,
} from '@hobby.sh/core'
import { ActivityTracker } from '@hobby.sh/proxy'
import { createDefaultKindRegistry, type DaemonContext } from '../src/daemon/context.js'
import { restoreSnapshot, takeSnapshot } from '../src/daemon/snapshots.js'

const homes: string[] = []
after(() => {
  for (const home of homes) {
    rmSync(home, { recursive: true, force: true })
  }
})

function testConfig(): HobbyConfig {
  return {
    image: 'postgres:18-alpine',
    proxyPort: 5432,
    studioPort: 8443,
    apiPort: 7432,
    httpPort: 7433,
    domain: 'localhost',
    sleepAfterSeconds: 300,
    wakeTimeoutMs: 150,
    readinessPollMs: 20,
    caddyEnabled: false,
    caddyAdminPort: 2019,
    caddyStudioHost: null,
  }
}

function buildContext(): DaemonContext {
  const home = join(tmpdir(), `hobby-restore-${randomUUID()}`)
  homes.push(home)
  const store: Store = openStore(':memory:')
  return {
    store,
    runtime: createFakeRuntime(),
    paths: resolvePaths({ HOBBY_HOME: home }),
    config: testConfig(),
    activity: new ActivityTracker(),
    kinds: createDefaultKindRegistry(),
  }
}

function postgresConfig(paths: DaemonContext['paths'], project: string, name: string): PostgresConfig {
  return {
    image: 'postgres:18-alpine',
    containerName: `hobby-${project}-${name}`,
    hostPort: 15432,
    dataDir: paths.resourcePath(project, name, 'pgdata'),
    superuser: 'postgres',
    password: 'secret',
    database: 'app',
  }
}

function workerConfig(project: string, name: string, resourceId: string): WorkerConfig {
  return {
    image: `hobby-${project}-${name}:latest`,
    containerName: `hobby-${project}-${name}`,
    hostPort: 18080,
    containerPort: 8080,
    controlPort: 18081,
    queueToken: 'token-from-the-original',
    hostname: `${name}.${project}.localhost`,
    databaseResourceId: null,
    durableObjectUniqueKeyModifier: resourceId,
    manifest: {
      dir: '/tmp/does-not-matter',
      file: 'wrangler.toml',
      main: 'index.ts',
      compatibilityDate: '2026-08-01',
      compatibilityFlags: [],
      durableObjects: [{ binding: 'COUNTER', className: 'Counter' }],
      queues: { producers: [], consumers: [] },
    },
  }
}

test('restore rewrites ports, container name and data directory', async () => {
  const ctx = buildContext()
  const project = ctx.store.createProject({ name: 'blog', sleepAfterSeconds: null })
  const original = ctx.store.createResource({
    projectId: project.id,
    kind: 'postgres',
    name: 'primary',
    config: postgresConfig(ctx.paths, 'blog', 'primary'),
  })
  await mkdir(ctx.paths.resourcePath('blog', 'primary', 'pgdata'), { recursive: true })
  await writeFile(join(ctx.paths.resourcePath('blog', 'primary', 'pgdata'), 'PG_VERSION'), '18\n', 'utf8')

  const taken = await takeSnapshot(ctx, 'blog', { now: () => Date.UTC(2026, 7, 16, 9, 0, 0), suffix: () => 'aaaaaa' })
  const restored = await restoreSnapshot(ctx, taken.snapshotId, { as: 'blog-copy' })

  const config = restored.resources[0]?.config
  assert.ok(config !== undefined && 'dataDir' in config)
  assert.equal(config.dataDir, ctx.paths.resourcePath('blog-copy', 'primary', 'pgdata'))
  assert.notEqual(config.containerName, 'hobby-blog-primary')
  assert.notEqual(config.hostPort, 15432)
  // The password is the one thing that must NOT change: the cloned data
  // directory expects it.
  assert.equal(config.password, 'secret')
  // And the original is untouched.
  const untouched = ctx.store.getResource(original.id)?.config
  assert.ok(untouched !== undefined && 'dataDir' in untouched)
  assert.equal(untouched.dataDir, ctx.paths.resourcePath('blog', 'primary', 'pgdata'))
})

test('restore carries the bytes', async () => {
  const ctx = buildContext()
  const project = ctx.store.createProject({ name: 'blog', sleepAfterSeconds: null })
  ctx.store.createResource({
    projectId: project.id,
    kind: 'postgres',
    name: 'primary',
    config: postgresConfig(ctx.paths, 'blog', 'primary'),
  })
  await mkdir(ctx.paths.resourcePath('blog', 'primary', 'pgdata'), { recursive: true })
  await writeFile(join(ctx.paths.resourcePath('blog', 'primary', 'pgdata'), 'PG_VERSION'), '18\n', 'utf8')

  const taken = await takeSnapshot(ctx, 'blog', { now: () => Date.UTC(2026, 7, 16, 9, 0, 0), suffix: () => 'aaaaaa' })
  await restoreSnapshot(ctx, taken.snapshotId, { as: 'blog-copy' })

  assert.equal(
    await readFile(join(ctx.paths.resourcePath('blog-copy', 'primary', 'pgdata'), 'PG_VERSION'), 'utf8'),
    '18\n'
  )
})

test('restore renames Durable Object storage to the new resource id', async () => {
  const ctx = buildContext()
  const project = ctx.store.createProject({ name: 'blog', sleepAfterSeconds: null })
  const placeholder = ctx.store.createResource({
    projectId: project.id,
    kind: 'worker',
    name: 'api',
    config: workerConfig('blog', 'api', 'placeholder'),
  })
  ctx.store.updateResourceConfig(placeholder.id, workerConfig('blog', 'api', placeholder.id))

  const oldKey = `${placeholder.id}-Counter`
  await mkdir(join(ctx.paths.resourcePath('blog', 'api', 'do'), oldKey), { recursive: true })
  await writeFile(join(ctx.paths.resourcePath('blog', 'api', 'do'), oldKey, 'obj.sqlite'), 'state', 'utf8')
  // Miniflare's own bookkeeping sits beside the objects and is not one.
  await writeFile(join(ctx.paths.resourcePath('blog', 'api', 'do'), oldKey, 'metadata.sqlite'), 'meta', 'utf8')

  const taken = await takeSnapshot(ctx, 'blog', { now: () => Date.UTC(2026, 7, 16, 9, 0, 0), suffix: () => 'aaaaaa' })
  const restored = await restoreSnapshot(ctx, taken.snapshotId, { as: 'blog-copy' })

  const newId = restored.resources[0]?.id
  assert.ok(newId !== undefined)
  assert.notEqual(newId, placeholder.id)
  assert.equal(
    await readFile(join(ctx.paths.resourcePath('blog-copy', 'api', 'do'), `${newId}-Counter`, 'obj.sqlite'), 'utf8'),
    'state'
  )
})

test('restore regenerates the queue token and re-derives the hostname', async () => {
  const ctx = buildContext()
  const project = ctx.store.createProject({ name: 'blog', sleepAfterSeconds: null })
  const worker = ctx.store.createResource({
    projectId: project.id,
    kind: 'worker',
    name: 'api',
    config: workerConfig('blog', 'api', 'placeholder'),
  })
  ctx.store.updateResourceConfig(worker.id, workerConfig('blog', 'api', worker.id))
  await mkdir(ctx.paths.resourcePath('blog', 'api', 'do'), { recursive: true })

  const taken = await takeSnapshot(ctx, 'blog', { now: () => Date.UTC(2026, 7, 16, 9, 0, 0), suffix: () => 'aaaaaa' })
  const restored = await restoreSnapshot(ctx, taken.snapshotId, { as: 'blog-copy' })

  const config = restored.resources[0]?.config
  assert.ok(config !== undefined && 'queueToken' in config)
  assert.notEqual(config.queueToken, 'token-from-the-original')
  assert.equal(config.hostname, 'api.blog-copy.localhost')
  assert.equal(config.durableObjectUniqueKeyModifier, restored.resources[0]?.id)
})

test('restore refuses a name that is already taken', async () => {
  const ctx = buildContext()
  const project = ctx.store.createProject({ name: 'blog', sleepAfterSeconds: null })
  ctx.store.createResource({
    projectId: project.id,
    kind: 'postgres',
    name: 'primary',
    config: postgresConfig(ctx.paths, 'blog', 'primary'),
  })
  await mkdir(ctx.paths.resourcePath('blog', 'primary', 'pgdata'), { recursive: true })
  ctx.store.createProject({ name: 'taken', sleepAfterSeconds: null })

  const taken = await takeSnapshot(ctx, 'blog', { now: () => Date.UTC(2026, 7, 16, 9, 0, 0), suffix: () => 'aaaaaa' })

  await assert.rejects(restoreSnapshot(ctx, taken.snapshotId, { as: 'taken' }), /already/)
})
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npx tsc --build && node --test packages/cli/dist/test/snapshot-restore.test.js`
Expected: FAIL, `restoreSnapshot is not exported`.

- [ ] **Step 3: Write the implementation**

```ts
// append to packages/cli/src/daemon/snapshots.ts
import { validateName, type Resource } from '@hobby.sh/core'

export interface RestoreOptions {
  as?: string
  inPlace?: boolean
}

export interface RestoreResult {
  project: Project
  resources: Resource[]
}

// Ports the daemon hands out, so a restored copy must never inherit them: the
// original may still be holding both. The range mirrors what createResource
// paths already use; see store.allocatePort.
const PORT_FROM = 15000
const PORT_TO = 19999

// Every field below either names the old project, embeds the old resource id,
// or is unique per machine. Each one is a SILENT failure if missed: the restore
// succeeds and the copy quietly shares something with the original. The
// sharpest is dataDir, where the copy would write into the original's PGDATA.
function rewriteConfig(
  ctx: DaemonContext,
  config: ResourceConfig,
  projectName: string,
  resourceName: string,
  newId: string
): ResourceConfig {
  const base = {
    ...config,
    containerName: `hobby-${projectName}-${resourceName}`,
    hostPort: ctx.store.allocatePort(PORT_FROM, PORT_TO),
  }

  if ('dataDir' in base) {
    return { ...base, dataDir: ctx.paths.resourcePath(projectName, resourceName, 'pgdata') }
  }

  if ('queueToken' in base) {
    return {
      ...base,
      controlPort: ctx.store.allocatePort(PORT_FROM, PORT_TO, [base.hostPort]),
      queueToken: randomUUID(),
      hostname: `${resourceName}.${projectName}.${ctx.config.domain}`,
      durableObjectUniqueKeyModifier: newId,
    }
  }

  if ('hostname' in base) {
    return { ...base, hostname: `${resourceName}.${projectName}.${ctx.config.domain}` }
  }

  return base
}

// worker.ts:174 builds a Durable Object's storage key from the RESOURCE ID
// (uniqueKeyFor, worker.ts:88), and the key is the directory name under
// .../<worker>/do/. A restored worker has a new id, so without this rename
// every object comes up empty rather than erroring: the state is on disk under
// a key nothing will ever ask for again. The sharpest silent failure in the
// whole feature.
async function renameDurableObjectDirs(
  ctx: DaemonContext,
  projectName: string,
  entry: SnapshotResourceEntry,
  newId: string
): Promise<void> {
  const doDir = ctx.paths.resourcePath(projectName, entry.name, 'do')
  for (const className of entry.durableObjectClasses) {
    const from = join(doDir, `${entry.id}-${className}`)
    const to = join(doDir, `${newId}-${className}`)
    try {
      await rename(from, to)
    } catch {
      // A worker that has deployed but whose object has never been addressed
      // has no directory yet. That is not an error, and inventing an empty one
      // would be worse than leaving it absent.
    }
  }
}

export async function restoreSnapshot(
  ctx: DaemonContext,
  id: string,
  opts: RestoreOptions
): Promise<RestoreResult> {
  const found = await findSnapshot(ctx, id)
  if (found === null) {
    throw new HobbyError('resource_not_found', `no snapshot ${id}`, 'run `hobby snapshot list <project>`')
  }
  if (opts.inPlace === true) {
    return restoreInPlace(ctx, found)
  }

  const target = opts.as ?? `${found.manifest.project.name}-restored`
  validateName(target)
  if (ctx.store.getProjectByName(target) !== null) {
    throw new HobbyError('name_taken', `a project named ${target} already exists`, 'pass a different --as name')
  }

  await cloneTree(join(found.dir, 'data'), join(ctx.paths.projectsDir, target))

  const project = ctx.store.createProject({
    name: target,
    sleepAfterSeconds: found.manifest.project.sleepAfterSeconds,
  })

  const resources: Resource[] = []
  for (const entry of found.manifest.resources) {
    // Created with the old config first so the row (and its id) exists before
    // the rewrite needs it: durableObjectUniqueKeyModifier is derived from the
    // new id, and the DO directory rename needs it too.
    const created = ctx.store.createResource({
      projectId: project.id,
      kind: entry.kind,
      name: entry.name,
      config: entry.config,
    })
    const rewritten = rewriteConfig(ctx, entry.config, target, entry.name, created.id)
    ctx.store.updateResourceConfig(created.id, rewritten)
    await renameDurableObjectDirs(ctx, target, entry, created.id)

    // Never `running`: nothing has been started, and a row claiming otherwise
    // is exactly the lie reconcile.ts exists to catch.
    ctx.store.setResourceState(created.id, entry.kind === 'queue' ? entry.stateAtSnapshot : 'sleeping')

    const reloaded = ctx.store.getResource(created.id)
    if (reloaded !== null) {
      resources.push(reloaded)
    }
  }

  return { project, resources }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx tsc --build && node --test packages/cli/dist/test/snapshot-restore.test.js`
Expected: FAIL on the first run with `restoreInPlace is not defined`. Add a
temporary throwing stub so this task's tests can pass, and implement it in Task 7:

```ts
// packages/cli/src/daemon/snapshots.ts, replaced in full by Task 7
async function restoreInPlace(ctx: DaemonContext, found: FoundSnapshot): Promise<RestoreResult> {
  throw new HobbyError('usage', 'in-place restore is not implemented yet', 'restore into a new project with --as')
}
```

Then re-run. Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
npm test && npm run build
git add packages/cli/src/daemon/snapshots.ts packages/cli/test/snapshot-restore.test.ts
git commit -m "feat(daemon): restore a snapshot into a new project, rewriting what cannot be shared"
```

---

### Task 7: Restore in place

**Files:**
- Modify: `packages/cli/src/daemon/snapshots.ts` (replace the Task 6 stub)
- Test: `packages/cli/test/snapshot-restore.test.ts`

**Interfaces:**
- Consumes: Task 6's `restoreSnapshot`, `quiesce` from Task 3.
- Produces: no new exported symbols. `restoreSnapshot(ctx, id, { inPlace: true })`
  becomes real.

In place keeps the original resource ids, so no DO rename and no config rewrite
happens at all: the config in the manifest is already correct for this project.
It is destructive, and it **refuses** while anything in the project is running
rather than quiescing on the caller's behalf. Stopping a user's project as a side
effect of a destructive command is a surprise; the spec's wording is "refuses to
run against a project that is not fully stopped", and that is what the code does.

- [ ] **Step 1: Write the failing tests**

```ts
// append to packages/cli/test/snapshot-restore.test.ts
test('in-place restore puts the old bytes back and keeps the ids', async () => {
  const ctx = buildContext()
  const project = ctx.store.createProject({ name: 'blog', sleepAfterSeconds: null })
  const original = ctx.store.createResource({
    projectId: project.id,
    kind: 'postgres',
    name: 'primary',
    config: postgresConfig(ctx.paths, 'blog', 'primary'),
  })
  await mkdir(ctx.paths.resourcePath('blog', 'primary', 'pgdata'), { recursive: true })
  await writeFile(join(ctx.paths.resourcePath('blog', 'primary', 'pgdata'), 'marker'), 'before', 'utf8')

  const taken = await takeSnapshot(ctx, 'blog', { now: () => Date.UTC(2026, 7, 16, 9, 0, 0), suffix: () => 'aaaaaa' })
  await writeFile(join(ctx.paths.resourcePath('blog', 'primary', 'pgdata'), 'marker'), 'after', 'utf8')

  const restored = await restoreSnapshot(ctx, taken.snapshotId, { inPlace: true })

  assert.equal(await readFile(join(ctx.paths.resourcePath('blog', 'primary', 'pgdata'), 'marker'), 'utf8'), 'before')
  assert.equal(restored.resources[0]?.id, original.id)
  assert.equal(restored.project.id, project.id)
})

test('in-place restore refuses while a resource is running', async () => {
  const ctx = buildContext()
  const project = ctx.store.createProject({ name: 'blog', sleepAfterSeconds: null })
  const running = ctx.store.createResource({
    projectId: project.id,
    kind: 'postgres',
    name: 'primary',
    config: postgresConfig(ctx.paths, 'blog', 'primary'),
  })
  await mkdir(ctx.paths.resourcePath('blog', 'primary', 'pgdata'), { recursive: true })
  const taken = await takeSnapshot(ctx, 'blog', { now: () => Date.UTC(2026, 7, 16, 9, 0, 0), suffix: () => 'aaaaaa' })
  ctx.store.setResourceState(running.id, 'running')

  await assert.rejects(restoreSnapshot(ctx, taken.snapshotId, { inPlace: true }), /running/)
})
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npx tsc --build && node --test packages/cli/dist/test/snapshot-restore.test.js`
Expected: FAIL, "in-place restore is not implemented yet".

- [ ] **Step 3: Replace the stub**

```ts
// packages/cli/src/daemon/snapshots.ts, replacing the Task 6 stub in full
//
// The destructive half. No config rewrite and no DO rename happen here: the
// project keeps its own name and its resources keep their ids, so every field
// the new-project path has to rebuild is already correct in the manifest.
async function restoreInPlace(ctx: DaemonContext, found: FoundSnapshot): Promise<RestoreResult> {
  const project = ctx.store.getProjectByName(found.manifest.project.name)
  if (project === null) {
    throw new HobbyError(
      'project_not_found',
      `no project named ${found.manifest.project.name}`,
      'restore into a new project with --as instead'
    )
  }

  const running = ctx.store.listResources(project.id).filter((resource) => resource.state === 'running')
  if (running.length > 0) {
    throw new HobbyError(
      'conflict',
      `${running.map((resource) => resource.name).join(', ')} is running`,
      'stop the project first: an in-place restore replaces the data directory under a live process'
    )
  }

  const projectDir = join(ctx.paths.projectsDir, project.name)
  await rm(projectDir, { recursive: true, force: true })
  await cloneTree(join(found.dir, 'data'), projectDir)

  const resources: Resource[] = []
  for (const entry of found.manifest.resources) {
    const existing = ctx.store.getResourceByName(project.id, entry.name)
    if (existing === null) {
      // A resource that was deleted after the snapshot was taken. Recreate the
      // row so the directory that just came back is reachable rather than
      // orphaned on disk, which is the failure eject's own comments warn about.
      const recreated = ctx.store.createResource({
        projectId: project.id,
        kind: entry.kind,
        name: entry.name,
        config: entry.config,
      })
      await renameDurableObjectDirs(ctx, project.name, entry, recreated.id)
      ctx.store.setResourceState(recreated.id, 'sleeping')
      const reloaded = ctx.store.getResource(recreated.id)
      if (reloaded !== null) {
        resources.push(reloaded)
      }
      continue
    }
    ctx.store.updateResourceConfig(existing.id, entry.config)
    await renameDurableObjectDirs(ctx, project.name, entry, existing.id)
    ctx.store.setResourceState(existing.id, entry.kind === 'queue' ? entry.stateAtSnapshot : 'sleeping')
    const reloaded = ctx.store.getResource(existing.id)
    if (reloaded !== null) {
      resources.push(reloaded)
    }
  }

  return { project, resources }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx tsc --build && node --test packages/cli/dist/test/snapshot-restore.test.js`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
npm test && npm run build
git add packages/cli/src/daemon/snapshots.ts packages/cli/test/snapshot-restore.test.ts
git commit -m "feat(daemon): in-place restore, which refuses to run under a live process"
```

---

### Task 8: The four routes

**Files:**
- Modify: `packages/cli/src/daemon/routes.ts`
- Test: `packages/cli/test/routes.test.ts`

**Interfaces:**
- Consumes: Tasks 4 to 7.
- Produces: four routes on the daemon API.

| Method | Path | Body | Returns |
|---|---|---|---|
| `POST` | `/v1/projects/:name/snapshots` | none | `201 { snapshot: SnapshotManifest }` |
| `GET` | `/v1/projects/:name/snapshots` | none | `200 { snapshots: SnapshotManifest[] }` |
| `POST` | `/v1/snapshots/:id/restore` | `{ as?: string, inPlace?: boolean }` | `200 { project, resources }` |
| `DELETE` | `/v1/snapshots/:id` | none | `200 { deleted: true }` |

Handlers either return `{ status, body }` or throw; `handleRequest` is the single
place that turns a throw into a wire error (see the file's header comment).

- [ ] **Step 1: Write the failing test**

```ts
// append to packages/cli/test/routes.test.ts, following the file's existing
// helper for building a context and calling dispatch
test('POST /v1/projects/:name/snapshots takes one and GET lists it', async () => {
  const ctx = buildContext()
  ctx.store.createProject({ name: 'blog', sleepAfterSeconds: null })
  await mkdir(ctx.paths.resourcePath('blog', 'primary', 'pgdata'), { recursive: true })

  const created = await dispatch(ctx, 'POST', '/v1/projects/blog/snapshots')
  assert.equal(created.status, 201)

  const listed = await dispatch(ctx, 'GET', '/v1/projects/blog/snapshots')
  assert.equal(listed.status, 200)
  assert.ok(isRecord(listed.body) && Array.isArray(listed.body.snapshots))
  assert.equal(listed.body.snapshots.length, 1)
})

test('DELETE /v1/snapshots/:id on an unknown id is a 404, not a 500', async () => {
  const ctx = buildContext()
  const result = await dispatch(ctx, 'DELETE', '/v1/snapshots/20260816t090000z-zzzzzz')
  assert.equal(result.status, 404)
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx tsc --build && node --test packages/cli/dist/test/routes.test.js`
Expected: FAIL with a 404 on the POST, because no route matches it yet.

- [ ] **Step 3: Add the handlers**

```ts
// packages/cli/src/daemon/routes.ts, beside the other route handlers
import {
  deleteSnapshot,
  listSnapshots,
  restoreSnapshot,
  takeSnapshot,
  type RestoreOptions,
} from './snapshots.js'

async function takeSnapshotRoute(ctx: DaemonContext, projectName: string): Promise<RouteResult> {
  return { status: 201, body: { snapshot: await takeSnapshot(ctx, projectName) } }
}

async function listSnapshotsRoute(ctx: DaemonContext, projectName: string): Promise<RouteResult> {
  // Resolve the project first so an unknown name is a 404 rather than an empty
  // list, which would read as "this project has no snapshots" for a project
  // that does not exist.
  getProjectOrThrow(ctx, projectName)
  return { status: 200, body: { snapshots: await listSnapshots(ctx, projectName) } }
}

async function restoreSnapshotRoute(ctx: DaemonContext, req: IncomingMessage, id: string): Promise<RouteResult> {
  const body: unknown = await readJsonBody(req)
  if (!isRecord(body)) {
    throw new HobbyError('usage', 'invalid body', 'expected a JSON object')
  }
  const opts: RestoreOptions = {}
  if (typeof body.as === 'string') {
    opts.as = body.as
  }
  if (body.inPlace === true) {
    opts.inPlace = true
  }
  if (opts.as !== undefined && opts.inPlace === true) {
    throw new HobbyError('usage', 'pass either as or inPlace, not both', 'in-place restores the original project')
  }
  const result = await restoreSnapshot(ctx, id, opts)
  return {
    status: 200,
    body: { project: result.project, resources: await toWireResources(ctx, result.resources) },
  }
}

async function deleteSnapshotRoute(ctx: DaemonContext, id: string): Promise<RouteResult> {
  await deleteSnapshot(ctx, id)
  return { status: 200, body: { deleted: true } }
}
```

- [ ] **Step 4: Wire them into `dispatch`**

In the segment matcher, beside the existing `segments.length === 4` cases for
`eject` and `adopt`:

```ts
    if (segments.length === 4 && segments[3] === 'snapshots') {
      const name = segments[2]
      if (name === undefined) {
        throw new HobbyError('usage', 'a project name is required', 'POST /v1/projects/<name>/snapshots')
      }
      if (method === 'POST') return await takeSnapshotRoute(ctx, name)
      if (method === 'GET') return await listSnapshotsRoute(ctx, name)
    }

    if (segments.length === 3 && segments[1] === 'snapshots') {
      const id = segments[2]
      if (id === undefined) {
        throw new HobbyError('usage', 'a snapshot id is required', 'DELETE /v1/snapshots/<id>')
      }
      if (method === 'DELETE') return await deleteSnapshotRoute(ctx, id)
    }

    if (segments.length === 4 && segments[1] === 'snapshots' && segments[3] === 'restore') {
      const id = segments[2]
      if (id === undefined) {
        throw new HobbyError('usage', 'a snapshot id is required', 'POST /v1/snapshots/<id>/restore')
      }
      if (method === 'POST') return await restoreSnapshotRoute(ctx, req, id)
    }
```

The indices above are verified against `routes.ts:1755-1773`: `segments[0]` is
`v1`, `segments[1]` is `projects`, `segments[2]` is the project name, and
`segments[3]` is the action. For `/v1/snapshots/:id` the segments are
`['v1', 'snapshots', id]`, and for the restore route
`['v1', 'snapshots', id, 'restore']`.

One deliberate difference from the neighbouring routes: they write
`decodeURIComponent(segments[2] as string)`, and this plan checks for
`undefined` instead. The global constraint forbids casts, and the existing ones
predate it rather than license new ones.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx tsc --build && node --test packages/cli/dist/test/routes.test.js`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
npm test && npm run build
git add packages/cli/src/daemon/routes.ts packages/cli/test/routes.test.ts
git commit -m "feat(daemon): snapshot routes, so Studio and MCP get them for free"
```

---

### Task 9: The CLI surface

**Files:**
- Modify: `packages/cli/src/cli/client.ts` (the `Api` interface and `createApi`)
- Modify: `packages/cli/src/cli/commands.ts` (`cmdSnapshot`, `cmdRestore`)
- Modify: `packages/cli/src/cli/main.ts` (dispatch and the usage text)
- Test: `packages/cli/test/commands.test.ts`

**Interfaces:**
- Consumes: Task 8's routes.
- Produces:
  ```ts
  // client.ts, on Api
  takeSnapshot(project: string): Promise<{ snapshot: SnapshotManifest }>
  listSnapshots(project: string): Promise<{ snapshots: SnapshotManifest[] }>
  restoreSnapshot(id: string, opts: { as?: string; inPlace?: boolean }): Promise<RestoreWireResult>
  deleteSnapshot(id: string): Promise<{ deleted: true }>
  // commands.ts
  export function cmdSnapshot(c: Ctx, positionals: string[], flags: Flags): Promise<number>
  export function cmdRestore(c: Ctx, positionals: string[], flags: Flags): Promise<number>
  ```

Commands:

```
hobby snapshot <project>                take one now
hobby snapshot list <project>           newest first, with verification state
hobby snapshot rm <snapshot-id>         delete one
hobby restore <snapshot-id> --as <name> restore into a new project
hobby restore <snapshot-id> --in-place  replace the original, asks first
```

- [ ] **Step 1: Write the failing test**

```ts
// append to packages/cli/test/commands.test.ts, following the file's existing
// fake-api pattern
test('hobby snapshot list prints verification state per row', async () => {
  const io = createFakeIo()
  const c = createFakeCtx(io, {
    listSnapshots: async () => ({
      snapshots: [
        {
          version: 1 as const,
          snapshotId: '20260816t140000z-bbbbbb',
          createdAt: '2026-08-16T14:00:00.000Z',
          clone: 'reflink' as const,
          project: { name: 'blog', sleepAfterSeconds: null },
          resources: [],
          verification: { status: 'verified' as const, at: '2026-08-16T15:00:00.000Z', detail: null },
        },
        {
          version: 1 as const,
          snapshotId: '20260816t090000z-aaaaaa',
          createdAt: '2026-08-16T09:00:00.000Z',
          clone: 'copy' as const,
          project: { name: 'blog', sleepAfterSeconds: null },
          resources: [],
          verification: { status: 'unverified' as const, at: null, detail: null },
        },
      ],
    }),
  })

  const code = await cmdSnapshot(c, ['list', 'blog'], {})

  assert.equal(code, 0)
  const printed = io.stdout.join('\n')
  assert.match(printed, /verified/)
  assert.match(printed, /unverified/)
})

test('hobby restore refuses --as together with --in-place', async () => {
  const io = createFakeIo()
  const c = createFakeCtx(io, {})
  await assert.rejects(cmdRestore(c, ['20260816t090000z-aaaaaa'], { as: 'copy', 'in-place': true }), /either/)
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx tsc --build && node --test packages/cli/dist/test/commands.test.js`
Expected: FAIL, `cmdSnapshot is not exported`.

- [ ] **Step 3: Add the api methods**

```ts
// packages/cli/src/cli/client.ts, on the Api interface and createApi's object
    takeSnapshot: (project) => call(client, 'POST', `/v1/projects/${p(project)}/snapshots`),
    listSnapshots: (project) => call(client, 'GET', `/v1/projects/${p(project)}/snapshots`),
    restoreSnapshot: (id, opts) => call(client, 'POST', `/v1/snapshots/${p(id)}/restore`, opts),
    deleteSnapshot: (id) => call(client, 'DELETE', `/v1/snapshots/${p(id)}`),
```

- [ ] **Step 4: Add the commands**

```ts
// packages/cli/src/cli/commands.ts
// The status column is the point of the list, not decoration. An unverified
// snapshot and a verified one must never look the same: "we have not checked"
// is a different fact from "we checked and it was fine", the same distinction
// ActivityGuardResult keeps between 'unreachable' and 'idle'.
export async function cmdSnapshot(c: Ctx, positionals: string[], flags: Flags): Promise<number> {
  const [first, second] = positionals

  if (first === 'list') {
    if (second === undefined) {
      throw new UsageError('usage: hobby snapshot list <project>')
    }
    const { snapshots } = await c.api.listSnapshots(second)
    if (flags.json) {
      c.io.out(JSON.stringify(snapshots))
      return 0
    }
    if (snapshots.length === 0) {
      c.io.out(`no snapshots for ${second} yet`)
      return 0
    }
    for (const snapshot of snapshots) {
      c.io.out(`${snapshot.snapshotId}  ${snapshot.createdAt}  ${snapshot.clone}  ${snapshot.verification.status}`)
    }
    return 0
  }

  if (first === 'rm') {
    if (second === undefined) {
      throw new UsageError('usage: hobby snapshot rm <snapshot-id>')
    }
    await c.api.deleteSnapshot(second)
    c.io.out(`deleted ${second}`)
    return 0
  }

  if (first === undefined) {
    throw new UsageError('usage: hobby snapshot <project>')
  }

  const { snapshot } = await c.api.takeSnapshot(first)
  if (flags.json) {
    c.io.out(JSON.stringify(snapshot))
    return 0
  }
  c.io.out(`${snapshot.snapshotId} (${snapshot.clone}, ${snapshot.resources.length} resources)`)
  return 0
}

export async function cmdRestore(c: Ctx, positionals: string[], flags: Flags): Promise<number> {
  const id = positionals[0]
  if (id === undefined) {
    throw new UsageError('usage: hobby restore <snapshot-id> [--as <name>] [--in-place]')
  }
  const inPlace = flags['in-place'] === true
  const as = typeof flags.as === 'string' ? flags.as : undefined
  if (inPlace && as !== undefined) {
    throw new UsageError('pass either --as or --in-place, not both')
  }

  // In place replaces a live project's data directories. Unlike eject, nothing
  // here is recoverable from stdout afterwards, so it gets the prompt eject
  // deliberately does not.
  if (inPlace && flags.yes !== true) {
    throw new UsageError('--in-place replaces the project on disk. Re-run with --yes to confirm')
  }

  const result = await c.api.restoreSnapshot(id, inPlace ? { inPlace: true } : { as })
  if (flags.json) {
    c.io.out(JSON.stringify(result))
    return 0
  }
  c.io.out(`restored into ${result.project.name} (${result.resources.length} resources, all stopped)`)
  c.io.err('nothing was started. `hobby start` when you are ready, or just connect and let it wake')
  return 0
}
```

- [ ] **Step 5: Wire dispatch and usage**

In `packages/cli/src/cli/main.ts`, beside `case 'eject'`:

```ts
      case 'snapshot': {
        const { positionals, flags } = parseArgs(rest, { bool: ['json'] })
        return await cmdSnapshot(ctx, positionals, flags)
      }
      case 'restore': {
        const { positionals, flags } = parseArgs(rest, { bool: ['json', 'in-place', 'yes'], value: ['as'] })
        return await cmdRestore(ctx, positionals, flags)
      }
```

And in the usage block near `main.ts:137`:

```ts
  io.out('  hobby snapshot <project>              take a snapshot now')
  io.out('  hobby snapshot list <project>         list snapshots, newest first')
  io.out('  hobby snapshot rm <snapshot-id>       delete a snapshot')
  io.out('  hobby restore <id> --as <name>        restore into a new project')
  io.out('  hobby restore <id> --in-place --yes   replace the original project')
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx tsc --build && node --test packages/cli/dist/test/commands.test.js`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
npm test && npm run build
git add packages/cli/src/cli/client.ts packages/cli/src/cli/commands.ts packages/cli/src/cli/main.ts packages/cli/test/commands.test.ts
git commit -m "feat(cli): hobby snapshot and hobby restore"
```

---

### Task 10: Config, the ticker, retention and the free-space floor

**Files:**
- Modify: `packages/core/src/config.ts` (`HobbyConfig`, `DEFAULT_CONFIG`, env parsing)
- Modify: `packages/cli/src/daemon/snapshots.ts` (`startSnapshotter`, `pruneSnapshots`)
- Modify: `packages/cli/src/daemon/server.ts` (start and stop it beside the hibernator)
- Test: `packages/cli/test/snapshotter.test.ts` (new file)

**Interfaces:**
- Consumes: Tasks 4 and 5.
- Produces:
  ```ts
  // config.ts, all optional for the reason queuePort is optional at config.ts:101
  snapshotEverySeconds?: number | null
  snapshotKeep?: number
  snapshotMinFreeBytes?: number
  snapshotVerifyEverySeconds?: number | null
  // snapshots.ts
  export interface StartSnapshotterOptions {
    intervalMs: number
    now?: () => number
    sleepFor?: (ms: number) => Promise<void>
    freeBytes?: (path: string) => Promise<number>
  }
  export function startSnapshotter(ctx: DaemonContext, opts: StartSnapshotterOptions): { stop(): Promise<void> }
  export function pruneSnapshots(ctx: DaemonContext, projectName: string, keep: number): Promise<string[]>
  ```

Defaults: `snapshotEverySeconds: 86400`, `snapshotKeep: 7`,
`snapshotMinFreeBytes: 2 * 1024 * 1024 * 1024`,
`snapshotVerifyEverySeconds: 604800`. On by default, because a backup a user has
to enable is a backup that does not exist. Free space comes from `statfs`, the
same source `preflight.ts:287` uses (`bavail * bsize`).

Pruning happens **after** a new snapshot lands, never before, so a failed
snapshot never costs the user the older one it was going to replace.

- [ ] **Step 1: Write the failing tests**

```ts
// packages/cli/test/snapshotter.test.ts
import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { test } from 'node:test'
import { listSnapshots, pruneSnapshots, startSnapshotter, takeSnapshot } from '../src/daemon/snapshots.js'
// buildContext and the config helper are duplicated from snapshots.test.ts on
// purpose: the repo's test files are self-contained, see queues.test.ts.

test('pruneSnapshots keeps the newest N and reports what it removed', async () => {
  const ctx = buildContext()
  ctx.store.createProject({ name: 'blog', sleepAfterSeconds: null })
  await mkdir(ctx.paths.resourcePath('blog', 'primary', 'pgdata'), { recursive: true })
  for (let hour = 1; hour <= 4; hour += 1) {
    await takeSnapshot(ctx, 'blog', {
      now: () => Date.UTC(2026, 7, 16, hour, 0, 0),
      suffix: () => `s${hour}0000`,
    })
  }

  const removed = await pruneSnapshots(ctx, 'blog', 2)

  assert.equal(removed.length, 2)
  const left = await listSnapshots(ctx, 'blog')
  assert.deepEqual(
    left.map((manifest) => manifest.snapshotId),
    ['20260816t040000z-s40000', '20260816t030000z-s30000']
  )
})

test('the snapshotter refuses to run when free space is below the floor', async () => {
  const ctx = buildContext()
  ctx.config.snapshotMinFreeBytes = 1024
  ctx.store.createProject({ name: 'blog', sleepAfterSeconds: null })
  await mkdir(ctx.paths.resourcePath('blog', 'primary', 'pgdata'), { recursive: true })

  const snapshotter = startSnapshotter(ctx, {
    intervalMs: 1,
    sleepFor: async () => {},
    freeBytes: async () => 512,
  })
  await new Promise((resolve) => setTimeout(resolve, 20))
  await snapshotter.stop()

  assert.deepEqual(await listSnapshots(ctx, 'blog'), [])
})

test('the snapshotter takes one per project per tick', async () => {
  const ctx = buildContext()
  ctx.store.createProject({ name: 'blog', sleepAfterSeconds: null })
  ctx.store.createProject({ name: 'shop', sleepAfterSeconds: null })
  await mkdir(ctx.paths.resourcePath('blog', 'primary', 'pgdata'), { recursive: true })
  await mkdir(ctx.paths.resourcePath('shop', 'primary', 'pgdata'), { recursive: true })

  const snapshotter = startSnapshotter(ctx, {
    intervalMs: 1,
    sleepFor: async () => {},
    freeBytes: async () => 10 * 1024 * 1024 * 1024,
  })
  await new Promise((resolve) => setTimeout(resolve, 20))
  await snapshotter.stop()

  assert.ok((await listSnapshots(ctx, 'blog')).length >= 1)
  assert.ok((await listSnapshots(ctx, 'shop')).length >= 1)
})
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npx tsc --build && node --test packages/cli/dist/test/snapshotter.test.js`
Expected: FAIL, `startSnapshotter is not exported`.

- [ ] **Step 3: Add the config fields**

```ts
// packages/core/src/config.ts, on HobbyConfig
  // Snapshots (ADR 0016). All optional for the same reason queuePort above is:
  // every hand-built HobbyConfig fixture across the repo would otherwise have
  // to be touched to add a field it does not care about. DEFAULT_CONFIG
  // supplies the real values.
  //
  // On by default, and deliberately: docs/backups/CLAUDE.md's own principle is
  // that a backup a user has to set up is a backup that does not exist, and
  // off-by-default is that same failure wearing a config flag. Null disables.
  snapshotEverySeconds?: number | null
  snapshotKeep?: number
  // Retention is nearly free on a reflink filesystem and linear on ext4, where
  // seven dailies means seven full copies of every PGDATA. Rather than a second
  // knob nobody would tune, the snapshotter refuses to cross this floor and
  // says so with the numbers.
  snapshotMinFreeBytes?: number
  snapshotVerifyEverySeconds?: number | null
```

```ts
// packages/core/src/config.ts, in DEFAULT_CONFIG
  snapshotEverySeconds: 86400,
  snapshotKeep: 7,
  snapshotMinFreeBytes: 2 * 1024 * 1024 * 1024,
  snapshotVerifyEverySeconds: 604800,
```

- [ ] **Step 4: Add the ticker and pruning**

```ts
// append to packages/cli/src/daemon/snapshots.ts
import { statfs } from 'node:fs/promises'

export interface StartSnapshotterOptions {
  intervalMs: number
  now?: () => number
  sleepFor?: (ms: number) => Promise<void>
  freeBytes?: (path: string) => Promise<number>
}

const DEFAULT_KEEP = 7
const DEFAULT_MIN_FREE_BYTES = 2 * 1024 * 1024 * 1024

// Same source preflight.ts:287 uses for its own freeBytes report.
async function defaultFreeBytes(path: string): Promise<number> {
  const stats = await statfs(path)
  return stats.bavail * stats.bsize
}

// After the new snapshot lands, never before: a failed snapshot must not cost
// the user the older one it was going to replace.
export async function pruneSnapshots(ctx: DaemonContext, projectName: string, keep: number): Promise<string[]> {
  const snapshots = await listSnapshots(ctx, projectName)
  const removed: string[] = []
  for (const manifest of snapshots.slice(keep)) {
    await rm(snapshotDir(ctx.paths, projectName, manifest.snapshotId), { recursive: true, force: true })
    removed.push(manifest.snapshotId)
  }
  return removed
}

export function startSnapshotter(ctx: DaemonContext, opts: StartSnapshotterOptions): { stop(): Promise<void> } {
  const sleepFor = opts.sleepFor ?? defaultSleepFor
  const freeBytes = opts.freeBytes ?? defaultFreeBytes
  const keep = ctx.config.snapshotKeep ?? DEFAULT_KEEP
  const minFree = ctx.config.snapshotMinFreeBytes ?? DEFAULT_MIN_FREE_BYTES

  let stopped = false
  let resolveStopSignal: () => void = () => {}
  const stopSignal = new Promise<void>((resolve) => {
    resolveStopSignal = resolve
  })
  let currentTick: Promise<void> | null = null

  // Same shape as startHibernator's waitOrStop (hibernator.ts:230): a stop()
  // must interrupt a long wait rather than waiting the interval out. A daily
  // interval makes that not optional.
  async function waitOrStop(ms: number): Promise<boolean> {
    let sleptFully = true
    await Promise.race([
      sleepFor(ms),
      stopSignal.then(() => {
        sleptFully = false
      }),
    ])
    return sleptFully
  }

  async function tick(): Promise<void> {
    const free = await freeBytes(ctx.paths.home)
    if (free < minFree) {
      console.error(
        `snapshotter: skipping, ${free} bytes free is below the floor of ${minFree}. ` +
          'prune snapshots or raise snapshotMinFreeBytes'
      )
      return
    }
    for (const project of ctx.store.listProjects()) {
      try {
        await takeSnapshot(ctx, project.name)
        await pruneSnapshots(ctx, project.name, keep)
      } catch (err: unknown) {
        // One project refusing to quiesce must not stop the others being
        // backed up, which is the same reasoning hibernator.ts:162 gives for
        // not letting one guard failure abort a whole tick.
        console.error(`snapshotter: ${project.name}: ${errorMessage(err)}`)
      }
    }
  }

  const loop = (async (): Promise<void> => {
    while (!stopped) {
      const sleptFully = await waitOrStop(opts.intervalMs)
      if (!sleptFully || stopped) {
        break
      }
      currentTick = tick().catch((err: unknown) => {
        console.error(`snapshotter: tick failed: ${errorMessage(err)}`)
      })
      await currentTick
      currentTick = null
    }
  })()

  return {
    async stop(): Promise<void> {
      stopped = true
      resolveStopSignal()
      if (currentTick !== null) {
        await currentTick
      }
      await loop
    },
  }
}
```

- [ ] **Step 5: Start it in the daemon**

In `packages/cli/src/daemon/server.ts`, beside the `startHibernator` call, and
stopped in the same shutdown path:

```ts
  const snapshotter =
    ctx.config.snapshotEverySeconds === null || ctx.config.snapshotEverySeconds === undefined
      ? null
      : startSnapshotter(ctx, { intervalMs: ctx.config.snapshotEverySeconds * 1000 })
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx tsc --build && node --test packages/cli/dist/test/snapshotter.test.js`
Expected: PASS, 3 tests.

- [ ] **Step 7: Commit**

```bash
npm test && npm run build
git add packages/core/src/config.ts packages/cli/src/daemon/snapshots.ts packages/cli/src/daemon/server.ts packages/cli/test/snapshotter.test.ts
git commit -m "feat(daemon): snapshot on a schedule, prune after, and refuse to fill the disk"
```

---

### Task 11: Verification, so a snapshot is not a rumour

**Files:**
- Modify: `packages/cli/src/daemon/snapshots.ts`
- Test: `packages/cli/test/snapshotter.test.ts`

**Interfaces:**
- Consumes: Tasks 5, 6 and 10.
- Produces:
  ```ts
  export function verifySnapshot(ctx: DaemonContext, id: string): Promise<SnapshotVerification>
  ```
  Called from the snapshotter's tick when `snapshotVerifyEverySeconds` has
  elapsed since the newest snapshot's `verification.at`.

The pass restores the newest snapshot as `verifyProjectName(id)` (Task 2),
starts every resource, asserts each kind's own readiness probe, then destroys the
verify project and writes the result back into the snapshot's manifest. The probe
must be the handler's real one, the one `reconcile.ts` documents at length and
that Phase 2 had to relearn: a TCP connect to a published port succeeds the
instant the container exists.

- [ ] **Step 1: Write the failing tests**

```ts
// append to packages/cli/test/snapshotter.test.ts
import { findSnapshot, verifySnapshot } from '../src/daemon/snapshots.js'

test('verifySnapshot records verified and leaves no verify project behind', async () => {
  const ctx = buildContext()
  ctx.store.createProject({ name: 'blog', sleepAfterSeconds: null })
  await mkdir(ctx.paths.resourcePath('blog', 'primary', 'pgdata'), { recursive: true })
  const taken = await takeSnapshot(ctx, 'blog', { now: () => Date.UTC(2026, 7, 16, 9, 0, 0), suffix: () => 'aaaaaa' })

  const verification = await verifySnapshot(ctx, taken.snapshotId)

  assert.equal(verification.status, 'verified')
  assert.equal(ctx.store.getProjectByName('verify-aaaaaa'), null)
  const found = await findSnapshot(ctx, taken.snapshotId)
  assert.equal(found?.manifest.verification.status, 'verified')
})

test('verifySnapshot records failed rather than throwing, and still cleans up', async () => {
  const ctx = buildContext()
  ctx.store.createProject({ name: 'blog', sleepAfterSeconds: null })
  await mkdir(ctx.paths.resourcePath('blog', 'primary', 'pgdata'), { recursive: true })
  const taken = await takeSnapshot(ctx, 'blog', { now: () => Date.UTC(2026, 7, 16, 9, 0, 0), suffix: () => 'aaaaaa' })

  // A runtime that refuses to start anything stands in for a corrupt copy.
  ctx.runtime = {
    ...ctx.runtime,
    createContainer: async () => {
      throw new Error('nope')
    },
  }

  const verification = await verifySnapshot(ctx, taken.snapshotId)

  assert.equal(verification.status, 'failed')
  assert.notEqual(verification.detail, null)
  assert.equal(ctx.store.getProjectByName('verify-aaaaaa'), null)
})
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npx tsc --build && node --test packages/cli/dist/test/snapshotter.test.js`
Expected: FAIL, `verifySnapshot is not exported`.

- [ ] **Step 3: Write the implementation**

```ts
// append to packages/cli/src/daemon/snapshots.ts
//
// An unverified backup is a rumour (docs/backups/CLAUDE.md). This is what turns
// the restore path from code that runs once, under stress, into code that runs
// weekly, unattended.
//
// Never throws: a verification that blows up must record `failed` and leave a
// readable reason, because an exception here would be swallowed by the tick's
// own catch and the snapshot would stay `unverified`, which reads as "not
// checked yet" rather than "checked and broken".
export async function verifySnapshot(ctx: DaemonContext, id: string): Promise<SnapshotVerification> {
  const found = await findSnapshot(ctx, id)
  if (found === null) {
    throw new HobbyError('resource_not_found', `no snapshot ${id}`, 'run `hobby snapshot list <project>`')
  }

  const verifyName = verifyProjectName(id)
  let verification: SnapshotVerification

  try {
    const restored = await restoreSnapshot(ctx, id, { as: verifyName })
    for (const resource of restored.resources) {
      const handler = ctx.kinds.get(resource.kind)
      await handler.start(ctx, resource)
      const serving = await handler.probe(ctx, resource)
      if (!serving) {
        throw new Error(`${resource.name} started but never answered its readiness probe`)
      }
    }
    verification = { status: 'verified', at: new Date().toISOString(), detail: null }
  } catch (err: unknown) {
    verification = { status: 'failed', at: new Date().toISOString(), detail: errorMessage(err) }
  }

  // Cleanup runs on both paths. A failed verification that left its wreckage
  // behind would fill the disk one week at a time, which is the failure the
  // free-space floor exists to prevent and would look identical to it.
  const verifyProject = ctx.store.getProjectByName(verifyName)
  if (verifyProject !== null) {
    for (const resource of ctx.store.listResources(verifyProject.id)) {
      try {
        await ctx.kinds.get(resource.kind).destroy(ctx, resource)
      } catch (err: unknown) {
        console.error(`verify: destroying ${resource.name}: ${errorMessage(err)}`)
      }
    }
    ctx.store.deleteProject(verifyProject.id)
    await rm(join(ctx.paths.projectsDir, verifyName), { recursive: true, force: true })
  }

  await writeVerification(found, verification)
  return verification
}
```

`handler.probe` is the correct name, verified at `packages/core/src/kinds.ts:82`:
`probe(ctx: KindContext, resource: TResource): Promise<boolean>`. It is the
"observed reality for reconcile" check, which is the whole point of using it
here rather than trusting the row's state.

- [ ] **Step 4: Call it from the tick**

In `startSnapshotter`'s `tick`, after the per-project loop:

```ts
    const verifyEvery = ctx.config.snapshotVerifyEverySeconds
    if (verifyEvery !== null && verifyEvery !== undefined) {
      for (const project of ctx.store.listProjects()) {
        const newest = (await listSnapshots(ctx, project.name))[0]
        if (newest === undefined || newest.verification.status !== 'unverified') {
          continue
        }
        try {
          await verifySnapshot(ctx, newest.snapshotId)
        } catch (err: unknown) {
          console.error(`snapshotter: verifying ${project.name}: ${errorMessage(err)}`)
        }
      }
    }
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx tsc --build && node --test packages/cli/dist/test/snapshotter.test.js`
Expected: PASS, 5 tests.

- [ ] **Step 6: Commit**

```bash
npm test && npm run build
git add packages/cli/src/daemon/snapshots.ts packages/cli/test/snapshotter.test.ts
git commit -m "feat(daemon): verify a snapshot by restoring it, weekly"
```

---

### Task 12: Run it against real Docker, then file what happened

**Files:**
- Create: `docs/backups/research/2026-08-16-snapshots-against-real-docker.md`
- Modify: `docs/backups/specs/2026-08-16-project-snapshots-design.md` (status line)
- Modify: `docs/backups/CLAUDE.md` (status line)
- Modify: `claude_docs/ACTIVE_CONTEXT.md` and `claude_docs/PROGRESS.md`

Every bug in Phase 2 came from running the thing, none from testing it
(`claude_docs/PROGRESS.md`). Nothing in Tasks 1 to 11 has touched a real
container. This task is not paperwork.

- [ ] **Step 1: Build a project with all three kinds of state**

```bash
hobby init
hobby create blog
hobby pg create blog/primary
psql "$(hobby connection blog/primary)" -c 'create table t (v text); insert into t values (:tag);' \
  -v tag="'survived'"
# a worker with a Durable Object, from the same fixture Phase 2 used
hobby deploy blog/api ./fixtures/worker-with-do
curl -s "$(hobby url blog/api)/count"   # returns 1
curl -s "$(hobby url blog/api)/count"   # returns 2
# a queue with an undelivered backlog: enqueue with the consumer stopped
hobby stop blog/api
hobby queue send blog/jobs '{"n":1}'
```

- [ ] **Step 2: Snapshot, restore, and check all three survived**

```bash
hobby snapshot blog
hobby snapshot list blog
hobby restore <id> --as blog-copy
hobby start blog-copy/primary
psql "$(hobby connection blog-copy/primary)" -c 'select v from t;'   # expect: survived
curl -s "$(hobby url blog-copy/api)/count"                            # expect: 3, NOT 1
hobby queue peek blog-copy/jobs                                       # expect: the message
```

The counter is the assertion that matters. `3` means the Durable Object storage
directory was renamed correctly. `1` means it was not, and the state is sitting
on disk under a key nothing will ever ask for: exactly the silent failure the DO
rename exists to prevent, and one that no fake-runtime test can catch.

- [ ] **Step 3: Check the original was not damaged**

```bash
psql "$(hobby connection blog/primary)" -c 'select v from t;'   # expect: survived
```

If `dataDir` was not rewritten, the restored copy has been writing into this
data directory. This is the check for the sharpest failure in the design.

- [ ] **Step 4: Measure, with the hardware written down**

Time a snapshot and a restore of a project with a real PGDATA in it, on APFS or
XFS, and again on ext4 if a box is available. Record filesystem, disk type,
dataset size, and both clone mechanisms. A timing without its hardware is a
rumour (`docs/CLAUDE.md`).

- [ ] **Step 5: File it**

Write `docs/backups/research/2026-08-16-snapshots-against-real-docker.md` with
what was run, what happened, and anything that disagreed with the spec. If
something did disagree, the spec gets an addendum rather than an edit: it is a
dated artifact, and the queues spec at
`docs/queues/specs/2026-08-13-queues-design.md` is the precedent for how that
reads.

- [ ] **Step 6: Flip the status lines and record the history**

- Spec: `Status: BUILT`, citing the research file.
- `docs/backups/CLAUDE.md`: `DESIGNED, not built` becomes `BUILT`.
- `claude_docs/ACTIVE_CONTEXT.md`: snapshots move out of "immediate next steps"
  into the state section, with the real test count and the measured numbers.
- `claude_docs/PROGRESS.md`: an append-only entry, dated, saying what it cost and
  what running it taught that the tests did not.

- [ ] **Step 7: Commit**

```bash
npm test && npm run build
git add docs/ claude_docs/
git commit -m "docs(backups): snapshots verified against real Docker, with the numbers"
```

---

## Self-Review

**Spec coverage.** Every section of the spec maps to a task: shape and seams to
Tasks 1 and 2, quiesce to Task 3, on-disk layout and manifest to Task 4, list
and delete to Task 5, restore's six rewrites to Task 6 and in-place to Task 7,
the daemon API to Task 8, the CLI to Task 9, schedule and retention and the free
space floor to Task 10, verification to Task 11, and the real-Docker run to Task
12. The spec's "what this deliberately does not build" list needs no task by
definition.

**Two things checked against the code rather than assumed**, both confirmed
before this plan was finished, both cited inline at the point of use:

1. `ResourceKindHandler.probe` exists with that exact name and returns
   `Promise<boolean>` (`packages/core/src/kinds.ts:82`).
2. Task 8's dispatch indices match `routes.ts:1755-1773`.

**One thing that is still an assumption**, called out because it is the only one
left: the fake runtime used by `queues.test.ts` and `kind-dispatch.test.ts` is
assumed to satisfy `probe` well enough for Task 11's happy-path test to pass. If
it does not, the fix is a fake handler in the test rather than a change to
`verifySnapshot`, because the production path must keep using the real probe.

**One accepted ordering wart.** Task 6 introduces a throwing `restoreInPlace`
stub that Task 7 replaces in full. The alternative was one very large task
covering both restore paths, and the two have genuinely different rules: the new
project path rewrites six fields, the in-place path rewrites none. Splitting them
is worth the stub, and the stub throws rather than returning something plausible.
