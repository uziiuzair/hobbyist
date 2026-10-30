// What "Create a project" does, as one function with no React in it, so the
// sequence can be tested against a fake API and so it stays the same
// sequence `hobby new` runs (packages/cli/src/cli/commands.ts, cmdNew).
//
// Three calls, one promise, and a rollback: create the project, create its
// default postgres, and if the postgres fails, delete the project that was
// just made so the user is not left with a name they cannot reuse and did
// not ask for. `hobby new <name>` does exactly this, for exactly the reason
// cmdNew's comment gives: a half-finished result is a failure that has to
// clean up after itself, or the obvious next step (trying again) answers
// 409 name_taken.
//
// `empty` is `hobby new --empty`: a project and nothing in it. No postgres
// is created, so there is nothing to roll back if nothing past
// createProject was attempted. `--pin` is deliberately not offered here;
// Studio's form asks for a name and whether to start empty, and pinning is
// a sleep-policy decision the project page already owns.

import type { Project, Resource } from '@hobby.sh/core'

// The CLI's DEFAULT_POSTGRES_NAME (packages/core/src/names.ts). Spelled out
// rather than imported because the Studio bundle takes only types from
// @hobby.sh/core (see api.ts's import comment); the api test pins the value.
export const DEFAULT_POSTGRES_NAME = 'primary'

export interface ProjectCreator {
  createProject(name: string): Promise<{ project: Project }>
  createResource(projectName: string, name: string): Promise<{ resource: Resource }>
  deleteProject(name: string, opts?: { force?: boolean }): Promise<{ deleted: true }>
}

export interface CreateProjectOptions {
  empty?: boolean
}

export async function createProjectWithDefaults(
  api: ProjectCreator,
  name: string,
  options: CreateProjectOptions = {},
): Promise<{ project: Project; resource: Resource | null }> {
  const { project } = await api.createProject(name)
  if (options.empty === true) return { project, resource: null }

  try {
    const { resource } = await api.createResource(project.name, DEFAULT_POSTGRES_NAME)
    return { project, resource }
  } catch (err) {
    // Only ever rolls back a project this call created: createProject would
    // have failed with name_taken if it already existed, so there is no path
    // here that deletes someone's existing work. The original failure is the
    // one worth reporting, so a failed rollback is attached to it rather
    // than replacing it.
    try {
      await api.deleteProject(project.name)
    } catch (cleanupErr) {
      const detail = cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)
      const original = err instanceof Error ? err.message : String(err)
      throw new Error(
        `${original}. The project ${project.name} could not be rolled back (${detail}); remove it with hobby rm ${project.name}`,
      )
    }
    throw err
  }
}
