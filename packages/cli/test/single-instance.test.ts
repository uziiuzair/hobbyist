// The daemon lock. Pure filesystem and process.kill(pid, 0), so these run for
// real with no daemon, no docker and no waiting.
//
// The case that matters is the third one: a lock left behind by a process that
// no longer exists must not be able to lock the box out forever. A daemon that
// refuses to start because of a file written by something that died in 2026 is
// a worse failure than the collision the lock exists to prevent.

import assert from 'node:assert/strict'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { HobbyError } from '@hobby.sh/core'
import { acquireDaemonLock, DAEMON_LOCK_PATH } from '../src/daemon/single-instance.js'

// Each test gets its own path. tmpdir() is fine here and wrong in the module
// under test: these want isolation from each other, the daemon wants the same
// path from every shell on the box. See DAEMON_LOCK_PATH's comment.
function lockPath(): string {
  return join(tmpdir(), `hobby-daemon-test-${randomUUID()}.lock`)
}

// The bug this pins was real and mine: the first version derived the path from
// os.tmpdir(), which reads $TMPDIR, and on macOS that is a per-user directory
// that is not even set in every shell. Two daemons started from two terminals
// took two different locks and both ran, which is precisely the thing the lock
// exists to stop.
test('the lock path does not move with the environment', () => {
  assert.equal(DAEMON_LOCK_PATH, '/tmp/hobby-daemon.lock')
  assert.equal(DAEMON_LOCK_PATH.startsWith(tmpdir()) && tmpdir() !== '/tmp', false)
})

// A pid that is real enough to look plausible and certain not to be running.
// Linux caps pids well below this by default and macOS lower still.
const DEAD_PID = 4_194_303

test('the first daemon takes the lock and records who it is', () => {
  const path = lockPath()
  const lock = acquireDaemonLock('/home/someone/.hobby', path)
  try {
    assert.equal(existsSync(path), true)
    const record = JSON.parse(readFileSync(path, 'utf8')) as { pid: number; home: string }
    assert.equal(record.pid, process.pid)
    assert.equal(record.home, '/home/someone/.hobby')
  } finally {
    lock.release()
  }
  assert.equal(existsSync(path), false, 'release removes the lock')
})

test('a second daemon is refused, and told which one is already running', () => {
  const path = lockPath()
  const first = acquireDaemonLock('/home/someone/.hobby', path)
  try {
    assert.throws(
      () => acquireDaemonLock('/tmp/some-other-home', path),
      (err: unknown) => {
        assert.ok(err instanceof HobbyError)
        assert.equal(err.code, 'conflict')
        // The pid and the other daemon's home are the whole reason this is a
        // file and not a bound port: EADDRINUSE cannot say either.
        assert.match(err.message, new RegExp(String(process.pid)))
        assert.match(err.hint ?? '', /\/home\/someone\/\.hobby/)
        return true
      }
    )
  } finally {
    first.release()
  }
})

test('a lock left by a process that no longer exists is reclaimed, not obeyed', () => {
  const path = lockPath()
  writeFileSync(path, JSON.stringify({ pid: DEAD_PID, home: '/gone', startedAt: '2026-01-01T00:00:00.000Z' }))

  const lock = acquireDaemonLock('/home/someone/.hobby', path)
  try {
    const record = JSON.parse(readFileSync(path, 'utf8')) as { pid: number }
    assert.equal(record.pid, process.pid)
  } finally {
    lock.release()
  }
})

test('a lock file that is not readable JSON is treated as stale rather than fatal', () => {
  const path = lockPath()
  writeFileSync(path, 'this is not json')

  // Otherwise a truncated write, or a file someone touched by hand, means the
  // daemon can never start again until a human deletes it.
  const lock = acquireDaemonLock('/home/someone/.hobby', path)
  try {
    const record = JSON.parse(readFileSync(path, 'utf8')) as { pid: number }
    assert.equal(record.pid, process.pid)
  } finally {
    lock.release()
  }
})

test('release only removes a lock this process still owns', () => {
  const path = lockPath()
  const lock = acquireDaemonLock('/home/someone/.hobby', path)

  // A successor took over after this process was presumed dead. Releasing
  // late must not delete the lock that is now protecting somebody else.
  writeFileSync(path, JSON.stringify({ pid: DEAD_PID, home: '/successor', startedAt: '2026-01-01T00:00:00.000Z' }))
  lock.release()

  assert.equal(existsSync(path), true)
  const record = JSON.parse(readFileSync(path, 'utf8')) as { home: string }
  assert.equal(record.home, '/successor')
})
