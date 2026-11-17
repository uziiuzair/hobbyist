// The one primitive snapshots and Phase 1.5 branching share. Snapshots clone a
// whole project directory; ADR 0005's branching clones a single stopped PGDATA
// one level down. Two copiers would mean two ext4 fallbacks, and the second one
// would eventually be wrong.
//
// core must never import Docker, Postgres or HTTP (packages/core/src/types.ts,
// header comment). node:child_process does not violate that: the rule is
// about what this package talks to, not which node builtins it uses, and a
// subprocess that runs `cp` is none of Docker, Postgres or HTTP. It is used
// here, on darwin only, because Node's own COPYFILE_FICLONE_FORCE is ENOSYS
// on darwin (measured on this machine, node v24.19.0: it fails in
// os.tmpdir(), ~/.hobby and the repo worktree alike) while APFS cloning
// through `cp -c`/`cp -Rc` works fine, matching the platform split
// packages/cli/src/daemon/preflight.ts's detectReflinkSupport already uses
// and documents for the same reason: `cp -c` is APFS's clonefile path, `cp
// --reflink=always` is the Linux equivalent, and detection and execution
// must use the same mechanism or the product lies about itself.

import { constants } from 'node:fs'
import { copyFile, lstat, mkdir, readdir, readlink, rm, symlink } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

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
// throws on the first regular file or does not throw at all. Used for the
// non-darwin reflink attempt (a real Linux ioctl) and, with mode 0, for the
// plain-copy fallback shared by both platforms.
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

// Counts what `cp -Rc` already produced at dst. No copying happens here: the
// subprocess did that in one shot for the whole tree, so this is a stat-only
// walk applying the same counting rules copyEntry uses (a file adds one and
// its size, a symlink adds one and nothing, anything else is skipped).
async function tallyTree(path: string, tally: Tally): Promise<void> {
  const stat = await lstat(path)

  if (stat.isSymbolicLink()) {
    tally.files += 1
    return
  }

  if (stat.isDirectory()) {
    for (const entry of await readdir(path)) {
      await tallyTree(join(path, entry), tally)
    }
    return
  }

  if (!stat.isFile()) {
    return
  }

  tally.files += 1
  tally.bytes += stat.size
}

// The darwin reflink attempt: one subprocess clones the whole tree, rather
// than the per-file walk copyEntry does for the Linux ioctl, because darwin
// has no per-file Node API for this (COPYFILE_FICLONE_FORCE is ENOSYS
// there). BSD cp -R copies symlinks as symlinks rather than following them
// (see packages/core/test/copy.test.ts's symlink test, which exercises this
// path and pins that claim rather than trusting it), which preserves the
// guarantee copyEntry gives on every other platform.
//
// `cp -Rc src dst` fails outright when dst's parent does not exist yet
// (verified by hand: exits 1 with "No such file or directory"), unlike
// copyEntry's `mkdir(dst, { recursive: true })`, which creates every
// missing ancestor. Without creating it here first, that failure would fall
// into cloneTree's catch below and get reported as a plain copy on a
// filesystem that can reflink fine, which is the exact detection/execution
// mismatch this file exists to prevent. cloneTree's own guard against a
// pre-existing dst runs before this function is ever called, so dst itself
// is never created ahead of time here, only its parent.
//
// macOS cp -c falls back to a full copyfile(2) copy, without erroring, when
// the target filesystem does not support clonefile(2) (see cp(1)), so a
// successful cp -Rc here does not by itself prove a reflink happened on a
// non-APFS darwin mount. packages/cli/src/daemon/preflight.ts's
// detectReflinkSupport carries the same imprecision on darwin, for the same
// reason.
async function cloneTreeDarwin(src: string, dst: string): Promise<CloneResult> {
  await mkdir(dirname(dst), { recursive: true })
  await execFileAsync('cp', ['-Rc', src, dst])
  const tally: Tally = { files: 0, bytes: 0 }
  await tallyTree(dst, tally)
  return { mechanism: 'reflink', files: tally.files, bytes: tally.bytes }
}

// cloneTree's contract is "make dst a mirror of src," which only holds if
// dst starts out absent. Verified by hand: against a pre-existing empty
// dst, `cp -Rc src dst` exits 0 but nests src's contents one level deeper
// (dst/src/a.txt, not dst/a.txt) instead of mirroring into it, and on every
// other platform copyEntry would silently merge into whatever dst already
// held rather than reproduce src exactly. Checked once here, before either
// platform's path runs and outside the try below, so a violation is a loud
// rejection that leaves dst untouched, not a wrong tree shape, and not
// something the copy fallback quietly papers over by deleting dst first.
async function assertDestinationAbsent(dst: string): Promise<void> {
  try {
    await lstat(dst)
  } catch {
    return
  }
  throw new Error(`cloneTree: destination already exists: ${dst}`)
}

export async function cloneTree(src: string, dst: string): Promise<CloneResult> {
  await assertDestinationAbsent(dst)

  try {
    if (process.platform === 'darwin') {
      return await cloneTreeDarwin(src, dst)
    }
    const tally: Tally = { files: 0, bytes: 0 }
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

// ---------------------------------------------------------------------------
// Copying and removing trees the daemon does not own.
//
// On Linux the files a container writes into a bind mount belong to the
// container's user, not to whoever runs the daemon: a PGDATA is owned by the
// postgres image's uid (70 on alpine) with mode 0700, and a worker's state
// directory fills with root-owned files. A daemon running as an ordinary
// user in the docker group (a supported setup: the install guide says to add
// the user to the group, and scripts/hobby.service says User= may be
// changed) then gets EACCES from both cloneTree and fs.rm. On macOS Docker
// Desktop masks the uid and the daemon owns everything it sees, and a root
// daemon can read and remove anything, so in both of those cases the native
// operation succeeds and nothing below changes behaviour.
//
// copyTree and removeTree try the native operation first and, only on
// EACCES or EPERM, hand the same operation to an ElevatedTreeOps: something
// able to act as root. core does not know how that is done; the Docker
// implementation is createContainerTreeOps (docker.ts), which runs cp -a or
// rm -rf in a throwaway root container. Injectable so the fallback logic is
// tested without Docker (packages/core/test/copy.test.ts).

export interface ElevatedTreeOps {
  // Same contract as cloneTree: dst must not exist, its parent does, and the
  // result reports the mechanism honestly. Ownership and modes must be
  // preserved, because Postgres refuses a PGDATA with the wrong owner or a
  // mode other than 0700 or 0750.
  clone(src: string, dst: string): Promise<CloneResult>
  // rm -rf: a path that does not exist is not an error.
  remove(path: string): Promise<void>
}

export interface TreeOptions {
  // Null or absent means there is no way to act as root, and a permission
  // error is thrown as it was before this existed.
  elevated?: ElevatedTreeOps | null
}

export function isPermissionError(err: unknown): boolean {
  if (err === null || typeof err !== 'object') {
    return false
  }
  const code = (err as { code?: unknown }).code
  return code === 'EACCES' || code === 'EPERM'
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

// Both failures go into one message, with the native error's code kept, so
// a caller that tests for EACCES still sees it and the person reading the
// error learns which path was refused and why the retry did not help.
function bothFailed(action: string, native: unknown, fallback: unknown): Error {
  const err = new Error(
    `${action} failed: ${messageOf(native)}; retrying as root in a container also failed: ${messageOf(fallback)}`,
    { cause: fallback }
  )
  const code = (native as { code?: unknown }).code
  if (typeof code === 'string') {
    Object.assign(err, { code })
  }
  return err
}

export async function removeTree(path: string, opts: TreeOptions = {}): Promise<void> {
  try {
    await rm(path, { recursive: true, force: true })
    return
  } catch (err: unknown) {
    if (!isPermissionError(err) || !opts.elevated) {
      throw err
    }
    // Whatever rm managed to delete before it was refused is gone, which is
    // fine: the instruction was to remove all of it, and the container
    // finishes the job.
    try {
      await opts.elevated.remove(path)
    } catch (fallbackErr: unknown) {
      throw bothFailed(`removing ${path}`, err, fallbackErr)
    }
  }
}

export async function copyTree(src: string, dst: string, opts: TreeOptions = {}): Promise<CloneResult> {
  try {
    return await cloneTree(src, dst)
  } catch (err: unknown) {
    if (!isPermissionError(err) || !opts.elevated) {
      throw err
    }
    // cloneTree's plain-copy retry stopped at the first unreadable entry and
    // left what it had written so far, all of it owned by the daemon. It
    // goes before the container copies, which refuses an existing dst for
    // the same reason cloneTree does.
    try {
      await removeTree(dst, opts)
      await mkdir(dirname(dst), { recursive: true })
      return await opts.elevated.clone(src, dst)
    } catch (fallbackErr: unknown) {
      throw bothFailed(`copying ${src} to ${dst}`, err, fallbackErr)
    }
  }
}
