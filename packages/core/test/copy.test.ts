import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readdir, readFile, readlink, rm, symlink, writeFile } from 'node:fs/promises'
import { lstat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { promisify } from 'node:util'
import { cloneTree } from '../src/copy.js'

const execFileAsync = promisify(execFile)

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
