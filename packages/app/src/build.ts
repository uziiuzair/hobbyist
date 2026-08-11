// Building the user's Dockerfile, and the one policy that keeps a build from
// hurting everything else on the box.
//
// `docs/compute/CLAUDE.md` asked what stops a build from starving the box
// that is also serving a database. The answer is two boring mechanisms, both
// here: one build at a time, globally, and hard caps on the build container.
// A build that is slow is a nuisance. A build that makes a sleeping database
// miss its wake budget is a broken promise, so a build always loses.

import { existsSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { HobbyError, type BuildSpec, type ComputeRuntime } from '@hobby.sh/core'

// Deliberately conservative and not configurable yet. `--cpu-shares` is a
// relative weight against the default of 1024, so 512 means a build gets
// roughly half the CPU of anything else contending, rather than a hard cap
// that would make builds pointlessly slow on an idle box.
export const BUILD_MEMORY = '2g'
export const BUILD_CPU_SHARES = 512

// Global, process-wide, not per project. Two concurrent builds on a five
// dollar VPS is the case this exists for, and a per-project lock would not
// prevent it. Serialised through a promise chain rather than a semaphore
// because the daemon is one process and the queue depth is "however many
// deploys the operator typed", not a number worth managing.
let buildChain: Promise<unknown> = Promise.resolve()

export function withBuildLock<T>(fn: () => Promise<T>): Promise<T> {
  // Chained off a settled-either-way promise, so one failed build does not
  // wedge every build after it.
  const run = buildChain.then(fn, fn)
  buildChain = run.catch(() => undefined)
  return run
}

export interface AppSource {
  path: string
  dockerfile: string
}

// Resolves the Dockerfile the user meant and proves it exists before Docker
// is involved, so a typo is a clear error rather than a wall of build output.
export function resolveSource(source: AppSource): { contextPath: string; dockerfile: string } {
  const contextPath = resolve(source.path)
  if (!existsSync(contextPath)) {
    throw new HobbyError('usage', `build context does not exist: ${contextPath}`)
  }
  const dockerfile = isAbsolute(source.dockerfile) ? source.dockerfile : join(contextPath, source.dockerfile)
  if (!existsSync(dockerfile)) {
    throw new HobbyError(
      'usage',
      `no Dockerfile at ${dockerfile}`,
      'pass --dockerfile if it is not named Dockerfile at the root of the build context'
    )
  }
  return { contextPath, dockerfile }
}

// A tag that is unique per build and sortable by time. The previous tag is
// deliberately not deleted here: a deploy that builds successfully and then
// fails to serve needs an image to roll back to, and the only one guaranteed
// to have served is the one before it.
export function buildTag(project: string, resource: string, at: number): string {
  return `hobby/${project}-${resource}:${Math.floor(at / 1000)}`
}

export async function buildAppImage(
  runtime: ComputeRuntime,
  opts: { source: AppSource; tag: string }
): Promise<{ tag: string; logs: string }> {
  if (runtime.build === undefined) {
    throw new HobbyError(
      'runtime_unavailable',
      'this compute runtime cannot build images',
      'building from a Dockerfile needs a runtime that implements ComputeRuntime.build; bring a prebuilt image instead'
    )
  }
  const { contextPath, dockerfile } = resolveSource(opts.source)
  const spec: BuildSpec = {
    contextPath,
    dockerfile,
    tag: opts.tag,
    memory: BUILD_MEMORY,
    cpuShares: BUILD_CPU_SHARES,
  }
  const build = runtime.build.bind(runtime)
  const logs = await withBuildLock(() => build(spec))
  return { tag: opts.tag, logs }
}
