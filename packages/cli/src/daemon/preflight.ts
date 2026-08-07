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
import { dirname } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { DaemonContext } from './context.js'

const execFileAsync = promisify(execFile)

const PORT_PROBE_HOST = '127.0.0.1'

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

export async function runPreflight(ctx: DaemonContext): Promise<PreflightReport> {
  const probeDir = await nearestExistingDir(ctx.paths.home)

  const [runtimeAvailable, reflinkSupported, fsStats, proxyBound, studioBound] = await Promise.all([
    ctx.runtime.available(),
    detectReflinkSupport(probeDir),
    statfs(probeDir),
    isPortBound(ctx.config.proxyPort, PORT_PROBE_HOST),
    isPortBound(ctx.config.studioPort, PORT_PROBE_HOST),
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
  }
}
