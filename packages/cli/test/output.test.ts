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
import { connectionEnv } from '../src/cli/commands.js'
import { formatBytes, renderResourceLine } from '../src/cli/output.js'

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

test('renderResourceLine includes name, kind, state and port', () => {
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
      password: 'secret',
      database: 'blog',
    },
    lastActiveAt: null,
    createdAt: new Date(),
  })
  assert.match(line, /primary/)
  assert.match(line, /postgres/)
  assert.match(line, /sleeping/)
  assert.match(line, /15432/)
})
