// The file lifecycle of Durable Object storage: deleting one object, and
// pruning a namespace whose class no longer exists in the manifest.
//
// These are the only functions in the package that write. Everything else
// observes. That asymmetry is deliberate, and so is the guard below.

import { existsSync, rmSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { HobbyError, openDatabase, type ResourceState } from '@hobby.sh/core'
import { ALARM_DB_FILENAME } from './alarms.js'

const OBJECT_ID_PATTERN = /^[0-9a-f]{64}$/

// The three files workerd may create per object. workerd.capnp:728-731:
// "one or more files are created for each object, with names `<id>.<ext>` ...
// the main storage is a file with the extension `.sqlite`, and in certain
// situations extra files with the extensions `.sqlite-wal`, and `.sqlite-shm`
// may also be present."
const OBJECT_EXTENSIONS = ['.sqlite', '.sqlite-wal', '.sqlite-shm'] as const

export interface MutationGuard {
  // The owning resource's state, read by the caller immediately before the
  // call. Same reasoning as packages/pg/src/activity-guard.ts refusing to
  // sleep a database mid-transaction: never mutate storage underneath a live
  // process. Unlinking a .sqlite that a running workerd holds open would
  // leave the runtime writing to an unlinked inode and the user watching
  // changes vanish at the next restart.
  state: ResourceState
}

function assertNotRunning(guard: MutationGuard, what: string): void {
  if (guard.state === 'running' || guard.state === 'starting') {
    throw new HobbyError(
      'conflict',
      `refusing to ${what} while the runtime is ${guard.state}`,
      'Stop the worker first. Durable Object storage must not be modified underneath a running runtime.'
    )
  }
}

// The id reaches this function from the CLI and from Studio, so it is
// untrusted input used to build a path. Without this check an id of
// "../../../../etc/passwd" would make deleteObject an arbitrary unlink.
// Validated before any filesystem call, not after.
function assertObjectId(actorId: string): void {
  if (!OBJECT_ID_PATTERN.test(actorId)) {
    throw new HobbyError(
      'invalid_name',
      `"${actorId}" is not a Durable Object id`,
      'An object id is 64 lowercase hex characters, matching the basename of its .sqlite file.'
    )
  }
}

// Removes one object: its main database, its sidecars, and its row in the
// namespace's alarm table.
//
// The alarm row matters as much as the files. A deleted object with a row left
// behind would wake the whole runtime at its deadline, workerd would
// reconstruct an empty object to run the handler, and the user would have a
// namespace that refuses to stay asleep for an object they deleted.
export function deleteObject(namespaceDir: string, actorId: string, guard: MutationGuard): void {
  assertObjectId(actorId)
  assertNotRunning(guard, `delete object ${actorId}`)

  // The alarm row first. If this throws, nothing has been unlinked yet and the
  // object is still whole; the other order could leave a scheduled wake for an
  // object whose files are gone, which is the failure this function exists to
  // avoid.
  clearAlarmRow(namespaceDir, actorId)

  for (const extension of OBJECT_EXTENSIONS) {
    const path = join(namespaceDir, `${actorId}${extension}`)
    // A sidecar is often absent, and an absent file is a successful delete.
    // Same forgiving contract as createDockerRuntime's remove(), where "no
    // such container" is success rather than failure.
    if (existsSync(path)) {
      unlinkSync(path)
    }
  }
}

function clearAlarmRow(namespaceDir: string, actorId: string): void {
  const dbPath = join(namespaceDir, ALARM_DB_FILENAME)
  if (!existsSync(dbPath)) {
    return
  }
  const db = openDatabase(dbPath)
  try {
    db.prepare('DELETE FROM _cf_ALARM WHERE actor_id = ?').run(actorId)
  } finally {
    db.close()
  }
}

// Removes a namespace's entire storage directory.
//
// Only ever called for a namespace whose class has disappeared from the
// worker's manifest and whose resource is therefore marked orphaned, and only
// as an explicit verb. ADR 0012 is deliberate that a manifest edit alone must
// never delete data: reconciliation marks, a human prunes. The one-way door
// gets a hand on it.
export function pruneNamespace(doRoot: string, uniqueKey: string, guard: MutationGuard): void {
  assertNotRunning(guard, `prune namespace ${uniqueKey}`)

  // Rejects "..", "a/b", and anything else that would climb out of doRoot,
  // for the same reason assertObjectId exists.
  if (uniqueKey.length === 0 || uniqueKey.includes('/') || uniqueKey.includes('\\') || uniqueKey.includes('..')) {
    throw new HobbyError('invalid_name', `"${uniqueKey}" is not a namespace directory name`)
  }

  const namespaceDir = join(doRoot, uniqueKey)
  if (!existsSync(namespaceDir)) {
    return
  }
  rmSync(namespaceDir, { recursive: true })
}
