// "Is the process inside actually listening?", which is a different question
// from "is the container running". The distinction is the same one
// reconcile.ts already learned the hard way for Postgres: a container's
// published port exists the instant the container starts, and a process that
// has not bound it yet, or has bound the wrong address, looks identical from
// the outside until you try to connect.

import net from 'node:net'

export interface TcpProbeOptions {
  host: string
  port: number
  timeoutMs: number
}

// One attempt. Resolves true or false, never throws, so a caller can poll it
// in a loop without a try/catch per attempt. Same contract as
// @hobby.sh/pg's pgProbe.
export function tcpProbe(opts: TcpProbeOptions): () => Promise<boolean> {
  return function probe(): Promise<boolean> {
    return new Promise((resolve) => {
      const socket = new net.Socket()
      let settled = false
      const finish = (value: boolean): void => {
        if (settled) return
        settled = true
        socket.destroy()
        resolve(value)
      }
      socket.setTimeout(opts.timeoutMs)
      socket.once('connect', () => finish(true))
      socket.once('timeout', () => finish(false))
      socket.once('error', () => finish(false))
      socket.connect(opts.port, opts.host)
    })
  }
}

export interface WaitReadyResult {
  ready: boolean
  waitedMs: number
  attempts: number
}

// Polls until the probe says yes or the budget runs out. `now` and `sleepFor`
// are injectable for the same reason they are in @hobby.sh/pg's waitReady:
// the whole timeout path is testable with no real waiting.
export async function waitListening(opts: {
  probe: () => Promise<boolean>
  pollMs: number
  timeoutMs: number
  now?: () => number
  sleepFor?: (ms: number) => Promise<void>
}): Promise<WaitReadyResult> {
  const now = opts.now ?? Date.now
  const sleepFor = opts.sleepFor ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const started = now()
  const deadline = started + opts.timeoutMs
  let attempts = 0

  for (;;) {
    attempts++
    if (await opts.probe()) {
      return { ready: true, waitedMs: now() - started, attempts }
    }
    if (now() >= deadline) {
      return { ready: false, waitedMs: now() - started, attempts }
    }
    await sleepFor(opts.pollMs)
  }
}
