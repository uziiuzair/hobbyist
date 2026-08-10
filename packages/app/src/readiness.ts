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
//
// It sends a real request and requires a real response, and that is not
// belt-and-braces. A plain TCP connect CANNOT answer this question against a
// published container port: Docker's own port proxy binds the host port the
// instant the container is created, so `connect()` succeeds while the process
// inside is still starting, has crashed, or never existed. Verified by
// running it: a worker whose runner exited 1 immediately still passed a TCP
// probe, was recorded `running`, and then refused every request with "other
// side closed".
//
// This is the same bug reconcile.ts documents at length for Postgres, where
// trusting `docker inspect` reported `running` for a database that answered
// `FATAL: the database system is starting up`. The lesson did not transfer
// automatically to a new kind, which is worth knowing for the next one.
//
// Any status line counts, 404 and 500 included: the question is whether the
// server is serving, not whether it likes this request. `Connection: close`
// so a keep-alive server does not hold the socket open past the answer, and a
// deliberately odd Host header so nothing routes on it.
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
      socket.once('connect', () => {
        socket.write('GET / HTTP/1.1\r\nHost: hobby.probe\r\nConnection: close\r\n\r\n')
      })
      socket.once('data', (chunk: Buffer) => {
        finish(chunk.subarray(0, 5).toString('latin1') === 'HTTP/')
      })
      // A socket that connects and then closes with nothing written is the
      // exact shape of "docker accepted, the process is gone".
      socket.once('end', () => finish(false))
      socket.once('close', () => finish(false))
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
