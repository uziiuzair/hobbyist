// Exercises run() end to end against a real loopback unix-socket HTTP
// server standing in for the daemon (the same pattern task-4-report.md used
// for routes.test.ts: a fake server, no Docker, no external network) to
// check two contracts the brief calls out by name: --json prints the API
// response body unmodified, and an unreachable daemon exits 5 with a hint
// naming `hobby init`. Also covers the pure renderers in output.ts.

import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { run, type Io } from '../src/cli/main.js'
import { CLI_VERSION } from '../src/version.js'
import { connectionEnv } from '../src/cli/commands.js'
import {
  diskWarning,
  formatBytes,
  preflightBlockers,
  renderPreflight,
  renderResourceLine,
  sleepPolicyTrailer,
  studioExposureNote,
} from '../src/cli/output.js'
import type { PreflightReport } from '../src/daemon/preflight.js'

function makeIo(env: NodeJS.ProcessEnv): { io: Io; outLines: string[]; errLines: string[] } {
  const outLines: string[] = []
  const errLines: string[] = []
  return {
    io: {
      out: (s) => outLines.push(s),
      err: (s) => errLines.push(s),
      env,
      cwd: process.cwd(),
      readLine: async () => '',
    },
    outLines,
    errLines,
  }
}

function tempHome(): string {
  return mkdtempSync(join(tmpdir(), 'hobby-cli-output-test-'))
}

function listen(server: Server, socketPath: string): Promise<void> {
  return new Promise((resolve) => server.listen(socketPath, resolve))
}

function close(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()))
}

test('--json prints the resource response body from `wake` unmodified', async () => {
  const home = tempHome()
  const socketPath = join(home, 'hobby.sock')

  const resource = {
    id: 'r1',
    projectId: 'p1',
    kind: 'postgres',
    name: 'primary',
    state: 'running',
    config: {
      image: 'postgres:18-alpine',
      containerName: 'hobby-blog-primary',
      dataDir: '/x/pgdata',
      hostPort: 15432,
      superuser: 'postgres',
      password: 'secret',
      database: 'blog',
    },
    lastActiveAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
  }
  const projectDetailBody = {
    project: { id: 'p1', name: 'blog', networkName: 'hobby-blog', sleepAfterSeconds: 300, createdAt: '2026-01-01T00:00:00.000Z' },
    resources: [resource],
  }
  const startResponseBody = { resource: { ...resource, state: 'running' } }

  const server = createServer((req, res) => {
    res.setHeader('content-type', 'application/json; charset=utf-8')
    if (req.method === 'GET' && req.url === '/v1/projects/blog') {
      res.writeHead(200)
      res.end(JSON.stringify(projectDetailBody))
      return
    }
    if (req.method === 'POST' && req.url === '/v1/resources/r1/start') {
      res.writeHead(200)
      res.end(JSON.stringify(startResponseBody))
      return
    }
    res.writeHead(404)
    res.end(JSON.stringify({ error: { code: 'usage', message: `unexpected request: ${req.method} ${req.url}` } }))
  })

  await listen(server, socketPath)
  try {
    const { io, outLines } = makeIo({ HOBBY_HOME: home })
    const code = await run(['wake', 'blog', '--json'], io)
    assert.equal(code, 0)
    assert.equal(outLines.length, 1)
    assert.deepEqual(JSON.parse(outLines[0] as string), startResponseBody)
    // Byte-identical to JSON.stringify of the exact body the daemon sent,
    // not merely deep-equal after a second round trip.
    assert.equal(outLines[0], JSON.stringify(startResponseBody))
  } finally {
    await close(server)
    rmSync(home, { recursive: true, force: true })
  }
})

test('a HobbyError from the daemon maps through exitCodeForError and prints its hint', async () => {
  const home = tempHome()
  const socketPath = join(home, 'hobby.sock')

  const server = createServer((req, res) => {
    res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ error: { code: 'project_not_found', message: 'no project named ghost', hint: 'run `hobby ls`' } }))
  })

  await listen(server, socketPath)
  try {
    const { io, errLines } = makeIo({ HOBBY_HOME: home })
    const code = await run(['ls'], io)
    // ls itself calls listProjects, not getProject, so wire a route that
    // always 404s to exercise the error path regardless of which route ls hits.
    assert.equal(code, 3)
    assert.ok(errLines.some((l) => l.includes('no project named ghost')))
    assert.ok(errLines.some((l) => l.includes('hobby ls')))
  } finally {
    await close(server)
    rmSync(home, { recursive: true, force: true })
  }
})

test('an unreachable daemon exits 5 with a hint naming `hobby init`', async () => {
  const home = tempHome()
  // Never listen on the socket: HOBBY_HOME exists but hobby.sock does not.
  const { io, errLines } = makeIo({ HOBBY_HOME: home })
  const code = await run(['ls'], io)
  assert.equal(code, 5)
  assert.ok(errLines.some((l) => l.includes('hobby init')))
  rmSync(home, { recursive: true, force: true })
})

test('rm without --yes aborts with exit 1 when the typed confirmation does not match', async () => {
  const home = tempHome()
  const socketPath = join(home, 'hobby.sock')
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ deleted: true }))
  })
  await listen(server, socketPath)
  try {
    const outLines: string[] = []
    const errLines: string[] = []
    const io: Io = {
      out: (s) => outLines.push(s),
      err: (s) => errLines.push(s),
      env: { HOBBY_HOME: home },
      cwd: process.cwd(),
      readLine: async () => 'not-the-right-name',
    }
    const code = await run(['rm', 'blog'], io)
    assert.equal(code, 1)
    assert.ok(errLines.some((l) => l.includes('aborted')))
  } finally {
    await close(server)
    rmSync(home, { recursive: true, force: true })
  }
})

test('rm --yes skips confirmation and deletes the whole project for a bare target', async () => {
  const home = tempHome()
  const socketPath = join(home, 'hobby.sock')
  let sawDelete = false
  const server = createServer((req, res) => {
    if (req.method === 'DELETE' && req.url === '/v1/projects/blog') {
      sawDelete = true
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ deleted: true }))
      return
    }
    res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ error: { code: 'usage', message: 'unexpected' } }))
  })
  await listen(server, socketPath)
  try {
    const { io, outLines } = makeIo({ HOBBY_HOME: home })
    const code = await run(['rm', 'blog', '--yes'], io)
    assert.equal(code, 0)
    assert.ok(sawDelete)
    assert.deepEqual(outLines, ['deleted blog'])
  } finally {
    await close(server)
    rmSync(home, { recursive: true, force: true })
  }
})

test('hobby connect never puts the password on the child process argv, only in its environment', async () => {
  const home = tempHome()
  const socketPath = join(home, 'hobby.sock')
  const password = 'super-secret-password'

  const resource = {
    id: 'r1',
    projectId: 'p1',
    kind: 'postgres',
    name: 'primary',
    state: 'sleeping',
    config: {
      image: 'postgres:18-alpine',
      containerName: 'hobby-blog-primary',
      dataDir: '/x/pgdata',
      hostPort: 15432,
      superuser: 'postgres',
      password,
      database: 'blog',
    },
    lastActiveAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
  }
  const projectDetailBody = {
    project: { id: 'p1', name: 'blog', networkName: 'hobby-blog', sleepAfterSeconds: 300, createdAt: '2026-01-01T00:00:00.000Z' },
    resources: [resource],
  }
  const connectionString = `postgres://postgres:${password}@127.0.0.1:5432/blog`

  const server = createServer((req, res) => {
    res.setHeader('content-type', 'application/json; charset=utf-8')
    if (req.method === 'GET' && req.url === '/v1/projects/blog') {
      res.writeHead(200)
      res.end(JSON.stringify(projectDetailBody))
      return
    }
    if (req.method === 'GET' && req.url === '/v1/resources/r1/connection') {
      res.writeHead(200)
      res.end(JSON.stringify({ connectionString }))
      return
    }
    res.writeHead(404)
    res.end(JSON.stringify({ error: { code: 'usage', message: `unexpected request: ${req.method} ${req.url}` } }))
  })

  // A fake `psql` that records the argv and environment it was invoked
  // with, rather than a real one, so this test does not depend on psql
  // being installed and can assert directly on what the child process saw.
  const binDir = mkdtempSync(join(tmpdir(), 'hobby-cli-fakepsql-'))
  const captureFile = join(binDir, 'capture.txt')
  writeFileSync(
    join(binDir, 'psql'),
    [
      '#!/bin/sh',
      '{',
      '  echo "ARGV:$*"',
      '  echo "PGHOST:$PGHOST"',
      '  echo "PGPORT:$PGPORT"',
      '  echo "PGUSER:$PGUSER"',
      '  echo "PGPASSWORD:$PGPASSWORD"',
      '  echo "PGDATABASE:$PGDATABASE"',
      `} > "${captureFile}"`,
      'exit 0',
      '',
    ].join('\n')
  )
  chmodSync(join(binDir, 'psql'), 0o700)

  await listen(server, socketPath)
  try {
    const { io } = makeIo({ HOBBY_HOME: home, PATH: binDir })
    const code = await run(['connect', 'blog'], io)
    assert.equal(code, 0)

    const captured = readFileSync(captureFile, 'utf8')
    assert.equal(captured, `ARGV:\nPGHOST:127.0.0.1\nPGPORT:5432\nPGUSER:postgres\nPGPASSWORD:${password}\nPGDATABASE:blog\n`)
    assert.ok(!captured.includes('postgres://'), 'the connection URI must never appear in child process argv')
  } finally {
    await close(server)
    rmSync(home, { recursive: true, force: true })
    rmSync(binDir, { recursive: true, force: true })
  }
})

test('connectionEnv recovers PG* variables from a connection string, including a password with reserved characters', () => {
  // encodeURIComponent('p@ss/word%25!') is what connectionString() in
  // packages/pg/src/connstring.ts would have produced for a password
  // containing characters that are reserved in a URI; connectionEnv must
  // hand psql back the raw, decoded value, not the percent-encoded one.
  const rawPassword = 'p@ss/word%25!'
  const encodedPassword = encodeURIComponent(rawPassword)
  const connectionString = `postgres://postgres:${encodedPassword}@127.0.0.1:5432/blog`

  const env = connectionEnv(connectionString)
  assert.equal(env.PGHOST, '127.0.0.1')
  assert.equal(env.PGPORT, '5432')
  assert.equal(env.PGUSER, 'postgres')
  assert.equal(env.PGPASSWORD, rawPassword)
  assert.equal(env.PGDATABASE, 'blog')
})

test('formatBytes renders human units', () => {
  assert.equal(formatBytes(500), '500.0 B')
  assert.equal(formatBytes(1536), '1.5 KB')
  assert.equal(formatBytes(5 * 1024 * 1024), '5.0 MB')
})

// Ruling F6 (progress.md): the brief changes `hobby ls`'s output (a compute
// resource now shows its hostname instead of a port, and an `undeployed`
// resource says so) with nothing asserting it, and output formatting is
// exactly what regresses unnoticed. Run through the real `run()` -> cmdLs
// path, the same end-to-end shape as this file's other tests, rather than
// calling renderResourceLine directly, so this also proves cmdLs actually
// prints what the daemon sent rather than something reshaped along the way.
test('hobby ls renders each resource\'s state, and a compute resource\'s hostname', async () => {
  const home = tempHome()
  const socketPath = join(home, 'hobby.sock')

  const postgresResource = {
    id: 'r1',
    projectId: 'p1',
    kind: 'postgres',
    name: 'primary',
    state: 'sleeping',
    config: {
      image: 'postgres:18-alpine',
      containerName: 'hobby-blog-primary',
      dataDir: '/x',
      hostPort: 15432,
      superuser: 'postgres',
      database: 'blog',
    },
    sizeBytes: null,
    connectionCount: 0,
    lastActiveAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
  }
  // `undeployed`: Task 4's createAppResource with neither a source nor an
  // image, so `config.image` is null (never printed by renderResourceLine)
  // and the only things worth showing are the state and the hostname a
  // deploy will eventually serve.
  const appResource = {
    id: 'r2',
    projectId: 'p1',
    kind: 'app',
    name: 'site',
    state: 'undeployed',
    config: {
      image: null,
      containerName: 'hobby-blog-site',
      hostPort: 15080,
      source: null,
      containerPort: 3000,
      hostname: 'blog-site.hobby.local',
      env: {},
      databaseResourceId: null,
    },
    sizeBytes: null,
    connectionCount: 0,
    lastActiveAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
  }
  const project = { id: 'p1', name: 'blog', networkName: 'hobby-blog', sleepAfterSeconds: 300, createdAt: '2026-01-01T00:00:00.000Z' }

  const server = createServer((req, res) => {
    res.setHeader('content-type', 'application/json; charset=utf-8')
    if (req.method === 'GET' && req.url === '/v1/projects') {
      res.writeHead(200)
      res.end(JSON.stringify({ projects: [project] }))
      return
    }
    if (req.method === 'GET' && req.url === '/v1/projects/blog') {
      res.writeHead(200)
      res.end(JSON.stringify({ project, resources: [postgresResource, appResource] }))
      return
    }
    res.writeHead(404)
    res.end(JSON.stringify({ error: { code: 'usage', message: `unexpected request: ${req.method} ${req.url}` } }))
  })

  await listen(server, socketPath)
  try {
    const { io, outLines } = makeIo({ HOBBY_HOME: home })
    const code = await run(['ls'], io)
    assert.equal(code, 0)
    // Issue #103: the connect hint, not the container's own host port, which
    // bypasses the wake router.
    assert.ok(outLines.some((l) => l.includes('primary') && l.includes('sleeping') && l.includes('connect: hobby connect blog/primary')))
    assert.ok(!outLines.some((l) => l.includes('15432')), 'the direct host port is --json only')
    assert.ok(
      outLines.some((l) => l.includes('site') && l.includes('undeployed') && l.includes('blog-site.hobby.local'))
    )
  } finally {
    await close(server)
    rmSync(home, { recursive: true, force: true })
  }
})

test('renderResourceLine includes name, kind, state and the connect hint, never the host port', () => {
  const line = renderResourceLine({
    id: randomUUID(),
    projectId: randomUUID(),
    kind: 'postgres',
    name: 'primary',
    state: 'sleeping',
    config: {
      image: 'postgres:18-alpine',
      containerName: 'hobby-blog-primary',
      dataDir: '/x',
      hostPort: 15432,
      superuser: 'postgres',
      // No `password` here: renderResourceLine takes the daemon's wire
      // shape (WireResource, packages/cli/src/daemon/wire.ts), which never
      // carries one. See routes.test.ts for the test asserting that omission
      // end to end against a real response body.
      database: 'blog',
    },
    sizeBytes: null,
    connectionCount: 0,
    lastActiveAt: null,
    createdAt: new Date(),
  })
  assert.match(line, /primary/)
  assert.match(line, /postgres/)
  assert.match(line, /sleeping/)
  assert.match(line, /connect: hobby connect primary$/)
  assert.doesNotMatch(line, /15432/)
})

// Issue #10's backoff made visible. `now` is injected so the countdown is
// exact; the resource is otherwise the same sleeping postgres as above.
function refusedPostgres(wakeRefusal: { failures: number; retryAt: string; lastError: string } | null) {
  return {
    id: randomUUID(),
    projectId: randomUUID(),
    kind: 'postgres' as const,
    name: 'primary',
    state: 'failed' as const,
    config: {
      image: 'postgres:18-alpine',
      containerName: 'hobby-blog-primary',
      dataDir: '/x',
      hostPort: 15432,
      superuser: 'postgres',
      database: 'blog',
    },
    sizeBytes: null,
    connectionCount: 0,
    wakeRefusal,
    lastActiveAt: null,
    createdAt: new Date(),
  }
}

test('renderResourceLine shows a refused wake with its countdown and a short last error', () => {
  const now = Date.parse('2026-09-19T12:00:00.000Z')
  const line = renderResourceLine(
    refusedPostgres({ failures: 3, retryAt: '2026-09-19T12:03:12.000Z', lastError: 'docker start failed' }),
    now
  )
  assert.equal(line, 'primary  postgres  failed  connect: hobby connect primary  (wake refused, retry in 3m 12s: docker start failed)')
})

test('renderResourceLine shortens a long last error and says when the retry time has passed', () => {
  const now = Date.parse('2026-09-19T12:00:00.000Z')
  const long = `postgres for resource abc did not become ready within 30000ms ${'x'.repeat(200)}`
  const refusing = renderResourceLine(refusedPostgres({ failures: 1, retryAt: '2026-09-19T12:00:00.400Z', lastError: long }), now)
  assert.match(refusing, /\(wake refused, retry in 1s: postgres for resource abc did not become ready within 300\.\.\.\)$/)

  const due = renderResourceLine(
    refusedPostgres({ failures: 2, retryAt: '2026-09-19T11:59:00.000Z', lastError: 'docker start failed' }),
    now
  )
  assert.equal(due, 'primary  postgres  failed  connect: hobby connect primary  (last wake failed 2 times, retried on the next connection: docker start failed)')
})

test('renderResourceLine prints no refusal trailer when there is none', () => {
  assert.equal(renderResourceLine(refusedPostgres(null)), 'primary  postgres  failed  connect: hobby connect primary')
  // With the project known (cmdLs passes it), the hint is the full target.
  assert.equal(renderResourceLine(refusedPostgres(null), Date.now(), 'blog'), 'primary  postgres  failed  connect: hobby connect blog/primary')
})

// Issue #111: the project line marks a pin, and a threshold that differs
// from the daemon's default; the default itself is not worth a word.
test('sleepPolicyTrailer marks pinned and non-default projects only', () => {
  assert.equal(sleepPolicyTrailer({ sleepAfterSeconds: null }, 300), '  (pinned)')
  assert.equal(sleepPolicyTrailer({ sleepAfterSeconds: 120 }, 300), '  (sleeps after 120s)')
  assert.equal(sleepPolicyTrailer({ sleepAfterSeconds: 300 }, 300), '')
  // A daemon that does not report its default: only the pin is shown.
  assert.equal(sleepPolicyTrailer({ sleepAfterSeconds: 120 }, undefined), '')
  assert.equal(sleepPolicyTrailer({ sleepAfterSeconds: null }, undefined), '  (pinned)')
  // A box that pins everything by default: a number on a project differs.
  assert.equal(sleepPolicyTrailer({ sleepAfterSeconds: 120 }, null), '  (sleeps after 120s)')
})

// Issue #109: under --json an error is the API envelope on stderr, one
// line, whatever threw it; the exit code is unchanged.
test('--json prints errors as the API envelope on stderr', async () => {
  const home = tempHome()
  const socketPath = join(home, 'hobby.sock')
  const server = createServer((req, res) => {
    res.setHeader('content-type', 'application/json; charset=utf-8')
    res.writeHead(404)
    res.end(JSON.stringify({ error: { code: 'project_not_found', message: 'no project named nope', hint: 'hobby ls' } }))
  })
  await listen(server, socketPath)
  try {
    // A daemon error, passed through verbatim.
    const daemon = makeIo({ HOBBY_HOME: home })
    assert.equal(await run(['wake', 'nope', '--json'], daemon.io), 3)
    assert.deepEqual(daemon.outLines, [])
    assert.deepEqual(JSON.parse(daemon.errLines.join('\n')), {
      error: { code: 'project_not_found', message: 'no project named nope', hint: 'hobby ls' },
    })

    // A usage error from the parser itself.
    const usage = makeIo({ HOBBY_HOME: home })
    assert.equal(await run(['ls', '--json', '--nope'], usage.io), 2)
    assert.deepEqual(JSON.parse(usage.errLines.join('\n')), { error: { code: 'usage', message: 'unknown flag: --nope' } })

    // A verb with no data of its own still answers in JSON.
    const logout = makeIo({ HOBBY_HOME: home })
    assert.equal(await run(['logout', '--json'], logout.io), 1)
    assert.deepEqual(JSON.parse(logout.errLines.join('\n')), { error: { code: 'usage', message: 'not logged in to anything' } })
  } finally {
    await close(server)
    rmSync(home, { recursive: true, force: true })
  }

  // No daemon at all: the client-side condition, with its own code.
  const gone = makeIo({ HOBBY_HOME: tempHome() })
  assert.equal(await run(['ls', '--json'], gone.io), 5)
  const envelope = JSON.parse(gone.errLines.join('\n')) as { error: { code: string; hint: string } }
  assert.equal(envelope.error.code, 'daemon_unreachable')
  assert.match(envelope.error.hint, /hobby daemon/)
})

// Issue #97: `-h` is help for every verb, and any other short flag is a
// usage error rather than a target or a no-op.
test('a single-dash flag is help or an error, never a target', async () => {
  const help = makeIo({ HOBBY_HOME: tempHome() })
  assert.equal(await run(['logs', '-h'], help.io), 0)
  assert.ok(help.outLines.some((line) => line.includes('hobby logs <target>')))

  const unknown = makeIo({ HOBBY_HOME: tempHome() })
  assert.equal(await run(['ls', '-j'], unknown.io), 2)
  assert.deepEqual(unknown.errLines, ['unknown flag: -j'])
})

// Issue #109: `hobby studio --json` is the verb with a flag, not an unknown
// subcommand.
test('hobby studio --json is parsed as a flag', async () => {
  const home = tempHome()
  const { io, errLines } = makeIo({ HOBBY_HOME: home })
  // No credential in a fresh home, so the answer is the envelope, not
  // "unknown studio subcommand: --json".
  assert.equal(await run(['studio', '--json'], io), 1)
  const envelope = JSON.parse(errLines.join('\n')) as { error: { code: string; message: string } }
  assert.equal(envelope.error.code, 'usage')
  assert.match(envelope.error.message, /no studio password/)
  rmSync(home, { recursive: true, force: true })
})

// Issue #96: every verb used to answer `--help` with `unknown flag: --help`
// and exit 2, and nothing printed the installed version.
test('`hobby deploy --help` prints only deploy rows and exits 0, before touching any config', async () => {
  const { io, outLines, errLines } = makeIo({})
  const code = await run(['deploy', '--help'], io)
  assert.equal(code, 0)
  assert.deepEqual(errLines, [])
  assert.ok(outLines.some((l) => l.includes('hobby deploy [path] --env-file <f>')))
  assert.ok(!outLines.some((l) => l.includes('hobby snapshot')), 'other verbs are left out')
})

test('`hobby help <verb>` and `-h` after a verb are the same as --help; `hobby help` alone is the full usage', async () => {
  const byHelp = makeIo({})
  assert.equal(await run(['help', 'snapshot'], byHelp.io), 0)
  const byFlag = makeIo({})
  assert.equal(await run(['snapshot', 'ls', '-h'], byFlag.io), 0)
  assert.deepEqual(byHelp.outLines, byFlag.outLines)
  assert.ok(byHelp.outLines.some((l) => l.includes('hobby snapshot restore')))

  const full = makeIo({})
  assert.equal(await run(['help'], full.io), 0)
  assert.ok(full.outLines.some((l) => l.includes('hobby deploy')))
  assert.ok(full.outLines.some((l) => l.includes('hobby version')))
})

test('`hobby bogus --help` is the same unknown-command usage error as `hobby bogus`', async () => {
  const { io, errLines } = makeIo({})
  const code = await run(['bogus', '--help'], io)
  assert.equal(code, 2)
  assert.ok(errLines.some((l) => l.includes('unknown command: bogus')))
})

test('`hobby version` prints the CLI version and says the daemon is unreachable rather than failing', async () => {
  const home = tempHome()
  const { io, outLines } = makeIo({ HOBBY_HOME: home })
  const code = await run(['version'], io)
  assert.equal(code, 0)
  assert.equal(outLines[0], `hobby   ${CLI_VERSION}`)
  assert.equal(outLines[1], 'daemon  not reachable')
  assert.notEqual(CLI_VERSION, 'unknown')

  const json = makeIo({ HOBBY_HOME: home })
  assert.equal(await run(['--version', '--json'], json.io), 0)
  assert.deepEqual(JSON.parse(json.outLines[0] as string), { cli: CLI_VERSION, daemon: null, daemonReachable: false })
  rmSync(home, { recursive: true, force: true })
})

test('`hobby version` reports the daemon version from /v1/version when one answers', async () => {
  const home = tempHome()
  const socketPath = join(home, 'hobby.sock')
  const server = createServer((req, res) => {
    assert.equal(req.url, '/v1/version')
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ version: '9.9.9-test' }))
  })
  await listen(server, socketPath)
  try {
    const { io, outLines } = makeIo({ HOBBY_HOME: home })
    assert.equal(await run(['version'], io), 0)
    assert.equal(outLines[1], 'daemon  9.9.9-test')
  } finally {
    await close(server)
    rmSync(home, { recursive: true, force: true })
  }
})

// Issue #170 and #168: `hobby queue peek` says what a message is doing and,
// for a dead letter, how many deliveries failed before it landed.
test('renderQueueMessageLine marks leased, delayed and dead lettered messages', async () => {
  const { renderDuration, renderQueueMessageLine } = await import('../src/cli/output.js')
  const now = 1_700_000_000_000
  const base = { id: 'ID', timestampMs: now - 5000, contentType: 'json', body: { a: 1 }, visibleAtMs: now - 5000, deadLetteredAtMs: null, failedAttempts: null }
  assert.equal(renderQueueMessageLine({ ...base, attempts: 0, state: 'ready' }, now), 'ID  attempts 0  {"a":1}')
  assert.equal(renderQueueMessageLine({ ...base, attempts: 1, state: 'leased' }, now), 'ID  attempts 1  leased  {"a":1}')
  assert.equal(
    renderQueueMessageLine({ ...base, attempts: 1, state: 'delayed', visibleAtMs: now + 90_000 }, now),
    'ID  attempts 1  delayed, visible in 90s  {"a":1}'
  )
  assert.equal(
    renderQueueMessageLine({ ...base, attempts: 0, state: 'ready', deadLetteredAtMs: now - 1000, failedAttempts: 3 }, now),
    'ID  attempts 0  dead letter after 3 failed attempts  {"a":1}'
  )
  assert.equal(renderDuration(345600), '4d')
  assert.equal(renderDuration(3600), '1h')
  assert.equal(renderDuration(90), '90s')
  assert.equal(renderDuration(0), '0s')
})

// --- hobby init's report (issue #108) -------------------------------------

function sampleReport(overrides: Partial<PreflightReport> = {}): PreflightReport {
  const free = (port: number, host = '127.0.0.1') => ({ port, host, bound: false, error: null })
  return {
    runtimeAvailable: true,
    filesystem: { path: '/home/u/.hobby', reflinkSupported: true, freeBytes: 50 * 1024 * 1024 * 1024, tmpfs: false },
    proxyHost: { setting: '127.0.0.1', hosts: ['127.0.0.1'], error: null },
    ports: { proxy: free(5432), api: free(7432), http: free(7433), queue: free(7434), caddy: null },
    daemon: null,
    studio: { listen: '127.0.0.1:7432', publicHost: null },
    hostNetworking: null,
    ...overrides,
  }
}

test('renderPreflight lists every daemon port with its host, and says what studio exposes', () => {
  const lines = renderPreflight(sampleReport())
  assert.deepEqual(lines.slice(2, 6), [
    'proxy port 5432 on 127.0.0.1: free',
    'api (daemon API and studio) port 7432 on 127.0.0.1: free',
    'http port 7433 on 127.0.0.1: free',
    'queue port 7434 on 127.0.0.1: free',
  ])
  assert.equal(lines.some((line) => /studio port/.test(line)), false, 'studioPort is dead and no longer printed')
  assert.match(lines[lines.length - 1] ?? '', /^studio: served on 127\.0\.0\.1:7432, loopback only\. nothing off this box reaches studio/)
  assert.deepEqual(preflightBlockers(sampleReport()), [])
})

test('renderPreflight marks a taken port and an unbindable host, and preflightBlockers names both', () => {
  const report = sampleReport({
    proxyHost: { setting: '10.9.9.9', hosts: ['10.9.9.9'], error: null },
    ports: {
      proxy: { port: 5432, host: '10.9.9.9', bound: false, error: 'EADDRNOTAVAIL' },
      api: { port: 7432, host: '127.0.0.1', bound: true, error: null },
      http: { port: 7433, host: '127.0.0.1', bound: false, error: null },
      queue: { port: 7434, host: '127.0.0.1', bound: false, error: null },
      caddy: [
        { port: 80, host: '127.0.0.1', bound: true, error: null },
        { port: 443, host: '127.0.0.1', bound: false, error: null },
      ],
    },
  })
  const lines = renderPreflight(report)
  assert.ok(lines.includes('proxy port 5432 on 10.9.9.9: cannot bind (EADDRNOTAVAIL)'))
  assert.ok(lines.includes('api (daemon API and studio) port 7432 on 127.0.0.1: already in use'))
  assert.ok(lines.includes('caddy port 80 on 127.0.0.1: already in use'))
  assert.ok(lines.includes('caddy port 443 on 127.0.0.1: free'))

  const blockers = preflightBlockers(report)
  assert.equal(blockers.length, 3)
  assert.match(blockers[0] ?? '', /proxy port 5432 cannot be bound on 10\.9\.9\.9 \(EADDRNOTAVAIL\); hobby daemon would fail the same way/)
  assert.match(blockers[1] ?? '', /api port 7432 on 127\.0\.0\.1 is already in use/)
  assert.match(blockers[2] ?? '', /caddy port 80 on 127\.0\.0\.1 is already in use/)
})

test('a proxyHost the daemon cannot resolve is a blocker in the daemon\'s own words', () => {
  const report = sampleReport({
    proxyHost: { setting: 'tailnet', hosts: null, error: 'proxyHost is "tailnet" but no tailscale address could be found' },
  })
  assert.ok(renderPreflight(report).includes('proxy host "tailnet": proxyHost is "tailnet" but no tailscale address could be found'))
  const blockers = preflightBlockers(report)
  assert.equal(blockers.length, 1)
  assert.match(blockers[0] ?? '', /proxyHost "tailnet" cannot be used: .*no tailscale address/)
  assert.match(blockers[0] ?? '', /hobby daemon will refuse to start/)
})

test('a running daemon is named in the report, and its own ports are never blockers', () => {
  const other = sampleReport({
    daemon: { pid: 4242, home: '/srv/hobby', startedAt: '2026-10-30T08:00:00.000Z', running: true, self: false },
    ports: { ...sampleReport().ports, proxy: { port: 5432, host: '127.0.0.1', bound: true, error: null } },
  })
  assert.ok(
    renderPreflight(other).includes(
      'daemon: already running (pid 4242), serving /srv/hobby since 2026-10-30T08:00:00.000Z; the ports above are its'
    )
  )
  // Not self: still a blocker from preflightBlockers' point of view; cmdInit
  // reports the daemon and stops before ever asking for blockers.
  assert.equal(preflightBlockers(other).length, 1)

  const self = sampleReport({ ...other, daemon: { ...other.daemon!, self: true } })
  assert.deepEqual(preflightBlockers(self), [])
  assert.equal(renderPreflight(self).some((line) => line.startsWith('daemon:')), false)
})

test('studioExposureNote has one sentence per configuration', () => {
  const published = sampleReport({
    ports: { ...sampleReport().ports, caddy: [] },
    studio: { listen: '127.0.0.1:7432', publicHost: 'studio.example.com' },
  })
  assert.match(studioExposureNote(published), /published by caddy at https:\/\/studio\.example\.com\. That is reachable from the internet, behind the operator password/)

  const caddyNoHost = sampleReport({ ports: { ...sampleReport().ports, caddy: [] } })
  assert.match(studioExposureNote(caddyNoHost), /caddy is on but no HOBBY_CADDY_STUDIO_HOST is set, so nothing off this box reaches studio/)

  assert.match(studioExposureNote(sampleReport()), /use an ssh tunnel or tailscale serve, or enable caddy with a hostname/)
})

test('diskWarning speaks up under a gigabyte and stays quiet above it', () => {
  assert.equal(diskWarning(sampleReport()), null)
  const low = sampleReport({ filesystem: { path: '/mnt/small', reflinkSupported: false, freeBytes: 330 * 1024 * 1024, tmpfs: false } })
  assert.match(diskWarning(low) ?? '', /only 330\.0 MB free under \/mnt\/small/)
  assert.match(diskWarning(low) ?? '', /no space left on device/)
})
