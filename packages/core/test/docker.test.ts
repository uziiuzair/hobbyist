// Written but not executed in this task, see task-2-report.md. The fake
// ExecFn is the entire testability strategy for the Docker runtime: it lets
// these tests assert the exact argv docker.ts emits without Docker present.

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { createDockerRuntime, createFakeRuntime, type ExecFn, type SpawnedProcess } from '../src/index.js'
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
    binds: [{ host: '/data/blog/pgdata', container: '/var/lib/postgresql' }],
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
      // With an explicit loopback bind address, never a bare
      // "15432:5432": that shorthand means 0.0.0.0 and publishes the
      // database on every interface, reachable by anyone who can route to
      // the box using the superuser password from the store, with the
      // wake-on-connect proxy bypassed entirely. Docker's own iptables
      // rules sit ahead of the host firewall, so `ufw` does not close it
      // either. This assertion is the regression test for that.
      '-p',
      '127.0.0.1:15432:5432',
      '-v',
      '/data/blog/pgdata:/var/lib/postgresql',
      '--network',
      'hobby-blog',
      'postgres:18-alpine',
    ],
  })
})

test('ensureCreated publishes every port on loopback unless the spec names an address', async () => {
  const calls: RecordedCall[] = []
  const exec: ExecFn = async (cmd, args) => {
    calls.push({ cmd, args })
    if (args[0] === 'inspect') {
      throw notFoundError('Error: No such object: hobby-blog-primary')
    }
    return { stdout: '', stderr: '' }
  }

  const runtime = createDockerRuntime(exec)
  await runtime.ensureCreated({
    ...sampleSpec(),
    ports: [
      { host: 15432, container: 5432 },
      // The escape hatch, for a port genuinely meant to be public. Nothing
      // in the product sets this today; it exists so that the loopback
      // default is a default rather than a hard-coded value someone later
      // rips out wholesale when they need one public port.
      { host: 8080, container: 80, bind: '0.0.0.0' },
    ],
  })

  const createArgs = calls[1]?.args ?? []
  const published = createArgs.filter((_arg, index) => createArgs[index - 1] === '-p')
  assert.deepEqual(published, ['127.0.0.1:15432:5432', '0.0.0.0:8080:80'])
})

test('the fake runtime records the same loopback default the real adapter emits', async () => {
  const runtime = createFakeRuntime()
  await runtime.ensureCreated(sampleSpec())
  assert.deepEqual(runtime._specs.get('hobby-blog-primary')?.ports, [
    { host: 15432, container: 5432, bind: '127.0.0.1' },
  ])
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

test('stop resolves rather than throws when the container does not exist', async () => {
  const exec: ExecFn = async () => {
    throw notFoundError('Error: No such container: hobby-blog-primary')
  }

  const runtime = createDockerRuntime(exec)
  await assert.doesNotReject(() => runtime.stop('hobby-blog-primary', { timeoutSec: 30 }))
})

test('remove resolves rather than throws when the container does not exist', async () => {
  const exec: ExecFn = async () => {
    throw notFoundError('Error: No such container: hobby-blog-primary')
  }

  const runtime = createDockerRuntime(exec)
  await assert.doesNotReject(() => runtime.remove('hobby-blog-primary'))
})

test('stop surfaces an unexpected failure as a runtime_unavailable HobbyError', async () => {
  const exec: ExecFn = async () => {
    throw Object.assign(new Error('Command failed'), {
      stderr: 'Cannot connect to the Docker daemon',
      stdout: '',
    })
  }

  const runtime = createDockerRuntime(exec)
  await assert.rejects(
    () => runtime.stop('hobby-blog-primary', { timeoutSec: 30 }),
    (err: unknown) => {
      assert.ok(err instanceof Error)
      assert.equal((err as { code?: string }).code, 'runtime_unavailable')
      return true
    }
  )
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

// The wording below is copied verbatim from real Docker 29.4.0, not invented.
// The test above asserts against "No such network", which real Docker does not
// say for this subcommand, so it passed while `hobby new` failed on a clean
// host: the inspect failure was rethrown instead of triggering the create.
test('ensureNetwork creates the network given real Docker not-found wording', async () => {
  const calls: RecordedCall[] = []
  const exec: ExecFn = async (cmd, args) => {
    calls.push({ cmd, args })
    if (args[0] === 'network' && args[1] === 'inspect') {
      throw notFoundError('Error response from daemon: network hobby-blog not found')
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

// execStream's contract against the real adapter, through the injectable
// SpawnFn: the argv docker exec gets (no -t, no shell, the command as
// separate arguments), stdout handed through untouched, and a non-zero exit
// turned into a rejection that carries stderr.
function fakeSpawned(): { process: SpawnedProcess; stdout: PassThrough; stderr: PassThrough; emitter: EventEmitter; killed: () => boolean } {
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  const emitter = new EventEmitter()
  let killed = false
  const process: SpawnedProcess = {
    stdout,
    stderr,
    kill: () => {
      killed = true
    },
    once(event: 'close' | 'error', listener: ((code: number | null) => void) | ((err: Error) => void)): unknown {
      return emitter.once(event, listener)
    },
  }
  return { process, stdout, stderr, emitter, killed: () => killed }
}

test('execStream runs docker exec with the command as separate arguments and streams stdout', async () => {
  const calls: RecordedCall[] = []
  const spawned = fakeSpawned()
  const runtime = createDockerRuntime(
    async () => ({ stdout: '', stderr: '' }),
    (cmd, args) => {
      calls.push({ cmd, args })
      return spawned.process
    }
  )
  assert.ok(runtime.execStream)
  const exec = runtime.execStream('hobby-blog-primary', ['pg_basebackup', '--username=a b; c'])

  assert.deepEqual(calls, [{ cmd: 'docker', args: ['exec', 'hobby-blog-primary', 'pg_basebackup', '--username=a b; c'] }])
  const chunks: Buffer[] = []
  exec.stdout.on('data', (chunk: Buffer) => chunks.push(chunk))
  spawned.stdout.end(Buffer.from([0, 1, 2, 255]))
  await new Promise((resolve) => exec.stdout.once('end', resolve))
  spawned.emitter.emit('close', 0)
  await exec.done
  assert.deepEqual([...Buffer.concat(chunks)], [0, 1, 2, 255])
})

test('execStream rejects a non-zero exit with stderr, and cancel kills the process', async () => {
  const spawned = fakeSpawned()
  const runtime = createDockerRuntime(async () => ({ stdout: '', stderr: '' }), () => spawned.process)
  assert.ok(runtime.execStream)
  const exec = runtime.execStream('hobby-blog-primary', ['pg_basebackup'])
  spawned.stderr.write('Error response from daemon: container abc is not running\n')
  await new Promise((resolve) => setImmediate(resolve))
  exec.cancel()
  assert.equal(spawned.killed(), true)
  spawned.emitter.emit('close', 1)
  await assert.rejects(exec.done, (err: unknown) => {
    assert.equal((err as { code?: string }).code, 'runtime_unavailable')
    assert.match((err as { hint?: string }).hint ?? '', /is not running/)
    return true
  })
})

test('the fake runtime refuses to exec into a container that is not running, as docker exec does', async () => {
  const runtime = createFakeRuntime()
  runtime._exec.handler = () => ({ stdout: Buffer.from('never read') })
  const exec = runtime.execStream('hobby-blog-primary', ['true'])
  await assert.rejects(exec.done, /docker exec failed/)
  assert.equal(runtime._exec.calls.length, 1)
})
