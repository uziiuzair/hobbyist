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
