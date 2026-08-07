// The interaction the whole product rests on: a query against a sleeping
// database has to say so, with the database's name and a running clock,
// rather than hang behind a bare spinner. See root CLAUDE.md's "the
// keystone" and docs/studio/CLAUDE.md's open question, which this answers.
//
// Studio never talks to Postgres directly, so it cannot watch a wake happen
// over the wire the way the proxy does. What it can do: check the
// resource's state before firing the request (already known from the
// Project/Tables/Sql view that called in), and if it was not "running",
// assume this call is the one waking it and say so immediately, then poll
// GET /v1/resources/:id (a route that already exists) in the background
// to refine the message while the real request is in flight.
//
// If the resource was already running, the elapsed clock still ticks: a
// query that is merely slow deserves the same "this is bounded and being
// worked on" treatment once it crosses a noticeable threshold, just phrased
// differently. See WakingBanner.tsx for how the two phases render.

import { useCallback, useRef, useState } from 'react'
import type { Resource } from '@hobby.sh/core'
import { getResource } from '../api.js'

export type WakingPhase = 'idle' | 'waking' | 'running' | 'error'

export interface WakingSnapshot {
  phase: WakingPhase
  elapsedMs: number
  resourceState: Resource['state'] | null
}

const TICK_INTERVAL_MS = 100
const POLL_INTERVAL_MS = 700

const IDLE: WakingSnapshot = { phase: 'idle', elapsedMs: 0, resourceState: null }

export function useWakeAwareRun(): { snapshot: WakingSnapshot; run: <T>(resourceId: string, initialState: Resource['state'], task: () => Promise<T>) => Promise<T> } {
  const [snapshot, setSnapshot] = useState<WakingSnapshot>(IDLE)
  const timersRef = useRef<{ tick: ReturnType<typeof setInterval> | null; poll: ReturnType<typeof setInterval> | null }>({
    tick: null,
    poll: null,
  })

  const stopTimers = useCallback(() => {
    if (timersRef.current.tick !== null) clearInterval(timersRef.current.tick)
    if (timersRef.current.poll !== null) clearInterval(timersRef.current.poll)
    timersRef.current.tick = null
    timersRef.current.poll = null
  }, [])

  const run = useCallback(
    async <T,>(resourceId: string, initialState: Resource['state'], task: () => Promise<T>): Promise<T> => {
      const startedAt = Date.now()
      const startedAsleep = initialState !== 'running'

      setSnapshot({ phase: startedAsleep ? 'waking' : 'running', elapsedMs: 0, resourceState: initialState })

      timersRef.current.tick = setInterval(() => {
        setSnapshot((prev) => (prev.phase === 'idle' || prev.phase === 'error' ? prev : { ...prev, elapsedMs: Date.now() - startedAt }))
      }, TICK_INTERVAL_MS)

      if (startedAsleep) {
        timersRef.current.poll = setInterval(() => {
          getResource(resourceId)
            .then(({ resource }) => {
              setSnapshot((prev) => (prev.phase === 'waking' ? { ...prev, resourceState: resource.state } : prev))
            })
            .catch(() => {
              // Best-effort: the task's own error handling below is
              // authoritative if the actual query call fails.
            })
        }, POLL_INTERVAL_MS)
      }

      try {
        const result = await task()
        stopTimers()
        setSnapshot(IDLE)
        return result
      } catch (err) {
        stopTimers()
        setSnapshot({ phase: 'error', elapsedMs: Date.now() - startedAt, resourceState: null })
        throw err
      }
    },
    [stopTimers]
  )

  return { snapshot, run }
}
