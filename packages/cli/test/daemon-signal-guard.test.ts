// `hobby daemon restart` and `hobby daemon stop` signal the pid in the
// machine-wide daemon lock. They must refuse a daemon that predates the signal
// protocol (its SIGTERM is a shutdown with the proxy inside it, so a "restart"
// ends every session) and a daemon serving a different HOBBY_HOME. The
// stand-in daemon here is a plain child process: if a guard fails, it is
// signalled and the test sees it die.
import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { HobbyError, resolvePaths } from '@hobby.sh/core'
import { cmdDaemonRestart, cmdDaemonStop } from '../src/cli/commands.js'
import { acquireDaemonLock, DAEMON_SIGNAL_PROTOCOL, inspectDaemonLock } from '../src/daemon/single-instance.js'

const io = { out: () => {}, err: () => {}, env: {}, cwd: tmpdir() } as never

function standIn(): ChildProcess {
  // Ignores nothing: the default SIGTERM/SIGUSR2 action ends it, which is how
  // a guard that let the signal through shows up.
  return spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function setup(record: Record<string, unknown>): { home: string; lockPath: string; child: ChildProcess } {
  const home = mkdtempSync(join(tmpdir(), 'hobby-signal-guard-'))
  const child = standIn()
  const lockPath = join(home, 'daemon.lock')
  writeFileSync(lockPath, JSON.stringify({ pid: child.pid, home, startedAt: '2026-10-30T13:54:01.148Z', ...record }))
  return { home, lockPath, child }
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 150))
}

test('a lock written by this daemon records the signal protocol', () => {
  const home = mkdtempSync(join(tmpdir(), 'hobby-signal-guard-'))
  const lockPath = join(home, 'daemon.lock')
  const lock = acquireDaemonLock(home, lockPath)
  try {
    assert.equal(JSON.parse(readFileSync(lockPath, 'utf8')).signals, DAEMON_SIGNAL_PROTOCOL)
    assert.equal(inspectDaemonLock(lockPath)?.signals, DAEMON_SIGNAL_PROTOCOL)
  } finally {
    lock.release()
  }
})

test('a lock from a daemon that predates the field reads as protocol 0', () => {
  const { lockPath, child } = setup({})
  try {
    assert.equal(inspectDaemonLock(lockPath)?.signals, 0)
  } finally {
    child.kill('SIGKILL')
  }
})

for (const verb of ['restart', 'stop'] as const) {
  const run = (home: string, lockPath: string): Promise<number> =>
    verb === 'restart'
      ? cmdDaemonRestart(io, resolvePaths({ HOBBY_HOME: home }), { lockPath, timeoutMs: 2000, restartWaitMs: 200 })
      : cmdDaemonStop(io, resolvePaths({ HOBBY_HOME: home }), { lockPath, timeoutMs: 2000 })

  test(`hobby daemon ${verb} refuses a daemon from before the signal protocol, and signals nothing`, async () => {
    const { home, lockPath, child } = setup({})
    try {
      await assert.rejects(run(home, lockPath), (err: unknown) => {
        assert.ok(err instanceof HobbyError)
        assert.equal(err.code, 'conflict')
        assert.match(err.message, /earlier hobby/)
        assert.match(err.hint ?? '', verb === 'restart' ? /systemctl restart hobby/ : /systemctl stop hobby/)
        return true
      })
      await settle()
      assert.ok(alive(child.pid!), 'the old daemon must not have been signalled')
    } finally {
      child.kill('SIGKILL')
    }
  })

  test(`hobby daemon ${verb} refuses a daemon serving a different HOBBY_HOME, and signals nothing`, async () => {
    const { lockPath, child } = setup({ signals: DAEMON_SIGNAL_PROTOCOL })
    const other = mkdtempSync(join(tmpdir(), 'hobby-signal-guard-other-'))
    try {
      await assert.rejects(run(other, lockPath), (err: unknown) => {
        assert.ok(err instanceof HobbyError)
        assert.equal(err.code, 'conflict')
        assert.match(err.message, /serves .* not /)
        return true
      })
      await settle()
      assert.ok(alive(child.pid!), 'a daemon serving another home must not have been signalled')
    } finally {
      child.kill('SIGKILL')
    }
  })

  test(`hobby daemon ${verb} still signals a current daemon serving this home`, async () => {
    const { home, lockPath, child } = setup({ signals: DAEMON_SIGNAL_PROTOCOL })
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()))
    try {
      // The stand-in dies on the signal and nothing takes the lock after it, so
      // restart reports "no new daemon started" and stop reports success; either
      // way, the signal was sent.
      if (verb === 'restart') {
        await assert.rejects(run(home, lockPath), /no new daemon started/)
      } else {
        assert.equal(await run(home, lockPath), 0)
      }
      await exited
      assert.ok(!alive(child.pid!))
    } finally {
      child.kill('SIGKILL')
    }
  })
}
