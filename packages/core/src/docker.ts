// Docker implementation of ComputeRuntime. Shells out to the docker CLI
// through node:child_process.execFile, wrapped by the injectable ExecFn.
// Container and project names reach these argv arrays from user input, so
// every call goes through execFile with an argv array, never through a
// shell string: that is what keeps this free of command injection.

import { execFile, spawn } from 'node:child_process'
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import type { Readable } from 'node:stream'
import type { CloneMechanism, CloneResult, ElevatedTreeOps } from './copy.js'
import { HobbyError } from './errors.js'
import { DEFAULT_PORT_BIND } from './runtime.js'
import type { BuildSpec, ComputeRuntime, ContainerId, ContainerSpec, ContainerStatus, ExecStream } from './runtime.js'

// `stdin`, when given, is piped to the child: `docker build -` reads its
// build context from it (the streamed build below). Only that caller passes
// one; every other call leaves stdin closed exactly as before.
export type ExecFn = (cmd: string, args: string[], opts?: { stdin?: Readable }) => Promise<{ stdout: string; stderr: string }>

// The streaming counterpart of ExecFn, used only by execStream below. A
// separate seam because ExecFn's contract is "run to completion and hand me
// the buffered output", which is exactly what a whole-cluster tar must not
// be. Injectable for the same reason ExecFn is: docker.test.ts asserts the
// argv without Docker present.
export interface SpawnedProcess {
  stdout: Readable
  stderr: Readable
  kill(): void
  once(event: 'close', listener: (code: number | null) => void): unknown
  once(event: 'error', listener: (err: Error) => void): unknown
}

export type SpawnFn = (cmd: string, args: string[]) => SpawnedProcess

function defaultSpawn(cmd: string, args: string[]): SpawnedProcess {
  // stdin ignored: nothing is ever sent to the process, and an inherited
  // stdin would hand it the daemon's own.
  const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] })
  return {
    stdout: child.stdout,
    stderr: child.stderr,
    kill: () => {
      child.kill()
    },
    once(event: 'close' | 'error', listener: ((code: number | null) => void) | ((err: Error) => void)): unknown {
      return child.once(event, listener)
    },
  }
}

// Enough of stderr to explain a failure, and no more: a process that writes
// without end to stderr must not grow the daemon's memory without end.
const STDERR_LIMIT_BYTES = 64 * 1024

// The shape an ExecFn is expected to throw on a non-zero exit. Node's own
// execFile callback hands the error, stdout and stderr separately; the
// default implementation below folds stdout/stderr onto the rejected error
// so callers (real or fake) have one place to look.
interface ExecError {
  stdout?: string
  stderr?: string
  message?: string
}

function defaultExec(cmd: string, args: string[], opts?: { stdin?: Readable }): Promise<{ stdout: string; stderr: string }> {
  if (opts?.stdin !== undefined) {
    return execWithStdin(cmd, args, opts.stdin)
  }
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

// execFile has no stdin seam, so the one caller that needs one goes
// through spawn and collects the same two strings. The same ExecError shape
// is rejected on a non-zero exit, so build()'s error handling below does
// not know which path ran.
function execWithStdin(cmd: string, args: string[], stdin: Readable): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk
    })
    stdin.on('error', (err) => {
      child.kill()
      reject(Object.assign(new Error(`input stream failed: ${err.message}`), { stdout, stderr }))
    })
    child.on('error', (err) => reject(Object.assign(err, { stdout, stderr })))
    // A child that exits before reading all of stdin (a container that
    // failed to start, a script that stopped early) closes the pipe, and an
    // EPIPE on child.stdin with no listener is an uncaught exception that
    // takes the whole daemon down. The exit code below already says what
    // happened.
    child.stdin.on('error', () => {})
    child.on('close', (code) => {
      if (code === 0) {
        resolve({ stdout, stderr })
      } else {
        reject(Object.assign(new Error(`${cmd} exited with ${String(code)}`), { stdout, stderr }))
      }
    })
    stdin.pipe(child.stdin)
  })
}

// The real ExecFn, for a daemon-side caller that runs docker itself with an
// injectable seam of its own (packages/cli/src/daemon/import.ts).
export const defaultDockerExec: ExecFn = defaultExec

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

async function ensureImage(exec: ExecFn, image: string): Promise<void> {
  try {
    await exec('docker', ['image', 'inspect', image])
    return
  } catch {
    // Not present locally: fall through to the pull.
  }
  console.error(`docker: pulling ${image} (first use on this box; this can take a minute)`)
  try {
    await exec('docker', ['pull', '--quiet', image])
  } catch (err) {
    const e = errorOf(err)
    const lines = (e.stderr ?? e.message ?? String(err)).trim().split('\n')
    throw new HobbyError(
      'runtime_unavailable',
      `could not pull ${image}`,
      `${lines.slice(-3).join('\n')}\nis this box online, and does docker have access to the registry?`
    )
  }
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
  // host-gateway is docker's own token for the host as seen from a
  // container: the default bridge's gateway (docker0) unless the docker
  // daemon sets host-gateway-ip. It is NOT the gateway of the network the
  // container is attached to. The hobby daemon binds that default bridge
  // gateway on Linux (queueEndpointHosts, packages/cli/src/daemon/server.ts),
  // so the token is enough and no literal address is emitted here.
  for (const host of spec.extraHosts ?? []) {
    args.push('--add-host', `${host.name}:${host.address}`)
  }
  args.push(spec.image)
  return args
}

// Merges the two output streams of `docker logs --timestamps` into one text
// ordered by the timestamp docker prefixed to every line, then strips the
// prefix again so the result reads like `docker logs` would at a terminal.
// A stable merge of two already-ordered streams, so lines with the same
// timestamp keep stdout before stderr. A line without a timestamp (a
// continuation of a multi-line write, in practice) stays attached to the
// line before it.
export function mergeTimestampedLogs(stdout: string, stderr: string): string {
  const TIMESTAMP = /^(\d{4}-\d{2}-\d{2}T[0-9:.]+Z) ?/
  type Entry = { at: string; lines: string[] }
  const parse = (text: string): Entry[] => {
    const entries: Entry[] = []
    for (const line of text.split('\n')) {
      if (line.length === 0) continue
      const match = TIMESTAMP.exec(line)
      const last = entries[entries.length - 1]
      if (match === null) {
        if (last !== undefined) {
          last.lines.push(line)
        } else {
          entries.push({ at: '', lines: [line] })
        }
        continue
      }
      entries.push({ at: match[1] ?? '', lines: [line.slice(match[0].length)] })
    }
    return entries
  }
  const a = parse(stdout)
  const b = parse(stderr)
  const out: string[] = []
  let i = 0
  let j = 0
  while (i < a.length || j < b.length) {
    const left = a[i]
    const right = b[j]
    if (right === undefined || (left !== undefined && left.at <= right.at)) {
      out.push(...left!.lines)
      i++
    } else {
      out.push(...right.lines)
      j++
    }
  }
  return out.length === 0 ? '' : `${out.join('\n')}\n`
}

export function createDockerRuntime(exec: ExecFn = defaultExec, spawnFn: SpawnFn = defaultSpawn): ComputeRuntime {
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
      // `docker create` pulls a missing image silently, which on a fresh box
      // is 47 seconds of nothing for the first `hobby new` (issue #138).
      // Pulled explicitly instead, with a log line before and a bounded
      // error after: a failed pull used to arrive as the whole pull log in
      // the hint.
      await ensureImage(exec, spec.image)
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

    // Both streams, in order. `docker logs` replays the container's stdout
    // on its own stdout and the container's stderr on its own stderr, and
    // returning only the first (issue #61) dropped exactly the lines
    // anyone runs `hobby logs` for: Postgres writes every LOG, FATAL and
    // PANIC line to stderr, and so does most crash output. Interleaving two
    // separately buffered pipes by arrival order is a guess, so each line
    // is asked for with its timestamp and the two are merged on that.
    async logs(name: string, opts: { tail: number }): Promise<string> {
      const { stdout, stderr } = await run(['logs', '--tail', String(opts.tail), '--timestamps', name])
      return mergeTimestampedLogs(stdout, stderr)
    },

    // `docker build`. Never a shell string: contextPath and dockerfile come
    // from user input and reach argv directly, same reasoning as
    // buildCreateArgs above.
    //
    // No `--memory` or `--cpu-shares`. Both were passed here until issue
    // #150 showed BuildKit accepts them and does nothing (`docker build
    // --help` under buildx does not even list them; a RUN step that printed
    // its cgroup limit under `--memory 128m` printed `max`). Only the legacy
    // builder (DOCKER_BUILDKIT=0) honours them, and it is deprecated, warns
    // on every build and cannot build a Dockerfile that uses BuildKit
    // syntax, so the flags are gone rather than kept as a false promise.
    // The global build lock (build-lock.ts) is the real protection.
    //
    // A non-zero exit is the user's Dockerfile far more often than it is
    // ours, so it becomes `build_failed` (422) rather than
    // `runtime_unavailable` (503), and the whole build output is carried as
    // the hint because the last line of a docker build is rarely the line
    // that explains it.
    async build(spec: BuildSpec): Promise<string> {
      const streamed = spec.exclude !== undefined && spec.exclude.length > 0
      // In the streamed case the Dockerfile is an entry in the tar, named
      // by its basename, and docker is told to read the context from stdin.
      const args = ['build', '-f', streamed ? basename(spec.dockerfile) : spec.dockerfile, '-t', spec.tag]
      for (const [key, value] of Object.entries(spec.buildArgs ?? {})) {
        args.push('--build-arg', `${key}=${value}`)
      }
      args.push(streamed ? '-' : spec.contextPath)

      // The context as a tar built here, with the excluded patterns left
      // out and the Dockerfile appended from wherever it lives. `--exclude`
      // before the paths, which both GNU tar and bsdtar honour, and a bare
      // pattern (`node_modules`) matches that name at any depth in both. A
      // tar that fails (an unreadable file, a missing directory) fails the
      // build with tar's own words rather than docker's complaint about a
      // truncated stream.
      let tar: SpawnedProcess | undefined
      let tarStderr = ''
      let tarFailed: Promise<string | null> | undefined
      if (streamed) {
        tar = spawnFn('tar', [
          '-cf',
          '-',
          ...(spec.exclude ?? []).flatMap((pattern) => ['--exclude', pattern]),
          '-C',
          spec.contextPath,
          '.',
          '-C',
          dirname(spec.dockerfile),
          basename(spec.dockerfile),
        ])
        tar.stderr.setEncoding('utf8')
        tar.stderr.on('data', (chunk: string) => {
          tarStderr += chunk
        })
        const spawned = tar
        tarFailed = new Promise((resolve) => {
          spawned.once('error', (err) => resolve(err.message))
          spawned.once('close', (code) => resolve(code === 0 ? null : `tar exited with ${String(code)}: ${tarStderr.trim()}`))
        })
      }

      try {
        const { stdout, stderr } = await exec('docker', args, tar === undefined ? undefined : { stdin: tar.stdout })
        const tarError = tarFailed === undefined ? null : await tarFailed
        if (tarError !== null) {
          throw new HobbyError('build_failed', `could not assemble the build context for ${spec.tag}`, tarError)
        }
        // docker build writes its progress to stderr and only the final
        // image id to stdout, so a caller shown stdout alone sees nothing
        // useful.
        return `${stderr}${stdout}`
      } catch (err) {
        tar?.kill()
        if (err instanceof HobbyError) {
          throw err
        }
        const e = errorOf(err)
        throw new HobbyError(
          'build_failed',
          `docker build failed for ${spec.tag}`,
          `${e.stderr ?? ''}${e.stdout ?? ''}` || e.message || String(err)
        )
      }
    },

    // Every tag under one repository (issue #84). `docker images <repo>`
    // filters by repository name exactly, so `hobby/blog-web` never lists
    // `hobby/blog-web-worker`'s tags. A dangling layer shows as `<none>`
    // and is dropped: it is not a tag anything can remove by name.
    async listImages(repository: string): Promise<string[]> {
      try {
        const { stdout } = await exec('docker', ['images', '--format', '{{.Repository}}:{{.Tag}}', repository])
        return stdout
          .split('\n')
          .map((line) => line.trim())
          .filter((line) => line.length > 0 && !line.includes('<none>'))
      } catch (err) {
        throw toRuntimeUnavailable('docker images', err)
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

    // `docker exec <name> <command...>`, with stdout streamed. No -t: a
    // pseudo-terminal would rewrite the byte stream (ExecStream's comment,
    // runtime.ts). No -i either: nothing is ever written to the process, and
    // -i would only attach an stdin that is immediately at EOF. No --user:
    // the one caller (basebackup.ts) connects over the container's local
    // socket, where pg_hba's `local ... trust` does not care which OS user
    // asks, and the image's default user is what every other exec against
    // it would get too.
    //
    // docker exec exits with the command's own status, and with 1 plus a
    // message on stderr when the container is not running, so one non-zero
    // check covers both. cancel() kills the docker CLI; the process inside
    // the container then fails its next write to the closed stream and
    // exits, which for pg_basebackup also ends its walsender session.
    execStream(name: string, command: string[]): ExecStream {
      const child = spawnFn('docker', ['exec', name, ...command])
      let stderr = ''
      child.stderr.on('data', (chunk: Buffer) => {
        if (stderr.length < STDERR_LIMIT_BYTES) {
          stderr += chunk.toString('utf8')
        }
      })
      const done = new Promise<void>((resolve, reject) => {
        child.once('error', (err) => {
          reject(new HobbyError('runtime_unavailable', 'docker exec failed', err.message))
        })
        child.once('close', (code) => {
          if (code === 0) {
            resolve()
            return
          }
          reject(
            new HobbyError(
              'runtime_unavailable',
              `docker exec failed (exit ${code === null ? 'by signal' : code})`,
              stderr.trim() || 'no output on stderr'
            )
          )
        })
      })
      // Awaited by the caller only after stdout is drained, so a rejection
      // that lands first must not count as unhandled.
      done.catch(() => {})
      return { stdout: child.stdout, done, cancel: () => child.kill() }
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

// ---------------------------------------------------------------------------
// The Docker implementation of ElevatedTreeOps (packages/core/src/copy.ts):
// copy or remove a tree as root, inside a throwaway container, for a daemon
// that is not root on Linux and meets files a container's user owns. The
// shape is createDefaultRemoveDataDir's (packages/pg/src/postgres.ts), which
// has removed a PGDATA this way since before branching existed: bind-mount
// the parent, act on one entry under it, `--rm` the container.
//
// The image. Nothing is ever pulled for this: a cleanup that downloads an
// image is a surprise on a slow link and a failure on an offline box. The
// caller passes candidates in preference order (for a PGDATA, the resource's
// own postgres image; see packages/cli/src/daemon/tree-ops.ts for the full
// order), the first one `docker image inspect` finds locally is used, and
// `--pull never` on the run makes "no surprise pull" a property of the
// command rather than of the check before it. None local is an error that
// lists what was tried.
//
// Copy mechanism. `cp -a` (GNU or busybox) preserves owner, group, mode,
// timestamps and symlinks when run as root, which is what Postgres needs of a
// PGDATA. `cp -a --reflink=always` is tried first and, if it fails, the
// partial destination is removed and plain `cp -a` runs, reported as 'copy':
// the same "only claim a reflink that was forced" rule cloneTree keeps with
// COPYFILE_FICLONE_FORCE. busybox cp (postgres:*-alpine, caddy:*-alpine)
// has no --reflink at all, so the fallback in those images is always a full
// copy; GNU cp (debian-based images) reflinks on XFS or btrfs. Reflinking
// across two bind mounts fails with EXDEV (FICLONE requires one mount), so
// the copy mounts the deepest directory holding both src and dst, once.
//
// Measured on Docker Desktop 28.4.0 against a named volume (inside the VM,
// so real Linux ownership): a 0700 directory chowned to 70:70 was unreadable
// to a uid 1000 process (EACCES on scandir, the CI failure), and the root
// container's `cp -a` reproduced it at the destination as 70:70 0700 with
// postgres:18-alpine and postgres:16. Docker Desktop's file sharing masks
// uids on macOS bind mounts, so this is not proof of the Linux bind-mount
// case; the CI smoke job on ubuntu-latest is.
const CLONE_SCRIPT = [
  'src="$1"; dst="$2"',
  'if cp -a --reflink=always "$src" "$dst" 2>/dev/null; then m=reflink',
  'else rm -rf "$dst"; if ! cp -a "$src" "$dst"; then rm -rf "$dst"; exit 1; fi; m=copy; fi',
  'f=$(find "$dst" \\( -type f -o -type l \\) | wc -l)',
  'b=$(find "$dst" -type f -exec stat -c %s {} + | awk \'{s+=$1} END {printf "%.0f", s}\')',
  'echo "hobby-clone $m $f $b"',
].join('\n')

const MOUNT = '/hobby'

// The deepest directory containing both paths. Both are resolved first, so a
// relative or dotted path cannot climb out of what is mounted.
export function commonAncestor(a: string, b: string): string {
  let dir = resolve(a)
  const other = resolve(b)
  for (;;) {
    const rel = relative(dir, other)
    if (rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))) {
      return dir
    }
    const parent = dirname(dir)
    if (parent === dir) {
      return dir
    }
    dir = parent
  }
}

function inMount(root: string, path: string): string {
  const rel = relative(root, resolve(path))
  return rel === '' ? MOUNT : `${MOUNT}/${rel.split(sep).join('/')}`
}

export function parseCloneOutput(stdout: string): CloneResult {
  const line = stdout
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.startsWith('hobby-clone '))
  const parts = line?.split(/\s+/) ?? []
  const mechanism = parts[1]
  const files = Number(parts[2])
  const bytes = Number(parts[3])
  if ((mechanism !== 'reflink' && mechanism !== 'copy') || !Number.isFinite(files) || !Number.isFinite(bytes)) {
    throw new Error(`the copy container did not report what it copied (output: ${JSON.stringify(stdout.trim())})`)
  }
  return { mechanism: mechanism as CloneMechanism, files, bytes }
}

export function createContainerTreeOps(opts: { images: string[]; exec?: ExecFn }): ElevatedTreeOps {
  const exec = opts.exec ?? defaultExec
  const candidates = [...new Set(opts.images.filter((image) => image.length > 0))]
  let chosen: Promise<string> | null = null

  async function localImage(): Promise<string> {
    for (const image of candidates) {
      try {
        await exec('docker', ['image', 'inspect', '--format', '{{.Id}}', image])
        return image
      } catch {
        // Not local (or Docker unreachable, which the run below reports).
      }
    }
    throw new Error(
      `no local image to run it in (tried ${candidates.length === 0 ? 'none' : candidates.join(', ')}); nothing is pulled for this`
    )
  }

  function image(): Promise<string> {
    chosen ??= localImage().catch((err: unknown) => {
      chosen = null
      throw err
    })
    return chosen
  }

  async function run(args: string[]): Promise<string> {
    try {
      const { stdout } = await exec('docker', args)
      return stdout
    } catch (err: unknown) {
      const e = errorOf(err)
      const detail = (e.stderr ?? '').trim() || e.message || String(err)
      throw new Error(`docker run exited with an error: ${detail}`)
    }
  }

  return {
    async clone(src: string, dst: string): Promise<CloneResult> {
      const root = commonAncestor(src, dirname(dst))
      const img = await image()
      const stdout = await run([
        'run', '--rm', '--pull', 'never', '--user', '0:0', '--entrypoint', 'sh',
        '-v', `${root}:${MOUNT}`,
        img, '-c', CLONE_SCRIPT, 'sh', inMount(root, src), inMount(root, dst),
      ])
      return parseCloneOutput(stdout)
    },

    async remove(path: string): Promise<void> {
      const target = resolve(path)
      const parent = dirname(target)
      const img = await image()
      await run([
        'run', '--rm', '--pull', 'never', '--user', '0:0', '--entrypoint', 'rm',
        '-v', `${parent}:${MOUNT}`,
        img, '-rf', `${MOUNT}/${basename(target)}`,
      ])
    },
  }
}
