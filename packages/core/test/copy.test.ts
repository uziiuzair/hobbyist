import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { copyFile, mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from 'node:fs/promises'
import { lstat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { cloneTree } from '../src/copy.js'

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
// mechanism cloneTree uses, so the assertion below is not a guess about the
// machine the test happens to run on.
async function reflinkWorksIn(dir: string): Promise<boolean> {
  const a = join(dir, 'probe-a')
  const b = join(dir, 'probe-b')
  await writeFile(a, 'probe', 'utf8')
  try {
    await copyFile(a, b, constants.COPYFILE_FICLONE_FORCE)
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
