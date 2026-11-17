import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readdir, readFile, readlink, rm, symlink, writeFile } from 'node:fs/promises'
import { lstat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { promisify } from 'node:util'
import { isDiskFullError } from '../src/errors.js'
import { cloneTree, copyTree, isPermissionError, removeTree, type ElevatedTreeOps } from '../src/copy.js'

const execFileAsync = promisify(execFile)

const roots: string[] = []
after(async () => {
  await unlockAll()
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
// mechanism cloneTree and packages/cli/src/daemon/preflight.ts's
// detectReflinkSupport use (cp -c on darwin, cp --reflink=always
// elsewhere), so the assertion below is not a guess about the machine the
// test happens to run on. A COPYFILE_FICLONE_FORCE probe would agree with
// the bug this test exists to catch: that flag is unimplemented on darwin
// (ENOSYS in every location tested on this machine), which is exactly why
// cloneTree no longer uses it there.
async function reflinkWorksIn(dir: string): Promise<boolean> {
  const a = join(dir, 'probe-a')
  const b = join(dir, 'probe-b')
  await writeFile(a, 'probe', 'utf8')
  try {
    if (process.platform === 'darwin') {
      await execFileAsync('cp', ['-c', a, b])
    } else {
      await execFileAsync('cp', ['--reflink=always', a, b])
    }
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

// This is the case that motivated the fix: a real project directory is a
// nested tree, not a single flat file, and it is the whole-tree clone (not
// a per-file one) that must agree with what the platform's own clone tool
// reports for that directory. Before this fix, cloneTree walked the tree
// with COPYFILE_FICLONE_FORCE, which is ENOSYS on darwin, so it silently
// took the copy fallback on every macOS run while claiming nothing was
// wrong; this test pins the corrected, tree-shaped behaviour so the same
// drift cannot come back unnoticed.
test('cloneTree on a nested tree agrees with the platform clone tool', async () => {
  const root = await scratch()
  const src = join(root, 'src')
  const dst = join(root, 'dst')
  await mkdir(join(src, 'nested'), { recursive: true })
  await writeFile(join(src, 'top.txt'), 'top', 'utf8')
  await writeFile(join(src, 'nested', 'inner.txt'), 'inner', 'utf8')
  await symlink('top.txt', join(src, 'link.txt'))

  const expected = (await reflinkWorksIn(root)) ? 'reflink' : 'copy'
  const result = await cloneTree(src, dst)

  assert.equal(result.mechanism, expected)
})

// Every test above puts dst under a root that mkdtemp already created, so
// dst's own parent always exists. A real caller does not get that for free:
// packages/cli/src/daemon/snapshots.ts's takeSnapshot clones into
// join(partialDir, 'data'), and only partialDir, not partialDir/data, is
// created before cloneTree runs. Verified by hand: `cp -Rc src
// no-such-parent/dst` exits 1 with "No such file or directory" when
// no-such-parent does not exist. Before this fix that failure fell into
// cloneTree's catch and reported mechanism: 'copy' purely because the
// parent had not been created yet, on a filesystem that can reflink fine.
test('cloneTree creates the destination parent when it does not exist yet', async () => {
  const root = await scratch()
  const src = join(root, 'src')
  const dst = join(root, 'no-such-parent', 'dst')
  await mkdir(src, { recursive: true })
  await writeFile(join(src, 'a.txt'), 'a', 'utf8')

  const expected = (await reflinkWorksIn(root)) ? 'reflink' : 'copy'
  const result = await cloneTree(src, dst)

  assert.equal(result.mechanism, expected)
  assert.equal(await readFile(join(dst, 'a.txt'), 'utf8'), 'a')
})

// Verified by hand: against a pre-existing empty dst, `cp -Rc src dst`
// exits 0 but nests src's contents one level deeper, producing
// dst/src/a.txt rather than dst/a.txt. copyEntry, used on every other
// platform and in the copy fallback, always mirrors src's contents
// directly into dst instead. cloneTree's contract is "make dst a mirror of
// src," which only holds if dst starts out absent, so a pre-existing dst
// must be a loud rejection rather than a silently wrong tree shape (or,
// worse, a copy fallback that first deletes whatever was already at dst).
// Nothing is created or removed at dst before the throw.
test('cloneTree rejects rather than silently nesting into an existing destination', async () => {
  const root = await scratch()
  const src = join(root, 'src')
  const dst = join(root, 'dst')
  await mkdir(src, { recursive: true })
  await writeFile(join(src, 'a.txt'), 'a', 'utf8')
  await mkdir(dst, { recursive: true })
  await writeFile(join(dst, 'sentinel.txt'), 'untouched', 'utf8')

  await assert.rejects(() => cloneTree(src, dst))

  assert.deepEqual(await readdir(dst), ['sentinel.txt'])
})

// ---------------------------------------------------------------------------
// copyTree and removeTree: the native operation first, the elevated fallback
// only on EACCES or EPERM. The refusals here are real ones, made with chmod,
// so the test exercises the same errno a non-root daemon on Linux gets from
// a container-owned PGDATA. root ignores directory modes, so they are
// skipped when the suite runs as root.

const asRoot = typeof process.getuid === 'function' && process.getuid() === 0

// Directories this block locked, so after() can unlock them before the
// shared cleanup removes the scratch roots.
const locked: string[] = []
async function unlockAll(): Promise<void> {
  for (const dir of locked) {
    await chmod(dir, 0o755).catch(() => undefined)
  }
}

async function lock(dir: string, mode: number): Promise<void> {
  locked.push(dir)
  await chmod(dir, mode)
}

interface FakeElevated extends ElevatedTreeOps {
  clones: Array<{ src: string; dst: string; dstExisted: boolean; parentExisted: boolean }>
  removes: string[]
}

function fakeElevated(opts: { fail?: Error } = {}): FakeElevated {
  const fake: FakeElevated = {
    clones: [],
    removes: [],
    async clone(src, dst) {
      const exists = async (p: string): Promise<boolean> =>
        lstat(p).then(
          () => true,
          () => false
        )
      fake.clones.push({ src, dst, dstExisted: await exists(dst), parentExisted: await exists(join(dst, '..')) })
      if (opts.fail) throw opts.fail
      await mkdir(dst)
      await writeFile(join(dst, 'copied-as-root'), 'x')
      return { mechanism: 'copy', files: 7, bytes: 70 }
    },
    async remove(path) {
      fake.removes.push(path)
      if (opts.fail) throw opts.fail
      await unlockAll()
      await rm(path, { recursive: true, force: true })
    },
  }
  return fake
}

// A tree like a Linux PGDATA seen by a non-root daemon: the top is readable,
// and one directory inside is not.
async function treeWithUnreadableDir(root: string): Promise<string> {
  const src = join(root, 'pgdata')
  await mkdir(join(src, '18', 'docker'), { recursive: true })
  await writeFile(join(src, 'readable.txt'), 'ok')
  await writeFile(join(src, '18', 'docker', 'PG_VERSION'), '18')
  await lock(join(src, '18', 'docker'), 0o000)
  return src
}

test('isPermissionError matches EACCES and EPERM only', () => {
  assert.equal(isPermissionError(Object.assign(new Error('x'), { code: 'EACCES' })), true)
  assert.equal(isPermissionError(Object.assign(new Error('x'), { code: 'EPERM' })), true)
  assert.equal(isPermissionError(Object.assign(new Error('x'), { code: 'ENOENT' })), false)
  assert.equal(isPermissionError(null), false)
  assert.equal(isPermissionError('EACCES'), false)
})

test('copyTree does not touch the fallback when the native copy works', async () => {
  const root = await scratch()
  await mkdir(join(root, 'src'))
  await writeFile(join(root, 'src', 'a.txt'), 'hello')
  const elevated = fakeElevated()

  const result = await copyTree(join(root, 'src'), join(root, 'out', 'dst'), { elevated })

  assert.equal(await readFile(join(root, 'out', 'dst', 'a.txt'), 'utf8'), 'hello')
  assert.equal(result.files, 1)
  assert.deepEqual(elevated.clones, [])
})

test('copyTree retries in the fallback on EACCES, after clearing the partial copy', { skip: asRoot }, async () => {
  const root = await scratch()
  const src = await treeWithUnreadableDir(root)
  const dst = join(root, 'branch', 'primary', 'pgdata')
  const elevated = fakeElevated()

  const result = await copyTree(src, dst, { elevated })

  assert.deepEqual(result, { mechanism: 'copy', files: 7, bytes: 70 })
  assert.equal(elevated.clones.length, 1)
  assert.equal(elevated.clones[0]?.src, src)
  assert.equal(elevated.clones[0]?.dst, dst)
  // The native attempt's half-copied tree was gone before the fallback ran,
  // and the parent the fallback mounts was there.
  assert.equal(elevated.clones[0]?.dstExisted, false)
  assert.equal(elevated.clones[0]?.parentExisted, true)
  assert.deepEqual(await readdir(dst), ['copied-as-root'])
})

test('copyTree without a fallback throws the native EACCES unchanged', { skip: asRoot }, async () => {
  const root = await scratch()
  const src = await treeWithUnreadableDir(root)

  await assert.rejects(copyTree(src, join(root, 'dst')), (err: NodeJS.ErrnoException) => {
    assert.equal(err.code, 'EACCES')
    return true
  })
})

test('copyTree does not use the fallback for errors that are not permission errors', async () => {
  const root = await scratch()
  const elevated = fakeElevated()

  await assert.rejects(copyTree(join(root, 'missing'), join(root, 'dst'), { elevated }), (err: NodeJS.ErrnoException) => {
    assert.equal(err.code, 'ENOENT')
    return true
  })
  assert.deepEqual(elevated.clones, [])
})

test('a failed fallback copy names both paths and keeps the EACCES code', { skip: asRoot }, async () => {
  const root = await scratch()
  const src = await treeWithUnreadableDir(root)
  const dst = join(root, 'dst')
  const elevated = fakeElevated({ fail: new Error('no local image to run it in (tried postgres:18-alpine)') })

  await assert.rejects(copyTree(src, dst, { elevated }), (err: NodeJS.ErrnoException) => {
    assert.equal(err.code, 'EACCES')
    assert.match(err.message, new RegExp(`copying ${src} to ${dst} failed: EACCES`))
    assert.match(err.message, /retrying as root in a container also failed: no local image/)
    return true
  })
})

test('removeTree does not touch the fallback when the native rm works', async () => {
  const root = await scratch()
  await mkdir(join(root, 'gone', 'deep'), { recursive: true })
  const elevated = fakeElevated()

  await removeTree(join(root, 'gone'), { elevated })
  await removeTree(join(root, 'never-existed'), { elevated })

  assert.deepEqual(await readdir(root), [])
  assert.deepEqual(elevated.removes, [])
})

test('removeTree finishes in the fallback when rm is refused', { skip: asRoot }, async () => {
  const root = await scratch()
  const target = join(root, 'project')
  await mkdir(join(target, 'state', 'cache'), { recursive: true })
  await writeFile(join(target, 'state', 'cache', 'blob'), 'x')
  // A directory the daemon cannot write to: its entries cannot be unlinked,
  // the same refusal a root-owned miniflare cache directory gives.
  await lock(join(target, 'state', 'cache'), 0o555)
  const elevated = fakeElevated()

  await removeTree(target, { elevated })

  assert.deepEqual(elevated.removes, [target])
  assert.deepEqual(await readdir(root), [])
})

test('a failed fallback removal names the path and keeps the EACCES code', { skip: asRoot }, async () => {
  const root = await scratch()
  const target = join(root, 'project')
  await mkdir(join(target, 'locked'), { recursive: true })
  await writeFile(join(target, 'locked', 'file'), 'x')
  await lock(join(target, 'locked'), 0o555)

  await assert.rejects(removeTree(target, { elevated: fakeElevated({ fail: new Error('docker unreachable') }) }), (err: NodeJS.ErrnoException) => {
    assert.equal(err.code, 'EACCES')
    assert.match(err.message, new RegExp(`removing ${target} failed`))
    assert.match(err.message, /docker unreachable/)
    return true
  })
  await assert.rejects(removeTree(target), (err: NodeJS.ErrnoException) => err.code === 'EACCES')
})

test('a full disk inside the fallback copy is still recognised as a full disk', { skip: asRoot }, async () => {
  const root = await scratch()
  const src = await treeWithUnreadableDir(root)
  const elevated = fakeElevated({ fail: new Error("docker run exited with an error: cp: write error: No space left on device") })

  await assert.rejects(copyTree(src, join(root, 'dst'), { elevated }), (err: unknown) => isDiskFullError(err))
})
