// Issues #112, #113 and #138: the CLI's remote-aware verbs, the login
// refusal order and messages, the daemon-unreachable wording, and the tmpfs
// and reflink notes. Each test drives the real `run` or the real command
// against a temp HOBBY_HOME; the only network is a loopback http server.

import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdirSync, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { HobbyError, resolvePaths } from '@hobby.sh/core'
import { createClient, DaemonUnreachableError } from '../src/cli/client.js'
import { cmdLogin } from '../src/cli/commands.js'
import { run, type Io } from '../src/cli/main.js'
import { reflinkWarning, tmpfsWarning } from '../src/cli/output.js'
import { saveRemote } from '../src/cli/remote.js'
import type { PreflightReport } from '../src/daemon/preflight.js'

const homes: string[] = []
after(() => {
  for (const home of homes) rmSync(home, { recursive: true, force: true })
})

function tempHome(): string {
  const home = join(tmpdir(), `hobby-remote-cli-${randomUUID()}`)
  mkdirSync(home, { recursive: true, mode: 0o700 })
  homes.push(home)
  return home
}

function makeIo(env: NodeJS.ProcessEnv, readLine: () => Promise<string> = async () => ''): { io: Io; out: string[]; err: string[] } {
  const out: string[] = []
  const err: string[] = []
  return { io: { out: (s) => out.push(s), err: (s) => err.push(s), env, cwd: process.cwd(), readLine }, out, err }
}

function listen(server: Server): Promise<number> {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port)))
}

function loggedIn(home: string, url = 'https://box.example'): void {
  saveRemote(resolvePaths({ HOBBY_HOME: home }), { url, token: 'not-a-real-token', name: 'laptop', addedAt: new Date().toISOString() })
}

// Issue #112: token management is files on the box; say so instead of
// silently acting on this machine while every other verb goes to the remote.
test('hobby token refuses while logged in to a remote, naming it', async () => {
  const home = tempHome()
  loggedIn(home)
  const { io, err } = makeIo({ HOBBY_HOME: home })
  const code = await run(['token', 'ls'], io)
  assert.equal(code, 2)
  assert.match(err.join('\n'), /logged in to https:\/\/box\.example/)
  assert.match(err.join('\n'), /hobby logout/)
})

// Issue #112: Studio is the remote's; no local password is needed to say so.
test('hobby studio prints the remote studio url while logged in, without a local password', async () => {
  const home = tempHome()
  loggedIn(home)
  const { io, out } = makeIo({ HOBBY_HOME: home })
  const code = await run(['studio', '--json'], io)
  assert.equal(code, 0)
  assert.deepEqual(JSON.parse(out[0] ?? '{}'), { url: 'https://box.example', remote: true })
})

// Issue #113: a 401 from the remote names the box and the way back in.
test('a rejected remote token is explained, with hobby login as the fix', async () => {
  const home = tempHome()
  const server = createServer((_req, res) => {
    res.writeHead(401, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: { code: 'unauthorized', message: 'authentication required' } }))
  })
  const port = await listen(server)
  try {
    loggedIn(home, `http://127.0.0.1:${port}`)
    const { io, err } = makeIo({ HOBBY_HOME: home })
    const code = await run(['ls'], io)
    assert.equal(code, 1)
    assert.match(err.join('\n'), /rejected this machine's token/)
    assert.match(err.join('\n'), new RegExp(`hobby login http://127\\.0\\.0\\.1:${port}`))
  } finally {
    server.close()
  }
})

// Issue #113: refuse plain http off loopback before asking for a password.
test('hobby login refuses a plain-http address off loopback before prompting', async () => {
  const home = tempHome()
  let prompted = false
  const { io } = makeIo({ HOBBY_HOME: home }, async () => {
    prompted = true
    return 'hunter2hunter2'
  })
  await assert.rejects(
    cmdLogin(io, resolvePaths({ HOBBY_HOME: home }), ['http://192.0.2.10:7432'], {}),
    (err: unknown) => err instanceof HobbyError && /plain http/.test(err.message)
  )
  assert.equal(prompted, false, 'the password was never asked for')
})

// Issue #113: a bare host defaults to https; a daemon speaking plain http
// gets a readable message with the http:// form to try, not an OpenSSL error.
test('hobby login against a plain-http daemon says it does not speak https and suggests http://', async () => {
  const home = tempHome()
  const server = createServer((_req, res) => {
    res.writeHead(200)
    res.end('{}')
  })
  const port = await listen(server)
  try {
    const { io } = makeIo({ HOBBY_HOME: home }, async () => 'hunter2hunter2')
    await assert.rejects(
      cmdLogin(io, resolvePaths({ HOBBY_HOME: home }), [`127.0.0.1:${port}`], {}),
      (err: unknown) => {
        assert.ok(err instanceof HobbyError)
        assert.equal(err.code, 'usage')
        assert.match(err.message, /does not speak https/)
        assert.match(err.hint ?? '', new RegExp(`http://127\\.0\\.0\\.1:${port}`))
        return true
      }
    )
  } finally {
    server.close()
  }
})

// Issue #138: a missing socket is "no daemon is listening", not the
// runtime's URL wording.
test('a missing daemon socket reads as no daemon listening', async () => {
  // Under /tmp directly: a unix socket path longer than 104 bytes fails with
  // EINVAL before ENOENT can happen, and macOS's $TMPDIR is already long.
  const path = `/tmp/hobby-rc-${randomUUID().slice(0, 8)}.sock`
  await assert.rejects(createClient(path).request('GET', '/v1/health'), (err: unknown) => {
    assert.ok(err instanceof DaemonUnreachableError)
    assert.equal(err.message, `no daemon is listening at ${path}`)
    return true
  })
})

// Issue #138: tmpfs is memory, and the reflink note names reflink=1.
test('hobby init warns about a tmpfs home and names XFS reflink=1 in the reflink note', () => {
  const base = {
    runtimeAvailable: true,
    filesystem: { path: '/tmp/home', reflinkSupported: false, freeBytes: 1, tmpfs: true },
    ports: { proxy: { port: 5432, bound: false }, studio: { port: 8443, bound: false } },
    hostNetworking: null,
  } as unknown as PreflightReport
  assert.match(tmpfsWarning(base) ?? '', /tmpfs, which lives in memory/)
  assert.match(reflinkWarning(base) ?? '', /XFS with reflink=1/)
  const disk = { ...base, filesystem: { ...base.filesystem, tmpfs: false } } as PreflightReport
  assert.equal(tmpfsWarning(disk), null)
})
