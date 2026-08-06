import { mkdirSync } from 'node:fs'
import { Client } from 'pg'
import { create, start, stopClean, removeIfExists } from './runtime.ts'

export type FixtureOpts = {
  name: string
  image: string
  hostPort: number
  dataDir: string
}

export type Fixture = {
  name: string
  image: string
  hostPort: number
  dataDir: string
  password: string
  user: string
  database: string
}

const PASSWORD = 'spike'
const USER = 'postgres'
const DATABASE = 'postgres'

export async function prepareFixture(opts: FixtureOpts): Promise<Fixture> {
  await removeIfExists(opts.name)
  mkdirSync(opts.dataDir, { recursive: true })
  await create({
    name: opts.name,
    image: opts.image,
    hostPort: opts.hostPort,
    password: PASSWORD,
    dataDir: opts.dataDir,
  })

  // First boot runs initdb. Wait for it, then shut down cleanly so that every
  // measured start begins from a clean data directory rather than recovery.
  await start(opts.name)
  const deadline = Date.now() + 120_000
  for (;;) {
    if (await canConnect(opts.hostPort)) break
    if (Date.now() > deadline) throw new Error('fixture never became ready')
    await sleep(200)
  }
  await stopClean(opts.name)

  return {
    name: opts.name,
    image: opts.image,
    hostPort: opts.hostPort,
    dataDir: opts.dataDir,
    password: PASSWORD,
    user: USER,
    database: DATABASE,
  }
}

async function canConnect(port: number): Promise<boolean> {
  const client = new Client({
    host: '127.0.0.1',
    port,
    user: USER,
    password: PASSWORD,
    database: DATABASE,
    connectionTimeoutMillis: 1000,
  })
  try {
    await client.connect()
    await client.end()
    return true
  } catch {
    return false
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
