// Building the user's Dockerfile, and the one policy that keeps a build from
// hurting everything else on the box.
//
// `docs/compute/CLAUDE.md` asked what stops a build from starving the box
// that is also serving a database. The honest answer, after issue #150, is
// one mechanism: one build at a time, globally (core's withBuildLock, which
// the worker kind shares since issue #83). The `--memory=2g` and
// `--cpu-shares=512` caps this file used to pass were accepted and ignored
// by `docker build` under BuildKit, so they were a promise the box was not
// keeping, and they are gone rather than kept for show.

import { existsSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { buildQueuedNote, HobbyError, withBuildLock, type BuildSpec, type ComputeRuntime } from '@hobby.sh/core'

// Re-exported so existing imports from this package keep resolving; the
// implementation moved to @hobby.sh/core (build-lock.ts) so the worker kind
// could take the same lock without depending on the app package.
export { withBuildLock }

export interface AppSource {
  path: string
  dockerfile: string
  buildArgs?: Record<string, string>
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

// The repository every tag of one app lands under. Named separately from
// buildTag because destroyApp removes everything under it and deployApp
// prunes it (issue #84): both need the repository, not a tag.
export function buildRepository(project: string, resource: string): string {
  return `hobby/${project}-${resource}`
}

// A tag that is unique per build and sortable by time. The previous tag is
// deliberately not deleted here: a deploy that builds successfully and then
// fails to serve needs an image to roll back to, and the only one guaranteed
// to have served is the one before it. Once the new one has served,
// deployApp keeps the newest few and removes the rest (pruneImageTags).
export function buildTag(project: string, resource: string, at: number): string {
  return `${buildRepository(project, resource)}:${Math.floor(at / 1000)}`
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
    ...(opts.source.buildArgs === undefined || Object.keys(opts.source.buildArgs).length === 0
      ? {}
      : { buildArgs: opts.source.buildArgs }),
  }
  const build = runtime.build.bind(runtime)
  let queued = ''
  const logs = await withBuildLock(() => build(spec), {
    onWait: (buildsAhead) => {
      queued = buildQueuedNote(buildsAhead)
    },
  })
  return { tag: opts.tag, logs: `${queued}${logs}` }
}
