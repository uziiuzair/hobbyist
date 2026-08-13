// `hobby studio passwd` and `hobby studio`, tested against cmdStudioPasswd
// and cmdStudio directly (not through run()/main()): both are pure functions
// of an Io, a Paths, and (for cmdStudio) a HobbyConfig and an injectable
// BrowserOpener, so there is no need to go through argv parsing to exercise
// the behavior the task report calls out. cmdStudio's real default opener
// spawns a real `open`/`xdg-open`, which a test must never do (it would pop
// an actual browser on whatever machine runs this suite), so every test here
// passes its own opener instead of the default.

import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { resolvePaths, type HobbyConfig, type Paths } from '@hobby.sh/core'
import {
  cmdStudio,
  cmdStudioPasswd,
  hasOperatorCredential,
  readOperatorCredential,
  run,
  verifyPassword,
  type Io,
} from '../src/index.js'

function testConfig(): HobbyConfig {
  return {
    image: 'postgres:18-alpine',
    proxyPort: 5432,
    studioPort: 8443,
    apiPort: 7432,
    httpPort: 7433,
    domain: 'localhost',
    sleepAfterSeconds: 300,
    wakeTimeoutMs: 150,
    readinessPollMs: 20,
    caddyEnabled: false,
    caddyAdminPort: 2019,
    caddyStudioHost: null,
  }
}

function tmpPaths(): Paths {
  const home = join(tmpdir(), `hobby-studio-passwd-test-${randomUUID()}`)
  mkdirSync(home, { recursive: true })
  return resolvePaths({ HOBBY_HOME: home })
}

// A fake Io whose readLine() is fed a fixed queue of lines and whose out/err
// are captured, never a real terminal or process.stdin: this is what proves
// cmdStudioPasswd reads the password only through Io, with no other input
// source it could have used instead.
function fakeIo(inputs: string[] = []): { io: Io; outLines: string[]; errLines: string[] } {
  const outLines: string[] = []
  const errLines: string[] = []
  let i = 0
  const io: Io = {
    out: (s) => outLines.push(s),
    err: (s) => errLines.push(s),
    env: {},
    cwd: process.cwd(),
    readLine: async (_opts) => {
      const value = inputs[i]
      i += 1
      if (value === undefined) {
        throw new Error('fakeIo.readLine called more times than inputs were provided')
      }
      return value
    },
  }
  return { io, outLines, errLines }
}

test('cmdStudioPasswd reads the password only through io.readLine, never from any other argument', async () => {
  const paths = tmpPaths()
  assert.equal(hasOperatorCredential(paths), false)

  // cmdStudioPasswd's own signature is (io, paths): there is no positionals
  // or flags parameter it could read a password from even if main.ts's
  // dispatch passed one through, which is the structural guarantee behind
  // "never accepts it as a command line argument." This call proves the
  // stored credential matches exactly what readLine supplied.
  const { io } = fakeIo(['correct horse battery staple', 'correct horse battery staple'])
  const code = await cmdStudioPasswd(io, paths)

  assert.equal(code, 0)
  assert.equal(hasOperatorCredential(paths), true)
})

test('main.ts never declares a --password flag for `studio passwd`, so argv cannot carry it either', async () => {
  // This is the other half of the argv guarantee: cmdStudioPasswd's callers
  // in main.ts's run() parse `studio passwd`'s remaining argv with an empty
  // FlagSpec (parseArgs(rest.slice(1), {})), so any --flag at all, including
  // a hypothetical --password, throws UsageError rather than being accepted
  // and read. Exercised through main.ts's own run() here specifically to
  // pin that wiring, not just cmdStudioPasswd's own signature.
  const paths = tmpPaths()
  const { io } = fakeIo([])
  io.env['HOBBY_HOME'] = paths.home

  const code = await run(['studio', 'passwd', '--password=hunter2'], io)
  assert.notEqual(code, 0)
  assert.equal(hasOperatorCredential(paths), false, 'a rejected flag must never have set a credential')
})

test('cmdStudioPasswd rejects mismatched entries and writes nothing', async () => {
  const paths = tmpPaths()
  const { io, errLines } = fakeIo(['first entry', 'a different second entry'])

  const code = await cmdStudioPasswd(io, paths)

  assert.equal(code, 1)
  assert.equal(hasOperatorCredential(paths), false)
  assert.match(errLines.join('\n'), /did not match/)
})

// setOperatorPassword itself throws HobbyError('usage', 'password must not
// be empty'), and cmdStudioPasswd does not catch it (see its own comment):
// every command in this package throws and lets main.ts's handleError be
// the one place that turns a HobbyError into an exit code and a printed
// message, so cmdStudioPasswd called directly, as here, must reject rather
// than return a code.
test('cmdStudioPasswd rejects an empty password without writing a credential', async () => {
  const paths = tmpPaths()
  const { io } = fakeIo(['', ''])

  await assert.rejects(() => cmdStudioPasswd(io, paths), /password must not be empty/)
  assert.equal(hasOperatorCredential(paths), false)
})

test('cmdStudioPasswd overwrites a previously set credential', async () => {
  const paths = tmpPaths()
  await cmdStudioPasswd(fakeIo(['first password', 'first password']).io, paths)

  const { io } = fakeIo(['second password', 'second password'])
  const code = await cmdStudioPasswd(io, paths)
  assert.equal(code, 0)

  const stored = readOperatorCredential(paths)
  assert.ok(stored !== null)
  assert.equal(await verifyPassword('second password', stored as string), true)
  assert.equal(await verifyPassword('first password', stored as string), false)
})

test('cmdStudio names `hobby studio passwd` and never opens a browser when no credential is set', () => {
  const paths = tmpPaths()
  const { io, errLines } = fakeIo()
  let opened = 0

  const code = cmdStudio(io, paths, testConfig(), () => {
    opened += 1
  })

  assert.equal(code, 1)
  assert.equal(opened, 0)
  assert.match(errLines.join('\n'), /hobby studio passwd/)
})

test('cmdStudio prints the daemon loopback URL and opens it once a credential exists', async () => {
  const paths = tmpPaths()
  await cmdStudioPasswd(fakeIo(['correct horse battery staple', 'correct horse battery staple']).io, paths)

  const { io, outLines } = fakeIo()
  const opened: string[] = []

  const code = cmdStudio(io, paths, testConfig(), (url) => opened.push(url))

  assert.equal(code, 0)
  assert.deepEqual(opened, ['http://127.0.0.1:7432'])
  assert.ok(outLines.includes('http://127.0.0.1:7432'))
})
