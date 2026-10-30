// "Is the process inside actually listening?", which is a different question
// from "is the container running". The distinction is the same one
// reconcile.ts already learned the hard way for Postgres: a container's
// published port exists the instant the container starts, and a process that
// has not bound it yet, or has bound the wrong address, looks identical from
// the outside until you try to connect.

import net from 'node:net'
import type { ContainerStatus } from '@hobby.sh/core'

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
//
// A connection that is accepted and then HELD, with nothing written back
// for the whole window, also counts (issue #79). The two shapes docker's
// port proxy produces for a container with nothing listening inside are a
// refused dial and an accept followed at once by a close, never a socket
// that stays open: the proxy only keeps it open once its own dial into
// the container has succeeded, which means a process is listening. So a
// quiet, open socket is "listening, and slow to answer `/`", which is
// what a server-rendered homepage that queries a database on every
// request looks like, and before this it was indistinguishable from
// "nothing is listening" and failed every deploy with the loopback-bind
// hint. The window is still short on purpose: a fast server answers in
// milliseconds and pays none of it.
export function tcpProbe(opts: TcpProbeOptions): () => Promise<boolean> {
  return function probe(): Promise<boolean> {
    return new Promise((resolve) => {
      const socket = new net.Socket()
      let settled = false
      let connected = false
      const finish = (value: boolean): void => {
        if (settled) return
        settled = true
        socket.destroy()
        resolve(value)
      }
      socket.setTimeout(opts.timeoutMs)
      socket.once('connect', () => {
        connected = true
        socket.write('GET / HTTP/1.1\r\nHost: hobby.probe\r\nConnection: close\r\n\r\n')
      })
      socket.once('data', (chunk: Buffer) => {
        finish(chunk.subarray(0, 5).toString('latin1') === 'HTTP/')
      })
      // A socket that connects and then closes with nothing written is the
      // exact shape of "docker accepted, the process is gone".
      socket.once('end', () => finish(false))
      socket.once('close', () => finish(false))
      socket.once('timeout', () => finish(connected))
      socket.once('error', () => finish(false))
      socket.connect(opts.port, opts.host)
    })
  }
}

export interface WaitReadyResult {
  ready: boolean
  waitedMs: number
  attempts: number
  // Set when the wait ended early because the container stopped running
  // (issue #55): a process that crashed on boot is never going to listen,
  // and waiting out the whole timeout for it cost 30 seconds on every deploy
  // and every first request. Absent on success and on a plain timeout.
  exited?: { exitCode: number | null }
}

// Whether a container that was started has since stopped. `exists` guards
// against reading a container that was never created as "exited".
export function hasExited(status: ContainerStatus): boolean {
  return status.exists && !status.running
}

// Polls until the probe says yes, the container exits, or the budget runs
// out. `now` and `sleepFor` are injectable for the same reason they are in
// @hobby.sh/pg's waitReady: the whole timeout path is testable with no real
// waiting.
export async function waitListening(opts: {
  probe: () => Promise<boolean>
  pollMs: number
  timeoutMs: number
  // Consulted after each failed probe. Omitted by callers that have no
  // container to ask about (tests of the loop itself).
  status?: () => Promise<ContainerStatus>
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
    if (opts.status !== undefined) {
      // Best effort: an inspect that fails says nothing about the process,
      // so the loop keeps polling as it did before this check existed.
      const status = await opts.status().catch(() => null)
      if (status !== null && hasExited(status)) {
        return { ready: false, waitedMs: now() - started, attempts, exited: { exitCode: status.exitCode } }
      }
    }
    if (now() >= deadline) {
      return { ready: false, waitedMs: now() - started, attempts }
    }
    await sleepFor(opts.pollMs)
  }
}

// The last lines a container printed, for the hint of a crash error. Best
// effort and bounded: a runtime that cannot produce logs yields an empty
// string, never a second error on top of the crash.
export async function logTail(
  logs: (name: string, opts: { tail: number }) => Promise<string>,
  containerName: string,
  lines: number = 20
): Promise<string> {
  try {
    const text = await logs(containerName, { tail: lines })
    return text.trim()
  } catch {
    return ''
  }
}
