// The compute runtime interface and its in-memory fake. Real implementations
// (Docker today, a microVM later, see docs/decisions/0002) live outside
// core: this file only describes the contract and gives every later task's
// test suite something to run against without Docker.

import { Readable } from 'node:stream'
import { HobbyError } from './errors.js'

export type ContainerId = string

// The host address a published port binds to when a spec does not name one.
// Loopback, never 0.0.0.0: a Postgres container published on every
// interface is directly reachable by anyone who can route to the box, with
// the superuser password sitting in the store, which bypasses the
// wake-on-connect proxy and every guarantee that hangs off it. Docker
// installs its own iptables rules ahead of the host firewall, so a `ufw
// deny` does not close that hole either; the bind address is the only thing
// that does. The daemon's own Studio listener already reasons this way, see
// packages/cli/src/daemon/server.ts's 127.0.0.1 listen call.
export const DEFAULT_PORT_BIND = '127.0.0.1'

export interface PortMapping {
  host: number
  container: number
  // Host address to publish on. Omitted means DEFAULT_PORT_BIND, applied at
  // the emit site (packages/core/src/docker.ts's buildCreateArgs). Set this
  // explicitly only for a port genuinely meant to be reachable off the box.
  bind?: string
}

export interface ContainerSpec {
  name: string
  image: string
  env: Record<string, string>
  ports: PortMapping[]
  binds: Array<{ host: string; container: string }>
  network?: string
  // Extra name-to-address entries for the container's /etc/hosts, emitted as
  // --add-host. On Linux, host.docker.internal does not resolve inside a
  // container unless it is mapped explicitly, which is half of why the queue
  // producer path never worked there
  // (docs/queues/research/2026-08-22-the-producer-path-on-real-linux.md).
  extraHosts?: Array<{ name: string; address: string }>
}

export interface ContainerStatus {
  exists: boolean
  running: boolean
  exitCode: number | null
}

// What `docker build` needs, and nothing more. Separate from ContainerSpec
// because building and running are different operations with different
// failure modes: a build failure is the user's Dockerfile, a run failure is
// ours or their process's.
export interface BuildSpec {
  // The build context directory, as the user gave it.
  contextPath: string
  // Path to the Dockerfile, absolute or relative to contextPath.
  dockerfile: string
  // What the resulting image is tagged, e.g. hobby/blog-web:1754870400.
  tag: string
  // Resource caps. A build that is slow is a nuisance; a build that makes a
  // sleeping database miss its wake budget is a broken promise, so a build
  // always loses to anything else contending for the box.
  memory?: string
  cpuShares?: number
}

// A process run inside an already running container, with its stdout handed
// back as a stream rather than buffered. Built for one caller today, the
// online snapshot (packages/cli/src/daemon/basebackup.ts), which pipes a
// pg_basebackup tar of a whole cluster through it: buffering that the way
// ExecFn (docker.ts) buffers `docker inspect` would hold a database in the
// daemon's memory, and the 16MB maxBuffer there would fail any real one.
export interface ExecStream {
  // The process's stdout, raw bytes. Never a TTY (docker.ts's execStream
  // passes no -t), because a pseudo-terminal rewrites line endings and would
  // corrupt a binary stream like a tar.
  stdout: Readable
  // Settles once the process has exited: resolves on status 0, rejects with
  // a HobbyError carrying whatever the process wrote to stderr otherwise. A
  // caller must treat stdout as untrustworthy until this resolves: a
  // process that dies halfway still closes stdout cleanly, and what arrived
  // until then looks like a shorter, valid stream.
  done: Promise<void>
  // Stops the process from the outside, for a caller whose consumer of
  // stdout failed and who would otherwise leave the producer blocked on a
  // full pipe forever. done still settles afterwards, rejected.
  cancel(): void
}

export interface ComputeRuntime {
  available(): Promise<boolean>
  ensureCreated(spec: ContainerSpec): Promise<ContainerId>
  start(name: string): Promise<void>
  stop(name: string, opts: { timeoutSec: number }): Promise<void>
  remove(name: string): Promise<void>
  inspect(name: string): Promise<ContainerStatus>
  logs(name: string, opts: { tail: number }): Promise<string>
  ensureNetwork(name: string): Promise<void>
  removeNetwork(name: string): Promise<void>

  // Optional on purpose, and this is ADR 0002's escape hatch staying honest.
  // Only the `app` kind needs to build an image, and a future microVM
  // runtime would not build one this way at all. Making these required would
  // force every implementation, including createFakeRuntime, to grow a
  // Docker-shaped build it has no use for. A kind that needs them checks and
  // fails with a real error rather than the interface pretending.
  build?(spec: BuildSpec): Promise<string>
  removeImage?(tag: string): Promise<void>

  // Runs `command` inside the running container `name`. Optional for the
  // same reason build is: only the online snapshot needs it, and a future
  // runtime that is not Docker may have no equivalent, in which case that
  // caller refuses with a real error rather than the interface pretending.
  //
  // An argument array, never a shell string, for the reason docker.ts's
  // header gives: container names and database role names reach it, and
  // nothing here is ever interpreted by a shell.
  execStream?(name: string, command: string[]): ExecStream
}

// One recorded execStream call on the fake runtime, and what a test hands
// back for it. The handler sees the call and returns the stdout bytes (or a
// stream of them) plus the exit it should report, so a test can supply a
// real tar, a truncated one, or a failing pg_basebackup without Docker.
export interface FakeExecCall {
  name: string
  command: string[]
}

export interface FakeExecResult {
  stdout: Readable | Uint8Array
  // Omitted means exit 0. A string is the stderr of a non-zero exit.
  error?: string
}

const NOT_FOUND_STATUS: ContainerStatus = { exists: false, running: false, exitCode: null }

export function createFakeRuntime(): ComputeRuntime & {
  _state: Map<string, ContainerStatus>
  _specs: Map<string, ContainerSpec>
  _networks: Set<string>
  _builds: BuildSpec[]
  _images: Set<string>
  _exec: { calls: FakeExecCall[]; handler: ((call: FakeExecCall) => FakeExecResult) | null }
  // Required here, where the interface has it optional: the fake always
  // has one, and a test should not have to prove that at every call.
  execStream(name: string, command: string[]): ExecStream
} {
  const state = new Map<string, ContainerStatus>()
  const specs = new Map<string, ContainerSpec>()
  const networks = new Set<string>()
  const builds: BuildSpec[] = []
  const images = new Set<string>()
  const exec: { calls: FakeExecCall[]; handler: ((call: FakeExecCall) => FakeExecResult) | null } = {
    calls: [],
    handler: null,
  }

  return {
    // Every execStream call, and the test's handler for them. Recorded for
    // the same reason _builds is: an online snapshot that silently did not
    // run pg_basebackup, or ran it with the wrong arguments, must be
    // visible to an assertion.
    _exec: exec,

    // Refuses a container that is not running, as `docker exec` does ("is
    // not running", exit 1): an online snapshot of a database that was
    // stopped under it must fail here exactly as it would against Docker,
    // not read whatever the handler happened to return.
    execStream(name: string, command: string[]): ExecStream {
      const call: FakeExecCall = { name, command: [...command] }
      exec.calls.push(call)
      if (state.get(name)?.running !== true) {
        return failedExec(new HobbyError('runtime_unavailable', 'docker exec failed', `container ${name} is not running`))
      }
      if (exec.handler === null) {
        return failedExec(new HobbyError('internal', 'fake runtime has no exec handler', 'set runtime._exec.handler'))
      }
      const result = exec.handler(call)
      const stdout = result.stdout instanceof Readable ? result.stdout : Readable.from([Buffer.from(result.stdout)])
      let cancelled = false
      const done = new Promise<void>((resolve, reject) => {
        const settle = (): void => {
          if (cancelled) {
            reject(new HobbyError('runtime_unavailable', 'docker exec failed', 'cancelled'))
          } else if (result.error !== undefined) {
            reject(new HobbyError('runtime_unavailable', 'docker exec failed', result.error))
          } else {
            resolve()
          }
        }
        stdout.once('end', settle)
        stdout.once('close', settle)
        stdout.once('error', settle)
      })
      // A rejection nobody has awaited yet is still an unhandled one to
      // node, and the caller awaits done only after stdout is consumed.
      done.catch(() => {})
      return {
        stdout,
        done,
        cancel(): void {
          cancelled = true
          stdout.destroy()
        },
      }
    },

    _state: state,
    _specs: specs,
    // Exposed for the same reason _specs is: a test asserting that a deploy
    // built the image it said it did has nothing else to read, and a build
    // that silently did not happen would otherwise look identical to one
    // that did.
    _builds: builds,
    _images: images,

    async build(spec: BuildSpec): Promise<string> {
      builds.push(spec)
      images.add(spec.tag)
      return `fake build of ${spec.tag}\n`
    },

    async removeImage(tag: string): Promise<void> {
      images.delete(tag)
    },
    // Exposed for the same reason _specs is: a network that is created and
    // never removed is invisible to every assertion unless a test can see the
    // set. That leak is exactly what eject --release had to stop doing.
    _networks: networks,

    async available(): Promise<boolean> {
      return true
    },

    async ensureCreated(spec: ContainerSpec): Promise<ContainerId> {
      // Stored with the same default bind address the real adapter emits
      // (docker.ts's buildCreateArgs), so a test reading _specs sees what
      // would actually be published rather than the pre-default shape. A
      // fake that hides the default would make it possible to regress the
      // loopback bind without a single test noticing.
      specs.set(spec.name, {
        ...spec,
        ports: spec.ports.map((port) => ({ ...port, bind: port.bind ?? DEFAULT_PORT_BIND })),
      })
      if (!state.has(spec.name)) {
        state.set(spec.name, { exists: true, running: false, exitCode: null })
      }
      return spec.name
    },

    async start(name: string): Promise<void> {
      const current = state.get(name) ?? { exists: true, running: false, exitCode: null }
      state.set(name, { ...current, exists: true, running: true, exitCode: null })
    },

    // A missing container is a successful no-op here, matching the real
    // contract: createDockerRuntime's stop() and remove() both treat "no
    // such container" as success, not failure (see docker.ts). Coverage for
    // that not-found behavior belongs against the real adapter's injectable
    // ExecFn, which can produce realistic Docker error text; see
    // docker.test.ts. This fake staying forgiving here is what keeps it a
    // faithful stand-in for the real, corrected runtime, not stricter than
    // production.
    async stop(name: string, _opts: { timeoutSec: number }): Promise<void> {
      const current = state.get(name) ?? { exists: true, running: false, exitCode: null }
      state.set(name, { ...current, running: false, exitCode: 0 })
    },

    async remove(name: string): Promise<void> {
      state.delete(name)
      specs.delete(name)
    },

    async inspect(name: string): Promise<ContainerStatus> {
      return state.get(name) ?? NOT_FOUND_STATUS
    },

    async logs(_name: string, _opts: { tail: number }): Promise<string> {
      return ''
    },

    async ensureNetwork(name: string): Promise<void> {
      networks.add(name)
    },

    async removeNetwork(name: string): Promise<void> {
      networks.delete(name)
    },
  }
}

function failedExec(error: HobbyError): ExecStream {
  const done = Promise.reject(error)
  done.catch(() => {})
  return { stdout: Readable.from([]), done, cancel(): void {} }
}
