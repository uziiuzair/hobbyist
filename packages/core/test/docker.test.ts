// Written but not executed in this task, see task-2-report.md. The fake
// ExecFn is the entire testability strategy for the Docker runtime: it lets
// these tests assert the exact argv docker.ts emits without Docker present.

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createDockerRuntime, type ExecFn } from '../src/index.js'
import type { ContainerSpec } from '../src/index.js'

interface RecordedCall {
  cmd: string
  args: string[]
}

function notFoundError(stderr: string): Error {
  return Object.assign(new Error('Command failed'), { stderr, stdout: '' })
}

function inUseError(stderr: string): Error {
  return Object.assign(new Error('Command failed'), { stderr, stdout: '' })
}

function sampleSpec(): ContainerSpec {
  return {
    name: 'hobby-blog-primary',
    image: 'postgres:18-alpine',
    env: { POSTGRES_PASSWORD: 'secret' },
    ports: [{ host: 15432, container: 5432 }],
    binds: [{ host: '/data/blog/pgdata', container: '/var/lib/postgresql/data' }],
    network: 'hobby-blog',
  }
}

test('ensureCreated issues docker create with the exact expected argv when absent', async () => {
  const calls: RecordedCall[] = []
  const exec: ExecFn = async (cmd, args) => {
    calls.push({ cmd, args })
    if (args[0] === 'inspect') {
      throw notFoundError('Error: No such object: hobby-blog-primary')
    }
    if (args[0] === 'create') {
      return { stdout: 'hobby-blog-primary\n', stderr: '' }
    }
    throw new Error(`unexpected call: ${args.join(' ')}`)
  }

  const runtime = createDockerRuntime(exec)
  const id = await runtime.ensureCreated(sampleSpec())

  assert.equal(id, 'hobby-blog-primary')
  assert.equal(calls.length, 2)
  assert.deepEqual(calls[1], {
    cmd: 'docker',
    args: [
      'create',
      '--name',
      'hobby-blog-primary',
      '-e',
      'POSTGRES_PASSWORD=secret',
      '-p',
      '15432:5432',
      '-v',
      '/data/blog/pgdata:/var/lib/postgresql/data',
      '--network',
      'hobby-blog',
      'postgres:18-alpine',
    ],
  })
})

test('ensureCreated issues no create when the container already exists', async () => {
  const calls: RecordedCall[] = []
  const exec: ExecFn = async (cmd, args) => {
    calls.push({ cmd, args })
    if (args[0] === 'inspect') {
      return {
        stdout: JSON.stringify([{ State: { Running: false, ExitCode: 0 } }]),
        stderr: '',
      }
    }
    throw new Error(`unexpected call: ${args.join(' ')}`)
  }

  const runtime = createDockerRuntime(exec)
  const id = await runtime.ensureCreated(sampleSpec())

  assert.equal(id, 'hobby-blog-primary')
  assert.equal(calls.length, 1)
  assert.equal(calls[0]?.args[0], 'inspect')
})

test('inspect maps a "No such object" failure to exists: false', async () => {
  const exec: ExecFn = async () => {
    throw notFoundError('Error: No such object: ghost')
  }

  const runtime = createDockerRuntime(exec)
  const status = await runtime.inspect('ghost')

  assert.deepEqual(status, { exists: false, running: false, exitCode: null })
})

test('stop passes the timeout to docker stop -t', async () => {
  const calls: RecordedCall[] = []
  const exec: ExecFn = async (cmd, args) => {
    calls.push({ cmd, args })
    return { stdout: '', stderr: '' }
  }

  const runtime = createDockerRuntime(exec)
  await runtime.stop('hobby-blog-primary', { timeoutSec: 30 })

  assert.deepEqual(calls, [{ cmd: 'docker', args: ['stop', '-t', '30', 'hobby-blog-primary'] }])
})

test('ensureNetwork creates the network only when absent', async () => {
  const calls: RecordedCall[] = []
  const exec: ExecFn = async (cmd, args) => {
    calls.push({ cmd, args })
    if (args[0] === 'network' && args[1] === 'inspect') {
      throw notFoundError('Error: No such network: hobby-blog')
    }
    return { stdout: '', stderr: '' }
  }

  const runtime = createDockerRuntime(exec)
  await runtime.ensureNetwork('hobby-blog')

  assert.deepEqual(calls, [
    { cmd: 'docker', args: ['network', 'inspect', 'hobby-blog'] },
    { cmd: 'docker', args: ['network', 'create', 'hobby-blog'] },
  ])
})

test('ensureNetwork is a no-op when the network already exists', async () => {
  const calls: RecordedCall[] = []
  const exec: ExecFn = async (cmd, args) => {
    calls.push({ cmd, args })
    return { stdout: '[]', stderr: '' }
  }

  const runtime = createDockerRuntime(exec)
  await runtime.ensureNetwork('hobby-blog')

  assert.equal(calls.length, 1)
})

test('removeNetwork swallows the absent case', async () => {
  const exec: ExecFn = async () => {
    throw notFoundError('Error: No such network: hobby-blog')
  }

  const runtime = createDockerRuntime(exec)
  await assert.doesNotReject(() => runtime.removeNetwork('hobby-blog'))
})

test('removeNetwork surfaces the in-use case as a conflict HobbyError', async () => {
  const exec: ExecFn = async () => {
    throw inUseError(
      'Error response from daemon: error while removing network: network hobby-blog id abc123 has active endpoints'
    )
  }

  const runtime = createDockerRuntime(exec)
  await assert.rejects(
    () => runtime.removeNetwork('hobby-blog'),
    (err: unknown) => {
      assert.ok(err instanceof Error)
      assert.equal((err as { code?: string }).code, 'conflict')
      return true
    }
  )
})

test('available reflects whether docker version succeeds', async () => {
  const okRuntime = createDockerRuntime(async () => ({ stdout: 'Docker version 27.0.0', stderr: '' }))
  assert.equal(await okRuntime.available(), true)

  const failingRuntime = createDockerRuntime(async () => {
    throw new Error('command not found: docker')
  })
  assert.equal(await failingRuntime.available(), false)
})

test('unexpected inspect failures become a runtime_unavailable HobbyError', async () => {
  const exec: ExecFn = async () => {
    throw Object.assign(new Error('Command failed'), {
      stderr: 'Cannot connect to the Docker daemon',
      stdout: '',
    })
  }

  const runtime = createDockerRuntime(exec)
  await assert.rejects(
    () => runtime.inspect('hobby-blog-primary'),
    (err: unknown) => {
      assert.ok(err instanceof Error)
      assert.equal((err as { code?: string }).code, 'runtime_unavailable')
      assert.equal((err as { hint?: string }).hint, 'Cannot connect to the Docker daemon')
      return true
    }
  )
})
