// GET /v1/preflight backs both `hobby init` and Studio's setup screen, and
// the brief is explicit that it must never mutate anything, so both can call
// it as often as they like. "Never mutates" is about daemon and application
// state (the store, projects, resources): it does not forbid the read-only
// filesystem syscalls (statfs) or the brief-and-clean temp-file probe below,
// both of which are the only real way to answer "does this filesystem
// support reflinks" without guessing from a filesystem type name, which is
// unreliable across XFS-with-reflinks-disabled, ext4, and every BSD variant
// APFS reports itself as depending on OS version.

import { randomUUID } from 'node:crypto'
import { rm, stat, statfs, writeFile } from 'node:fs/promises'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { DaemonContext } from './context.js'

const execFileAsync = promisify(execFile)

const PORT_PROBE_HOST = '127.0.0.1'

// The same image packages/cli/src/daemon/caddy.ts's CaddyManager starts
// once the daemon is actually running (its own CADDY_IMAGE constant). Kept
// as a separate constant rather than imported so this probe has no
// compile-time dependency on that file's internals, and reusing the tag
// rather than inventing a second throwaway image means a host that can run
// Caddy at all never pays for a second image pull just to preflight it.
const HOST_NETWORKING_PROBE_IMAGE = 'caddy:2-alpine'

// How long the probe waits, in total, for the throwaway Caddy's admin API
// to answer once its container has been asked to start. `start()` resolving
// only means the container was asked to run, not that the process inside
// has bound its port yet, so this is a poll budget, not a single attempt.
// Measured boot time on this box (2026-08-14, OrbStack): about 160ms; this
// leaves close to 10x margin for a loaded CI box or a cold layer cache.
const HOST_NETWORKING_CONNECT_TIMEOUT_MS = 1_500

// Bounds the entire probe: container create, start, the admin-API round
// trip above, and cleanup. Every outbound call in this repo is bounded, by
// convention documented at packages/proxy/src/proxy.ts:198,
// packages/proxy/src/http.ts:274 and packages/worker/src/worker.ts:280, and
// written down nowhere else; this is that convention applied here. A hang
// must not hang `hobby init`.
const HOST_NETWORKING_PROBE_TIMEOUT_MS = 5_000

export interface PreflightReport {
  runtimeAvailable: boolean
  filesystem: {
    // The directory the probe actually ran against: paths.home if it
    // already exists, otherwise the nearest existing ancestor. Reported so
    // a reader is never misled into thinking ~/.hobby itself was checked
    // when it does not exist yet.
    path: string
    reflinkSupported: boolean
    freeBytes: number
  }
  ports: {
    proxy: { port: number; bound: boolean }
    studio: { port: number; bound: boolean }
  }
  // Only meaningful when caddy is enabled, so it is null when it is not
  // rather than a fabricated "true": a check that did not run must not
  // read as a check that passed.
  hostNetworking: { supported: boolean } | null
}

// paths.home may not exist yet on a first-ever `hobby init`, and preflight
// must not create it (that would be a mutation from a read-only endpoint).
// Reflink support is a property of the filesystem/mount, which every
// ancestor directory shares, so walking up to the nearest directory that
// does exist is a faithful stand-in.
async function nearestExistingDir(path: string): Promise<string> {
  let dir = path
  for (;;) {
    try {
      const info = await stat(dir)
      if (info.isDirectory()) return dir
    } catch {
      // does not exist, keep walking up
    }
    const parent = dirname(dir)
    if (parent === dir) return dir
    dir = parent
  }
}

// The only trustworthy reflink test is a real one: write a small file and
// ask the OS to clone it, then check whether the clone actually happened.
// `cp -c` is APFS's clonefile path on macOS; GNU coreutils' `cp
// --reflink=always` is the equivalent on Linux and fails outright (rather
// than silently falling back to a real copy) when the filesystem cannot do
// it, which is exactly the signal wanted here. Both the probe files are
// removed unconditionally in `finally`, so a failed probe leaves nothing
// behind.
async function detectReflinkSupport(dir: string): Promise<boolean> {
  const token = randomUUID()
  const src = `${dir}/.hobby-preflight-src-${token}`
  const dst = `${dir}/.hobby-preflight-dst-${token}`
  try {
    await writeFile(src, 'hobby reflink preflight probe\n')
    if (process.platform === 'darwin') {
      await execFileAsync('cp', ['-c', src, dst])
    } else {
      await execFileAsync('cp', ['--reflink=always', src, dst])
    }
    return true
  } catch {
    return false
  } finally {
    await rm(src, { force: true })
    await rm(dst, { force: true })
  }
}

// Binds a throwaway server to the port and immediately releases it.
// EADDRINUSE means something else is already listening; any other outcome
// means the port is free. This is the only reliable, cross-platform way to
// answer "is this port already bound" without a native syscall binding, and
// releasing the socket the instant it binds leaves no observable trace.
function isPortBound(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer()
    server.once('error', (err: NodeJS.ErrnoException) => {
      resolve(err.code === 'EADDRINUSE')
    })
    server.once('listening', () => {
      server.close(() => resolve(false))
    })
    server.listen(port, host)
  })
}

// Same bind-then-release trick as isPortBound above, but returns the port
// the OS actually assigned rather than a boolean: the host-networking probe
// below needs a genuinely free admin port to hand the throwaway Caddy
// container before that container exists. Port 0 rather than a fixed
// literal, so two concurrent preflight calls (Studio's setup screen can
// poll this endpoint repeatedly) never race each other for the same port.
function reserveEphemeralPort(host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.once('listening', () => {
      const address = server.address()
      if (address === null || typeof address === 'string') {
        server.close(() => reject(new Error('expected a TCP AddressInfo from an ephemeral listener')))
        return
      }
      const { port } = address
      server.close(() => resolve(port))
    })
    server.listen(0, host)
  })
}

// Polls rather than firing one fetch right after start(): start() resolving
// only means the container was asked to run, not that the process inside it
// has bound its admin port yet. Any response at all, not just a 2xx, is the
// signal: nothing would answer on this port over loopback at all unless the
// container's network namespace really is the host's.
//
// Exported and reused by caddy.ts's CaddyManager.ensureRunning, which polls
// the production Caddy container's admin API for exactly the reason this
// probe polls the throwaway one's: one implementation of "wait for an HTTP
// admin listener to come up," not two copies that can drift. `fetchFn`
// defaults to the real `fetch` here (this file has no injected one), while
// caddy.ts passes its own so its tests never make a real network call.
export async function waitForHttpReachable(
  url: string,
  deadlineMs: number,
  fetchFn: typeof fetch = fetch
): Promise<boolean> {
  const deadline = Date.now() + deadlineMs
  for (;;) {
    try {
      const res = await fetchFn(url, { signal: AbortSignal.timeout(400) })
      await res.body?.cancel()
      return true
    } catch {
      if (Date.now() >= deadline) {
        return false
      }
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
  }
}

// The probe itself: start a throwaway Caddy container with `network:
// 'host'` (the exact mode caddy.ts's real CaddyManager uses, see its own
// comment on ensureRunning) and confirm the daemon process can reach a
// loopback listener inside it. ContainerSpec has no way to override a
// container's command (caddy.ts's own file comment says so), so the
// throwaway container cannot be told to dial back out and report a result
// itself; instead this writes a minimal Caddyfile that only turns on
// Caddy's admin API, on an ephemeral port, with no site block (so it never
// touches :80, which may already be legitimately in use on the box), bind-
// mounts it over the image's default Caddyfile, and then this process
// itself, not the container, does the reaching. If the two share a real
// network namespace, connecting from here to that port over 127.0.0.1
// succeeds; if the runtime only gave the container its own namespace with a
// "host" label that does not actually bridge to this box's loopback
// (Docker Desktop for macOS's known failure mode), nothing ever answers.
async function probeHostNetworking(ctx: DaemonContext): Promise<boolean> {
  const token = randomUUID()
  const caddyfilePath = join(tmpdir(), `.hobby-preflight-caddyfile-${token}`)
  const containerName = `hobby-preflight-hostnet-${token}`
  const adminPort = await reserveEphemeralPort(PORT_PROBE_HOST)
  try {
    await writeFile(caddyfilePath, `{\n\tadmin ${PORT_PROBE_HOST}:${adminPort}\n}\n`)
    await ctx.runtime.ensureCreated({
      name: containerName,
      image: HOST_NETWORKING_PROBE_IMAGE,
      env: {},
      ports: [],
      binds: [{ host: caddyfilePath, container: '/etc/caddy/Caddyfile' }],
      network: 'host',
    })
    await ctx.runtime.start(containerName)
    return await waitForHttpReachable(
      `http://${PORT_PROBE_HOST}:${adminPort}/config/`,
      HOST_NETWORKING_CONNECT_TIMEOUT_MS
    )
  } finally {
    await ctx.runtime.stop(containerName, { timeoutSec: 1 }).catch(() => {})
    await ctx.runtime.remove(containerName).catch(() => {})
    await rm(caddyfilePath, { force: true })
  }
}

// Races the probe against an overall deadline so a stuck runtime (a hung
// docker daemon, a slow image pull) cannot make `hobby init` hang. The
// loser is not cancelled, since ComputeRuntime has no way to abort
// ensureCreated/start mid-flight, so a genuinely stuck runtime may still
// finish, or leak the throwaway container, after this has already
// returned; that trade favors a command that returns over one that is
// guaranteed to leave nothing behind. Any rejection along the way (runtime
// unavailable, image pull failure) resolves to `false` the same way a
// timeout does: this check only ever warns, never fails `hobby init`, and
// the safe default when the answer is unknown is to warn.
function withTimeout<T>(promise: Promise<T>, ms: number, onTimeout: T): Promise<T> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(onTimeout), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      () => {
        clearTimeout(timer)
        resolve(onTimeout)
      }
    )
  })
}

// Only meaningful, and only ever called, when ctx.config.caddyEnabled is
// true (see runPreflight): probing costs a real container start, which is
// wasted work when Caddy is off and the answer is irrelevant.
async function detectHostNetworking(ctx: DaemonContext): Promise<boolean> {
  return withTimeout(probeHostNetworking(ctx), HOST_NETWORKING_PROBE_TIMEOUT_MS, false)
}

export async function runPreflight(ctx: DaemonContext): Promise<PreflightReport> {
  const probeDir = await nearestExistingDir(ctx.paths.home)

  // Gated on caddyEnabled before the container ever starts, not after: a
  // Promise.resolve(null) here is what keeps a disabled caddy from ever
  // asking ctx.runtime to do anything at all, which is exactly what the
  // "check does not run" test below asserts.
  const [runtimeAvailable, reflinkSupported, fsStats, proxyBound, studioBound, hostNetworkingSupported] =
    await Promise.all([
      ctx.runtime.available(),
      detectReflinkSupport(probeDir),
      statfs(probeDir),
      isPortBound(ctx.config.proxyPort, PORT_PROBE_HOST),
      isPortBound(ctx.config.studioPort, PORT_PROBE_HOST),
      ctx.config.caddyEnabled ? detectHostNetworking(ctx) : Promise.resolve(null),
    ])

  return {
    runtimeAvailable,
    filesystem: {
      path: probeDir,
      reflinkSupported,
      freeBytes: fsStats.bavail * fsStats.bsize,
    },
    ports: {
      proxy: { port: ctx.config.proxyPort, bound: proxyBound },
      studio: { port: ctx.config.studioPort, bound: studioBound },
    },
    hostNetworking: hostNetworkingSupported === null ? null : { supported: hostNetworkingSupported },
  }
}
