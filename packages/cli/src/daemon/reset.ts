// Resetting a branch to its parent: every postgres resource in the branch
// gets a fresh clone of its parent's same-named resource, under the branch's
// own name, resource ids, container names and host ports. Neon calls this
// "reset from parent". Here it is the branching clone (cloneSourceAtRest,
// branch.ts) pointed at a staging directory, and then the in-place swap
// restoreInPlace (snapshots.ts) already does for a snapshot.
//
// What it destroys is the branch's own data, which is why the CLI asks for
// the branch's name to be typed back (or --yes) and the MCP tool needs
// confirm: true, the same gate `hobby rm` has. The parent is only read.
//
// Order, and why:
//   1. Every refusal, before anything is stopped or written: the branch must
//      record a parent that still exists, both must be managed, the
//      parent's resources must be cloneable (branch.ts's rules), and the two
//      sets of postgres resources must match by name. The pinned guard runs
//      for both projects, since either may be paused.
//   2. Clone the parent into a staging directory beside each of the
//      branch's data directories, through exactly the sequence `hobby
//      branch` uses: an awake parent is quiesced and resumed, and the pause
//      is reported. The branch is untouched and may be serving throughout,
//      so on ext4, where this is a full copy, nothing of the branch's is down
//      while it runs.
//   3. Hold the branch asleep (holdProjectAsleep, context.ts) and quiesce
//      it, with the same activity guard and fail-loudly rule a snapshot
//      uses: a branch with a session in use is refused rather than cut off.
//   4. Swap each data directory aside and the staging one in. Renames in
//      one directory, so atomic, and the old data is never copied or
//      deleted on the way. If a rename fails, every swap already made is
//      undone.
//   5. Rebind each resource to its new data (rebindPostgresToClone,
//      packages/pg/src/postgres.ts): credentials and image from the parent,
//      everything else kept.
//   6. Resume what was running, then release the hold.
//   7. Only when every resource came back is the set-aside data deleted.
//      Until then it stays at <dataDir>.pre-reset and its path is returned,
//      the rule restoreInPlace keeps for the same reason: nothing here is the
//      only copy of anything until the reset has been seen to work.
//
// Resources of other kinds in the branch (an app someone deployed into it,
// say) are left exactly as they are, apart from being stopped and started
// with the rest of the branch by quiesce and resume. Their rows, config and
// state are not the parent's to replace, and an app bound to one of the
// branch's databases stays bound to it, because the resource ids do not
// change.

import { lstat, rename, rm } from 'node:fs/promises'
import {
  cloneTree,
  HobbyError,
  type CloneMechanism,
  type CloneResult,
  type PostgresResource,
  type Project,
  type Resource,
  type ResourceId,
} from '@hobby.sh/core'
import { rebindPostgresToClone } from '@hobby.sh/pg'
import {
  assertPauseAllowed,
  cloneableSourceResources,
  cloneSourceAtRest,
  refuseReleasedSource,
  type CloneAtRestResult,
} from './branch.js'
import { holdProjectAsleep, type DaemonContext } from './context.js'
import { quiesce, resume, type QuiesceOptions } from './snapshots.js'

export interface ResetOptions {
  // The pinned-project guard's override, for the parent and the branch
  // alike: either may be paused, and one flag accepting both is what `hobby
  // branch --allow-pause` already means for a source.
  allowPause?: boolean
  // Forwarded to both quiesces (the parent's and the branch's): a test seam,
  // as in BranchOptions.
  quiesce?: QuiesceOptions
  clone?: (src: string, dst: string) => Promise<CloneResult>
  now?: () => number
}

export interface ResetResult {
  project: Project
  parent: Project
  resources: Resource[]
  // 'copy' if any resource degraded to a byte copy, as in BranchResult.
  clone: CloneMechanism
  // The parent's pause, exactly as `hobby branch` reports a source's.
  parentPaused: string[]
  parentPausedMs: number | null
  parentResumeFailures: string[]
  // The branch's own pause: what was running in it and stopped for the
  // swap, and the wall time from the start of quiescing to the end of
  // resuming. An upper bound for the same reason BranchResult.pausedMs is.
  paused: string[]
  pausedMs: number | null
  // Branch resources that did not come back on the new data, and any that
  // could not be rebound to it. The new data is in place either way.
  restartFailures: string[]
  // The branch's previous data directories, still on disk because something
  // above failed or because removing them did (on Linux a PGDATA belongs to
  // the container's uid). Empty on a clean reset.
  preResetDirs: string[]
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch {
    return false
  }
}

function stagingDirFor(resource: PostgresResource): string {
  return `${resource.config.dataDir}.reset-staging`
}

function asideDirFor(resource: PostgresResource): string {
  return `${resource.config.dataDir}.pre-reset`
}

interface Pair {
  branch: PostgresResource
  parent: PostgresResource
}

// Step 1. Returns the projects and the resource pairs, matched by name.
function preflight(
  ctx: DaemonContext,
  branchName: string,
  allowPause: boolean
): { branch: Project; parent: Project; pairs: Pair[]; parentResources: PostgresResource[] } {
  const branch = ctx.store.getProjectByName(branchName)
  if (branch === null) {
    throw new HobbyError('project_not_found', `no project named ${branchName}`, 'run `hobby ls` to see what exists')
  }
  refuseReleasedSource(branch)

  if (branch.parentId === null) {
    throw new HobbyError(
      'conflict',
      `project ${branchName} has no recorded parent, so there is nothing to reset it to`,
      'only a project made with `hobby branch` has a parent, and branches made before hobby recorded parents ' +
        '(2026-11-17) do not; `hobby branch <parent> <new-name>` makes one that can be reset'
    )
  }
  const parent = ctx.store.getProject(branch.parentId)
  if (parent === null) {
    throw new HobbyError(
      'conflict',
      `the project ${branchName} was branched from no longer exists, so there is nothing to reset it to`,
      `${branchName} is an ordinary project now; \`hobby rm ${branchName}\` removes it`
    )
  }
  refuseReleasedSource(parent)
  const parentResources = cloneableSourceResources(ctx, parent)

  const all = ctx.store.listResources(branch.id)
  const branchPostgres = all.filter((resource): resource is PostgresResource => resource.kind === 'postgres')
  const parentNames = new Set(parentResources.map((resource) => resource.name))
  const branchNames = new Set(branchPostgres.map((resource) => resource.name))
  const onlyParent = parentResources.filter((resource) => !branchNames.has(resource.name)).map((r) => r.name)
  const onlyBranch = branchPostgres.filter((resource) => !parentNames.has(resource.name)).map((r) => r.name)
  // A database added to the branch since has no parent to reset to, and one
  // added to the parent has no resource in the branch to land in. Guessing
  // at either (emptying the first, inventing the second) is a reset that
  // quietly does something nobody asked for, so both are refused.
  if (onlyParent.length > 0 || onlyBranch.length > 0) {
    const changes = [
      ...(onlyParent.length > 0 ? [`only in ${parent.name}: ${onlyParent.join(', ')}`] : []),
      ...(onlyBranch.length > 0 ? [`only in ${branchName}: ${onlyBranch.join(', ')}`] : []),
    ]
    throw new HobbyError(
      'conflict',
      `${branchName} and ${parent.name} no longer hold the same postgres resources (${changes.join('; ')})`,
      `reset replaces each database with its namesake in the parent; branch again instead: hobby branch ${parent.name} <new-name>`
    )
  }

  const unsettled = all.filter(
    (resource) => resource.kind === 'postgres' && resource.state !== 'running' && resource.state !== 'sleeping'
  )
  if (unsettled.length > 0) {
    throw new HobbyError(
      'conflict',
      `cannot reset ${branchName} while ${unsettled.map((r) => `${r.name} is ${r.state}`).join(', ')}`,
      'retry once it is running or asleep'
    )
  }

  // Both projects can be paused, and the guard applies to each on its own
  // terms. For the branch, every running resource that quiesce would stop
  // counts, apart from a queue, whose stop is a no-op (the same exemption
  // refusePausingPinned in routes.ts makes).
  assertPauseAllowed(
    parent,
    parentResources.filter((resource) => resource.state === 'running'),
    allowPause,
    `resetting ${branchName} from it`
  )
  assertPauseAllowed(
    branch,
    all.filter((resource) => resource.state === 'running' && resource.kind !== 'queue'),
    allowPause,
    'resetting it'
  )

  const byName = new Map(branchPostgres.map((resource) => [resource.name, resource]))
  const pairs = parentResources.map((resource) => ({ branch: byName.get(resource.name) as PostgresResource, parent: resource }))
  return { branch, parent, pairs, parentResources }
}

export async function resetBranch(ctx: DaemonContext, branchName: string, opts: ResetOptions = {}): Promise<ResetResult> {
  const now = opts.now ?? Date.now
  const clone = opts.clone ?? cloneTree
  const { branch, parent, pairs, parentResources } = preflight(ctx, branchName, opts.allowPause === true)

  // Never deleted on our own initiative, the rule restoreInPlace keeps for
  // its own set-aside directory: one under this name is the data an earlier
  // reset replaced and did not finish with, and it may be the only copy.
  for (const { branch: resource } of pairs) {
    if (await pathExists(asideDirFor(resource))) {
      throw new HobbyError(
        'conflict',
        `${asideDirFor(resource)} already exists`,
        'it holds the data an earlier reset replaced and did not finish with. Move it somewhere safe, or delete it once you know nothing in it is needed'
      )
    }
  }

  // A staging directory was never swapped in, so it is a leftover from a
  // reset that died during step 2 and holds nothing the parent does not.
  const staging = pairs.map(({ branch: resource }) => stagingDirFor(resource))
  for (const dir of staging) {
    await rm(dir, { recursive: true, force: true })
  }

  const branchOf = new Map(pairs.map((pair) => [pair.parent.id, pair.branch]))
  let cloned: CloneAtRestResult
  try {
    cloned = await cloneSourceAtRest(ctx, parent, parentResources, {
      destination: (resource) => stagingDirFor(branchOf.get(resource.id) as PostgresResource),
      label: 'reset',
      ...(opts.quiesce === undefined ? {} : { quiesce: opts.quiesce }),
      clone,
      now,
    })
  } catch (err: unknown) {
    for (const dir of staging) {
      await rm(dir, { recursive: true, force: true })
    }
    throw err
  }

  const stopped: ResourceId[] = []
  const swapped: Pair[] = []
  const restartFailures: string[] = []
  let pauseStartedAt: number | null = null
  let pausedMs: number | null = null
  let release: (() => void) | null = null
  try {
    release = holdProjectAsleep(ctx, branch.id, branch.name)
    const running = ctx.store.listResources(branch.id).filter((resource) => resource.state === 'running')
    if (running.length > 0) {
      pauseStartedAt = now()
    }
    await quiesce(ctx, branch, { ...opts.quiesce, onStopped: (id) => stopped.push(id) })

    try {
      for (const pair of pairs) {
        const live = pair.branch.config.dataDir
        const hadLive = await pathExists(live)
        if (hadLive) {
          await rename(live, asideDirFor(pair.branch))
        }
        try {
          await rename(stagingDirFor(pair.branch), live)
        } catch (err: unknown) {
          if (hadLive) {
            await rename(asideDirFor(pair.branch), live)
          }
          throw err
        }
        swapped.push(pair)
      }
    } catch (err: unknown) {
      // Undo every completed swap, newest first, so the branch is left on
      // exactly the data it had. Each undo is attempted even if an earlier
      // one fails; a failure here is reported by naming the directories.
      const undoFailures: string[] = []
      for (const pair of [...swapped].reverse()) {
        try {
          await rename(pair.branch.config.dataDir, stagingDirFor(pair.branch))
          await rename(asideDirFor(pair.branch), pair.branch.config.dataDir)
        } catch (undoErr: unknown) {
          undoFailures.push(`${pair.branch.name}: ${errorMessage(undoErr)}`)
        }
      }
      swapped.length = 0
      if (undoFailures.length > 0) {
        throw new HobbyError(
          'internal',
          `resetting ${branch.name} failed (${errorMessage(err)}), and putting its data back also failed: ${undoFailures.join('; ')}`,
          'its previous data is at <data directory>.pre-reset for each resource named; nothing was deleted'
        )
      }
      throw err
    }

    for (const pair of pairs) {
      const current = ctx.store.getResource(pair.branch.id)
      if (current === null || current.kind !== 'postgres') {
        continue
      }
      try {
        await rebindPostgresToClone(ctx, { project: branch, resource: current, source: pair.parent.config })
      } catch (err: unknown) {
        restartFailures.push(`rebind ${pair.branch.name}: ${errorMessage(err)}`)
      }
    }
  } catch (err: unknown) {
    for (const dir of staging) {
      await rm(dir, { recursive: true, force: true })
    }
    throw err
  } finally {
    // resume never throws (snapshots.ts), which is what makes an unguarded
    // await safe in a finally that may be carrying an error.
    const failures = await resume(ctx, stopped)
    for (const failure of failures) {
      console.error(`reset: ${failure}`)
    }
    restartFailures.push(...failures)
    if (pauseStartedAt !== null) {
      pausedMs = now() - pauseStartedAt
    }
    release?.()
  }

  const preResetDirs: string[] = []
  for (const pair of swapped) {
    const aside = asideDirFor(pair.branch)
    if (!(await pathExists(aside))) {
      continue
    }
    if (restartFailures.length > 0) {
      preResetDirs.push(aside)
      continue
    }
    try {
      await rm(aside, { recursive: true, force: true })
    } catch (err: unknown) {
      // The reset has succeeded by now; the leftover is reported, not turned
      // into a failure, as restoreInPlace does.
      console.error(`reset: could not remove ${aside}: ${errorMessage(err)}`)
      preResetDirs.push(aside)
    }
  }

  return {
    project: ctx.store.getProject(branch.id) ?? branch,
    parent,
    resources: ctx.store.listResources(branch.id),
    clone: cloned.clone,
    parentPaused: cloned.paused,
    parentPausedMs: cloned.pausedMs,
    parentResumeFailures: cloned.resumeFailures,
    paused: stopped
      .map((id) => ctx.store.getResource(id)?.name)
      .filter((name): name is string => name !== undefined),
    pausedMs,
    restartFailures,
    preResetDirs,
  }
}
