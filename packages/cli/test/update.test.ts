// `hobby update` against a real git checkout in a temp directory, with a bare
// repository standing in for the remote. No network and no rebuild: every
// case here stops at --check or at "already on", before install.sh runs.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { resolvePaths } from '@hobby.sh/core'
import { cmdUpdate } from '../src/cli/commands.js'
import type { Io } from '../src/cli/main.js'

function git(cwd: string, ...args: string[]): string {
  const res = spawnSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { encoding: 'utf8' })
  assert.equal(res.status, 0, res.stderr)
  return res.stdout.trim()
}

// A remote with v0.0.1 and v0.0.2, and a checkout of it under <home>/src.
function fixture(): { home: string; src: string; remote: string } {
  const root = join(tmpdir(), `hobby-update-test-${randomUUID()}`)
  const remote = join(root, 'remote.git')
  const work = join(root, 'work')
  const home = join(root, 'home')
  const src = join(home, 'src')
  mkdirSync(work, { recursive: true })
  mkdirSync(home, { recursive: true })
  git(root, 'init', '--quiet', '--bare', remote)
  git(root, 'init', '--quiet', work)
  for (const v of ['v0.0.1', 'v0.0.2']) {
    writeFileSync(join(work, 'VERSION'), v)
    git(work, 'add', 'VERSION')
    git(work, 'commit', '--quiet', '-m', v)
    git(work, 'tag', v)
  }
  git(work, 'push', '--quiet', '--tags', remote, 'HEAD:refs/heads/main')
  git(root, 'clone', '--quiet', remote, src)
  return { home, src, remote }
}

function captureIo(): { io: Io; out: string[] } {
  const out: string[] = []
  const io: Io = {
    out: (s) => out.push(s),
    err: () => {},
    env: {},
    cwd: tmpdir(),
    readLine: async () => '',
  }
  return { io, out }
}

test('update --check works from a checkout that is not on a tag', async () => {
  // The state a box is in after someone checked out main by hand, or any
  // commit past the newest release. `git describe --exact-match` fails there,
  // and update used to die on that instead of treating it as "no release".
  const { home, src } = fixture()
  writeFileSync(join(src, 'EXTRA'), 'x')
  git(src, 'add', 'EXTRA')
  git(src, 'commit', '--quiet', '-m', 'past the release')

  const { io, out } = captureIo()
  const code = await cmdUpdate(io, resolvePaths({ HOBBY_HOME: home }), { check: true })

  assert.equal(code, 0)
  assert.deepEqual(out, ['v0.0.2'])
})

test('update says already on the newest tag when it is', async () => {
  const { home, src } = fixture()
  git(src, 'checkout', '--quiet', 'v0.0.2')

  const { io, out } = captureIo()
  const code = await cmdUpdate(io, resolvePaths({ HOBBY_HOME: home }), {})

  assert.equal(code, 0)
  assert.deepEqual(out, ['already on v0.0.2'])
})
