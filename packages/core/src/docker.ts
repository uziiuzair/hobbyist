// Docker implementation of ComputeRuntime. Shells out to the docker CLI
// through node:child_process.execFile, wrapped by the injectable ExecFn.
// Container and project names reach these argv arrays from user input, so
// every call goes through execFile with an argv array, never through a
// shell string: that is what keeps this free of command injection.

import { execFile } from 'node:child_process'
import { HobbyError } from './errors.js'
import { DEFAULT_PORT_BIND } from './runtime.js'
import type { BuildSpec, ComputeRuntime, ContainerId, ContainerSpec, ContainerStatus } from './runtime.js'

export type ExecFn = (cmd: string, args: string[]) => Promise<{ stdout: string; stderr: string }>

// The shape an ExecFn is expected to throw on a non-zero exit. Node's own
// execFile callback hands the error, stdout and stderr separately; the
// default implementation below folds stdout/stderr onto the rejected error
// so callers (real or fake) have one place to look.
interface ExecError {
  stdout?: string
  stderr?: string
  message?: string
}

function defaultExec(cmd: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        const withOutput = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string }
        withOutput.stdout = stdout
        withOutput.stderr = stderr
        reject(withOutput)
        return
      }
      resolve({ stdout, stderr })
    })
  })
}

function errorOf(err: unknown): ExecError {
  if (err && typeof err === 'object') {
    return err as ExecError
  }
  return { message: String(err) }
}

// Docker's message for a missing container, image, network or volume is
// "Error: No such object: <name>", or for older subcommands "No such
// container: <name>" / "No such network: <name>".
// Docker does not use one wording for this. `docker inspect` on a missing
// container says "No such object" or "No such container", while
// `docker network inspect` on a missing network says "network <name> not
// found". Matching only the first form made ensureNetwork unable to create the
// very first network, because the inspect failure it was meant to swallow was
// rethrown instead. Found by running hobby new against real Docker, not by any
// test, because the tests drive an injectable exec whose error text we wrote.
function isNotFound(stderr: string | undefined): boolean {
  if (stderr === undefined) return false
  return (
    /No such (object|container|network|image|volume)/i.test(stderr) ||
    /\bnot found\b/i.test(stderr)
  )
}

// Docker's message for removing a network with attached containers, e.g.
// "Error response from daemon: error while removing network: network
// hobby-blog id ... has active endpoints".
function isInUse(stderr: string | undefined): boolean {
  return stderr !== undefined && /has active endpoints/i.test(stderr)
}

function toRuntimeUnavailable(action: string, err: unknown): HobbyError {
  const e = errorOf(err)
  return new HobbyError('runtime_unavailable', `${action} failed`, e.stderr ?? e.message ?? String(err))
}

async function inspectContainer(exec: ExecFn, name: string): Promise<ContainerStatus> {
  try {
    const { stdout } = await exec('docker', ['inspect', name])
    const parsed = JSON.parse(stdout) as Array<{ State?: { Running?: boolean; ExitCode?: number } }>
    const state = parsed[0]?.State
    return {
      exists: true,
      running: state?.Running ?? false,
      exitCode: state?.ExitCode ?? null,
    }
  } catch (err) {
    const e = errorOf(err)
    if (isNotFound(e.stderr)) {
      return { exists: false, running: false, exitCode: null }
    }
    throw toRuntimeUnavailable('docker inspect', err)
  }
}

function buildCreateArgs(spec: ContainerSpec): string[] {
  const args = ['create', '--name', spec.name]
  for (const [key, value] of Object.entries(spec.env)) {
    args.push('-e', `${key}=${value}`)
  }
  for (const port of spec.ports) {
    // Always with an explicit bind address. `-p 15432:5432` (no address) is
    // shorthand for 0.0.0.0, which publishes the database on every
    // interface: anyone who can route to the box can then connect straight
    // to Postgres with the superuser password from the store, with the
    // wake-on-connect proxy, its idle accounting and its routing all
    // bypassed. See DEFAULT_PORT_BIND in runtime.ts for why a host firewall
    // is not a substitute here.
    args.push('-p', `${port.bind ?? DEFAULT_PORT_BIND}:${port.host}:${port.container}`)
  }
  for (const bind of spec.binds) {
    args.push('-v', `${bind.host}:${bind.container}`)
  }
  if (spec.network) {
    args.push('--network', spec.network)
  }
  // host-gateway is docker's own token for "the bridge gateway of whichever
  // network this container is on", which is the address the daemon's queue
  // endpoint binds on Linux. Emitting a literal address here instead would be
  // wrong the moment a project gets a different network.
  for (const host of spec.extraHosts ?? []) {
    args.push('--add-host', `${host.name}:${host.address}`)
  }
  args.push(spec.image)
  return args
}

export function createDockerRuntime(exec: ExecFn = defaultExec): ComputeRuntime {
  async function run(args: string[]): Promise<{ stdout: string; stderr: string }> {
    try {
      return await exec('docker', args)
    } catch (err) {
      throw toRuntimeUnavailable(`docker ${args[0] ?? ''}`, err)
    }
  }

  return {
    async available(): Promise<boolean> {
      try {
        await exec('docker', ['version'])
        return true
      } catch {
        return false
      }
    },

    async ensureCreated(spec: ContainerSpec): Promise<ContainerId> {
      const status = await inspectContainer(exec, spec.name)
      if (status.exists) {
        return spec.name
      }
      await run(buildCreateArgs(spec))
      return spec.name
    },

    async start(name: string): Promise<void> {
      await run(['start', name])
    },

    // Always a clean shutdown, never docker kill: a SIGKILLed Postgres does
    // recovery on the next start, and that recovery would land inside a
    // user's first query against the wake-on-connect budget.
    //
    // Stopping a container that does not exist is a no-op, exactly like
    // remove() below: teardown must be idempotent, and asking to stop
    // something that is already gone is success, not failure. Without this,
    // a resource whose container was never created (e.g. createPostgres
    // failed at mkdir, before ensureCreated ever ran) would be permanently
    // undestroyable, since destroy's first step would throw.
    async stop(name: string, opts: { timeoutSec: number }): Promise<void> {
      try {
        await exec('docker', ['stop', '-t', String(opts.timeoutSec), name])
      } catch (err) {
        const e = errorOf(err)
        if (isNotFound(e.stderr)) {
          return
        }
        throw toRuntimeUnavailable('docker stop', err)
      }
    },

    async remove(name: string): Promise<void> {
      try {
        await exec('docker', ['rm', name])
      } catch (err) {
        const e = errorOf(err)
        if (isNotFound(e.stderr)) {
          return
        }
        throw toRuntimeUnavailable('docker rm', err)
      }
    },

    async inspect(name: string): Promise<ContainerStatus> {
      return inspectContainer(exec, name)
    },

    async logs(name: string, opts: { tail: number }): Promise<string> {
      const { stdout } = await run(['logs', '--tail', String(opts.tail), name])
      return stdout
    },

    // `docker build`, with the caps that keep a build from starving the box
    // it shares with running databases. Never a shell string: contextPath and
    // dockerfile come from user input and reach argv directly, same reasoning
    // as buildCreateArgs above.
    //
    // A non-zero exit is the user's Dockerfile far more often than it is
    // ours, so it becomes `build_failed` (422) rather than
    // `runtime_unavailable` (503), and the whole build output is carried as
    // the hint because the last line of a docker build is rarely the line
    // that explains it.
    async build(spec: BuildSpec): Promise<string> {
      const args = ['build', '-f', spec.dockerfile, '-t', spec.tag]
      if (spec.memory !== undefined) {
        args.push('--memory', spec.memory)
      }
      if (spec.cpuShares !== undefined) {
        args.push('--cpu-shares', String(spec.cpuShares))
      }
      args.push(spec.contextPath)

      try {
        const { stdout, stderr } = await exec('docker', args)
        // docker build writes its progress to stderr and only the final
        // image id to stdout, so a caller shown stdout alone sees nothing
        // useful.
        return `${stderr}${stdout}`
      } catch (err) {
        const e = errorOf(err)
        throw new HobbyError(
          'build_failed',
          `docker build failed for ${spec.tag}`,
          `${e.stderr ?? ''}${e.stdout ?? ''}` || e.message || String(err)
        )
      }
    },

    // Best effort, and a missing image is success. Called when an app is
    // destroyed, so that destroying a resource does not silently leave its
    // built layers on the disk forever.
    async removeImage(tag: string): Promise<void> {
      try {
        await exec('docker', ['image', 'rm', tag])
      } catch (err) {
        const e = errorOf(err)
        if (isNotFound(e.stderr)) {
          return
        }
        throw toRuntimeUnavailable('docker image rm', err)
      }
    },

    // Idempotent: the daemon calls this on every project start, so
    // inspect first and only create when the network is absent.
    async ensureNetwork(name: string): Promise<void> {
      try {
        await exec('docker', ['network', 'inspect', name])
        return
      } catch (err) {
        const e = errorOf(err)
        if (!isNotFound(e.stderr)) {
          throw toRuntimeUnavailable('docker network inspect', err)
        }
      }
      await run(['network', 'create', name])
    },

    // Must not fail when the network is already gone (daemon may call this
    // during a partially failed teardown) or surface the "still has
    // endpoints" case as anything other than a conflict.
    async removeNetwork(name: string): Promise<void> {
      try {
        await exec('docker', ['network', 'rm', name])
      } catch (err) {
        const e = errorOf(err)
        if (isNotFound(e.stderr)) {
          return
        }
        if (isInUse(e.stderr)) {
          throw new HobbyError(
            'conflict',
            `network ${name} still has attached containers`,
            e.stderr
          )
        }
        throw toRuntimeUnavailable('docker network rm', err)
      }
    },
  }
}
