import { Client } from 'pg'
import { sleep, type Fixture } from './fixture.ts'

export type WaitOpts = {
  probe: () => Promise<boolean>
  pollMs: number
  timeoutMs: number
  now?: () => number
  sleepFor?: (ms: number) => Promise<void>
}

export type WaitResult = { ready: boolean; attempts: number; waitedMs: number }

export async function waitReady(opts: WaitOpts): Promise<WaitResult> {
  const now = opts.now ?? Date.now
  const sleepFor = opts.sleepFor ?? sleep
  const startedAt = now()
  let attempts = 0

  for (;;) {
    attempts++
    if (await opts.probe()) {
      return { ready: true, attempts, waitedMs: now() - startedAt }
    }
    if (now() - startedAt >= opts.timeoutMs) {
      return { ready: false, attempts, waitedMs: now() - startedAt }
    }
    await sleepFor(opts.pollMs)
  }
}

export function pgProbe(f: Fixture): () => Promise<boolean> {
  return async () => {
    const client = new Client({
      host: '127.0.0.1',
      port: f.hostPort,
      user: f.user,
      password: f.password,
      database: f.database,
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
}
