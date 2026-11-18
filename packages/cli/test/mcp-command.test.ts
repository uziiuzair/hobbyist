// Issue #128: `hobby mcp`. These drive cmdMcp with a fake loader and `run`
// for the argument handling; no daemon, no Docker, no MCP SDK. The real
// server over real stdio is exercised in packages/mcp/test/stdio.test.ts,
// which can depend on this package where this package cannot depend on it.

import assert from 'node:assert/strict'
import { PassThrough } from 'node:stream'
import { test } from 'node:test'
import { cmdMcp, loadMcpModule, type McpModule } from '../src/cli/mcp.js'
import { knownVerbs, run, type Io } from '../src/cli/main.js'

function makeIo(): { io: Io; out: string[]; err: string[] } {
  const out: string[] = []
  const err: string[] = []
  return { io: { out: (s) => out.push(s), err: (s) => err.push(s), env: { HOBBY_HOME: '/nonexistent-hobby-home' }, cwd: process.cwd(), readLine: async () => '' }, out, err }
}

function fakeModule(): { mod: McpModule; calls: Array<{ socketPath: string }>; hangUp: () => void } {
  const calls: Array<{ socketPath: string }> = []
  let hangUp = (): void => {}
  const closed = new Promise<void>((resolve) => {
    hangUp = resolve
  })
  return {
    mod: {
      async runStdioServer(opts) {
        calls.push({ socketPath: opts.socketPath })
        return { closed }
      },
    },
    calls,
    hangUp: () => hangUp(),
  }
}

test('mcp is a known verb', () => {
  assert.ok(knownVerbs().includes('mcp'))
})

test('hobby mcp serves the given socket and resolves only when the client hangs up', async () => {
  const fake = fakeModule()
  const err: string[] = []
  let settled = false
  const pending = cmdMcp({ socketPath: '/tmp/x/hobby.sock', remoteUrl: null, err: (s) => err.push(s), load: async () => fake.mod }).then((code) => {
    settled = true
    return code
  })
  await new Promise((r) => setImmediate(r))
  assert.deepEqual(fake.calls, [{ socketPath: '/tmp/x/hobby.sock' }])
  assert.equal(settled, false)
  fake.hangUp()
  assert.equal(await pending, 0)
  assert.deepEqual(err, [])
})

// ADR 0018: MCP stays on the socket. An active remote is named, not used.
test('hobby mcp names an active remote on stderr and still serves the local socket', async () => {
  const fake = fakeModule()
  const err: string[] = []
  const pending = cmdMcp({ socketPath: '/tmp/y/hobby.sock', remoteUrl: 'https://box.example', err: (s) => err.push(s), load: async () => fake.mod })
  await new Promise((r) => setImmediate(r))
  fake.hangUp()
  assert.equal(await pending, 0)
  assert.deepEqual(fake.calls, [{ socketPath: '/tmp/y/hobby.sock' }])
  assert.equal(err.length, 1)
  assert.match(err[0] ?? '', /not https:\/\/box\.example/)
})

test('hobby mcp takes no arguments and prints nothing to stdout on a usage error', async () => {
  const { io, out, err } = makeIo()
  const code = await run(['mcp', 'extra'], io)
  assert.equal(code, 2)
  assert.deepEqual(out, [])
  assert.ok(err.length > 0)
})

test('hobby mcp --help prints its usage row', async () => {
  const { io, out } = makeIo()
  assert.equal(await run(['mcp', '--help'], io), 0)
  assert.match(out.join('\n'), /hobby mcp/)
})

// The dynamic import resolves through the workspace, as it will from an
// installed checkout, and finds the entry point it needs. Nothing is started.
test('the real loader finds runStdioServer in the built MCP package', async () => {
  const mod = await loadMcpModule()
  assert.equal(typeof mod.runStdioServer, 'function')
})

test('cmdMcp passes the streams it is given through to the server', async () => {
  const stdin = new PassThrough()
  const stdout = new PassThrough()
  let seen: { stdin?: unknown; stdout?: unknown } = {}
  const mod: McpModule = {
    async runStdioServer(opts) {
      seen = { stdin: opts.stdin, stdout: opts.stdout }
      return { closed: Promise.resolve() }
    },
  }
  assert.equal(await cmdMcp({ socketPath: '/s', remoteUrl: null, err: () => {}, load: async () => mod, stdin, stdout }), 0)
  assert.equal(seen.stdin, stdin)
  assert.equal(seen.stdout, stdout)
})
