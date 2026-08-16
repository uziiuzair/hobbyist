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
