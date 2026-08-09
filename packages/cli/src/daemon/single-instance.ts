// One daemon per box.
//
// The unix socket already stops a second daemon sharing a HOBBY_HOME, and the
// default ports stop a second one sharing the default config. Neither is the
// real boundary. Two daemons with different HOBBY_HOMEs and different ports
// start happily, and then quietly contend over the two things that are
// machine-wide and not theirs to divide: the docker daemon, and the host port
// range each one allocates from its own store while knowing nothing about the
// other's.
//
// That is not hypothetical. It happened here while testing eject: a second
// daemon under a scratch HOBBY_HOME allocated 15432, the same port the first
// daemon's own database uses. Nothing collided only because that database
// happened to be asleep at the time, and a container that cannot bind its
// published port is a wake that fails inside somebody's first query.
//
// The lock is a file rather than a bound port because the point is a good
// error: a port that will not bind says EADDRINUSE, while this can say which
// process is already the daemon and which HOBBY_HOME it is serving.
//
// It is deliberately at a fixed path, not under HOBBY_HOME. A lock inside the
// directory being locked against cannot see the second daemon, which is the
// entire failure being prevented.

import { openSync, closeSync, readFileSync, unlinkSync, writeSync } from 'node:fs'
import { HobbyError } from '@hobby.sh/core'

// Literally /tmp, not os.tmpdir(). os.tmpdir() reads $TMPDIR, and on macOS
// that is a per-user directory under /var/folders which is also not set in
// every shell: the first version of this used it, and two daemons started from
// two terminals took two different locks and both ran. A lock whose location
// depends on the environment of whoever started the process is not a lock.
//
// /tmp exists on every Linux and macOS box, is shared by every user and every
// shell, and is the only writable path with that property that does not need
// root. The one place this is namespaced rather than shared is a systemd unit
// with PrivateTmp=yes, which would hide daemons from each other again; if
// hobby ever ships a unit file, it must not set that.
export const DAEMON_LOCK_PATH = '/tmp/hobby-daemon.lock'

interface LockRecord {
  pid: number
  home: string
  startedAt: string
}

export interface DaemonLock {
  path: string
  release(): void
}

function readLock(path: string): LockRecord | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
    if (typeof parsed !== 'object' || parsed === null) return null
    const record = parsed as Partial<LockRecord>
    if (typeof record.pid !== 'number') return null
    return {
      pid: record.pid,
      home: typeof record.home === 'string' ? record.home : 'an unknown location',
      startedAt: typeof record.startedAt === 'string' ? record.startedAt : 'an unknown time',
    }
  } catch {
    // Unreadable or not JSON: a lock file we cannot understand is treated the
    // same as one left by a dead process, because the alternative is a daemon
    // that can never start again until someone deletes a file by hand.
    return null
  }
}

// signal 0 performs the permission and existence checks without delivering
// anything. EPERM means the process exists and belongs to someone else, which
// still counts as alive.
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

export function acquireDaemonLock(home: string, path: string = DAEMON_LOCK_PATH): DaemonLock {
  for (let attempt = 0; attempt < 2; attempt++) {
    let fd: number
    try {
      // wx: create, fail if it exists. The exclusivity is the filesystem's,
      // not ours, so two daemons racing to start cannot both win it.
      fd = openSync(path, 'wx')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw new HobbyError(
          'internal',
          `could not take the daemon lock at ${path}`,
          (err as Error).message
        )
      }

      const existing = readLock(path)
      if (existing !== null && isAlive(existing.pid)) {
        throw new HobbyError(
          'conflict',
          `a hobby daemon is already running on this machine (pid ${existing.pid})`,
          `It is serving ${existing.home}, started ${existing.startedAt}. One box runs one daemon: two of them ` +
            `share the docker daemon and the host port range while each allocates ports from its own state, so ` +
            `the second one hands out ports the first is already using. Stop that daemon first, or use it.`
        )
      }

      // Stale: the process that wrote it is gone. Take it over. The loop
      // repeats the create rather than writing into the old file, so a second
      // daemon reclaiming the same stale lock at the same instant still
      // resolves to exactly one winner.
      try {
        unlinkSync(path)
      } catch {
        // Someone else reclaimed it first; the next attempt will see theirs.
      }
      continue
    }

    const record: LockRecord = { pid: process.pid, home, startedAt: new Date().toISOString() }
    try {
      writeSync(fd, JSON.stringify(record))
    } finally {
      closeSync(fd)
    }

    return {
      path,
      release(): void {
        // Only ever removes its own lock. A daemon that crashed, was replaced,
        // and then shut down slowly must not delete the successor's lock.
        const current = readLock(path)
        if (current !== null && current.pid !== process.pid) return
        try {
          unlinkSync(path)
        } catch {
          // Already gone. Nothing to do and nothing worth saying.
        }
      },
    }
  }

  throw new HobbyError(
    'conflict',
    `could not take the daemon lock at ${path}`,
    'another daemon reclaimed it while this one was starting. Try again.'
  )
}
