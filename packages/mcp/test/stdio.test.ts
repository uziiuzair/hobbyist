// Issue #128: the server over stdio, with no daemon. Two layers: the real
// runStdioServer over in-memory streams, and the real `hobby mcp` verb as a
// subprocess against a HOBBY_HOME with no socket in it. Neither needs
// Docker; both prove that a client can initialize and list tools on a box
// whose daemon is down, that a tool call then fails cleanly rather than
// killing the server, and that the server exits when its stdin closes.

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { PassThrough, type Readable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { after, test } from 'node:test'
import { runStdioServer } from '../src/server.js'

const homes: string[] = []
after(() => {
  for (const home of homes) rmSync(home, { recursive: true, force: true })
})

function tempHome(): string {
  const home = join(tmpdir(), `hobby-mcp-stdio-${randomUUID()}`)
  mkdirSync(home, { recursive: true, mode: 0o700 })
  homes.push(home)
  return home
}

interface RpcResponse {
  id: number
  result?: Record<string, unknown>
  error?: { message: string }
}

// Reads newline-delimited JSON-RPC off a stream and hands back responses by id.
function rpcReader(stream: Readable): (id: number) => Promise<RpcResponse> {
  let buf = ''
  const seen = new Map<number, RpcResponse>()
  const waiting = new Map<number, (r: RpcResponse) => void>()
  stream.setEncoding('utf8')
  stream.on('data', (chunk: string) => {
    buf += chunk
    let nl = buf.indexOf('\n')
    while (nl !== -1) {
      const line = buf.slice(0, nl).trim()
      buf = buf.slice(nl + 1)
      nl = buf.indexOf('\n')
      if (line === '') continue
      const msg = JSON.parse(line) as RpcResponse
      if (typeof msg.id !== 'number') continue
      const w = waiting.get(msg.id)
      if (w !== undefined) {
        waiting.delete(msg.id)
        w(msg)
      } else {
        seen.set(msg.id, msg)
      }
    }
  })
  return (id) =>
    new Promise((resolve, reject) => {
      const have = seen.get(id)
      if (have !== undefined) return resolve(have)
      const timer = setTimeout(() => reject(new Error(`no response to request ${id}`)), 10_000)
      waiting.set(id, (r) => {
        clearTimeout(timer)
        resolve(r)
      })
    })
}

function send(stream: NodeJS.WritableStream, id: number | null, method: string, params: Record<string, unknown> = {}): void {
  const msg = id === null ? { jsonrpc: '2.0', method, params } : { jsonrpc: '2.0', id, method, params }
  stream.write(`${JSON.stringify(msg)}\n`)
}

const INIT = { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'stdio-test', version: '0' } }

async function handshakeAndCall(stdin: NodeJS.WritableStream, next: (id: number) => Promise<RpcResponse>): Promise<void> {
  send(stdin, 1, 'initialize', INIT)
  const init = await next(1)
  assert.equal((init.result?.serverInfo as { name?: string } | undefined)?.name, 'hobby-mcp')
  send(stdin, null, 'notifications/initialized')

  send(stdin, 2, 'tools/list')
  const list = await next(2)
  const names = ((list.result?.tools ?? []) as Array<{ name: string }>).map((t) => t.name)
  for (const expected of ['hobby_list', 'hobby_new', 'hobby_branch', 'hobby_reset', 'hobby_rm']) {
    assert.ok(names.includes(expected), `tools/list is missing ${expected}`)
  }

  // No daemon: the call fails as a tool error, and the server stays up.
  send(stdin, 3, 'tools/call', { name: 'hobby_list', arguments: {} })
  const call = await next(3)
  assert.equal(call.result?.isError, true)
  send(stdin, 4, 'tools/list')
  assert.ok((await next(4)).result?.tools)
}

test('runStdioServer answers initialize and tools/list with no daemon, and closes on end of input', async () => {
  const stdin = new PassThrough()
  const stdout = new PassThrough()
  const next = rpcReader(stdout)
  const socketPath = join(tempHome(), 'hobby.sock')
  const handle = await runStdioServer({ socketPath, stdin, stdout })
  await handshakeAndCall(stdin, next)
  stdin.end()
  await handle.closed
})

const HOBBY_BIN = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'cli', 'bin', 'hobby.js')

test('`hobby mcp` runs the server as a subprocess and exits 0 when the client closes stdin', async () => {
  const home = tempHome()
  const child = spawn(process.execPath, [HOBBY_BIN, 'mcp'], {
    env: { ...process.env, HOBBY_HOME: home, HOBBY_REMOTE: '' },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  let stderr = ''
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (s: string) => {
    stderr += s
  })
  const exited = new Promise<number | null>((resolve) => child.on('exit', (code) => resolve(code)))
  try {
    await handshakeAndCall(child.stdin, rpcReader(child.stdout))
  } catch (err) {
    child.kill()
    throw new Error(`${String(err)}\nstderr: ${stderr}`)
  }
  child.stdin.end()
  assert.equal(await exited, 0, `stderr: ${stderr}`)
})
