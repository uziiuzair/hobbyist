import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(execFile)

export type CreateOpts = {
  name: string
  image: string
  hostPort: number
  password: string
  dataDir: string
}

export async function create(opts: CreateOpts): Promise<void> {
  await run('docker', [
    'create',
    '--name', opts.name,
    '-e', `POSTGRES_PASSWORD=${opts.password}`,
    '-p', `${opts.hostPort}:5432`,
    '-v', `${opts.dataDir}:/var/lib/postgresql/data`,
    opts.image,
  ])
}

export async function start(name: string): Promise<void> {
  await run('docker', ['start', name])
}

export async function stopClean(name: string, timeoutSec = 30): Promise<void> {
  await run('docker', ['stop', '-t', String(timeoutSec), name])
}

export async function killHard(name: string): Promise<void> {
  await run('docker', ['kill', name])
}

export async function isRunning(name: string): Promise<boolean> {
  try {
    const { stdout } = await run('docker', ['inspect', '-f', '{{.State.Running}}', name])
    return stdout.trim() === 'true'
  } catch {
    return false
  }
}

export async function removeIfExists(name: string): Promise<void> {
  try {
    await run('docker', ['rm', '-f', '-v', name])
  } catch {
    // already gone, which is the desired state
  }
}
