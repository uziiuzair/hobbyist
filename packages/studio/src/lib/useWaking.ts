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

import { useCallback, useEffect, useRef, useState } from 'react'
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

// onWoke fires once a run that began against a sleeping database settles,
// whether it succeeded or failed. Without it the database is genuinely awake
// and every state label in the interface still says sleeping until a reload:
// the query wakes the container, but nothing tells the views or the rail that
// the world changed underneath them.
export function useWakeAwareRun(onWoke?: () => void): { snapshot: WakingSnapshot; run: <T>(resourceId: string, initialState: Resource['state'], task: () => Promise<T>) => Promise<T> } {
  const [snapshot, setSnapshot] = useState<WakingSnapshot>(IDLE)
  const wokeRef = useRef(onWoke)
  wokeRef.current = onWoke

  // Views legitimately fire more than one request at once: Tables loads the
  // table list and the first page of rows together, and both can be the call
  // that wakes the database. The previous shape kept a single timer pair and a
  // single start time, so the second run overwrote the first's interval (a
  // permanent leak) and the first to finish called setSnapshot(IDLE), erasing
  // the banner while the other request was still waking the same database.
  // In flight is now counted, the clock is anchored to the earliest start, and
  // the banner only clears when the last request settles.
  const state = useRef<{
    inFlight: number
    startedAt: number | null
    tick: ReturnType<typeof setInterval> | null
    poll: ReturnType<typeof setInterval> | null
  }>({ inFlight: 0, startedAt: null, tick: null, poll: null })

  const stopTimers = useCallback(() => {
    if (state.current.tick !== null) clearInterval(state.current.tick)
    if (state.current.poll !== null) clearInterval(state.current.poll)
    state.current.tick = null
    state.current.poll = null
  }, [])

  // Unmounting mid-wake would otherwise leave both intervals running against a
  // component that no longer exists.
  useEffect(() => stopTimers, [stopTimers])

  const run = useCallback(
    async <T,>(resourceId: string, initialState: Resource['state'], task: () => Promise<T>): Promise<T> => {
      const startedAsleep = initialState !== 'running'
      const first = state.current.inFlight === 0
      state.current.inFlight += 1
      if (state.current.startedAt === null) state.current.startedAt = Date.now()
      const anchor = state.current.startedAt

      if (first || startedAsleep) {
        setSnapshot((prev) =>
          startedAsleep || prev.phase === 'idle'
            ? { phase: startedAsleep ? 'waking' : 'running', elapsedMs: Date.now() - anchor, resourceState: initialState }
            : prev,
        )
      }

      if (state.current.tick === null) {
        state.current.tick = setInterval(() => {
          setSnapshot((prev) =>
            prev.phase === 'idle' ? prev : { ...prev, elapsedMs: Date.now() - anchor },
          )
        }, TICK_INTERVAL_MS)
      }

      if (startedAsleep && state.current.poll === null) {
        state.current.poll = setInterval(() => {
          getResource(resourceId)
            .then(({ resource }) => {
              setSnapshot((prev) => (prev.phase === 'waking' ? { ...prev, resourceState: resource.state } : prev))
            })
            .catch(() => {
              // Best effort: the task's own error handling below is authoritative.
            })
        }, POLL_INTERVAL_MS)
      }

      const settle = (): boolean => {
        state.current.inFlight -= 1
        if (state.current.inFlight > 0) return false
        stopTimers()
        state.current.startedAt = null
        return true
      }

      try {
        const result = await task()
        if (settle()) setSnapshot(IDLE)
        if (startedAsleep) wokeRef.current?.()
        return result
      } catch (err) {
        const elapsed = Date.now() - anchor
        // A failed wake keeps its narrative. Clearing it here left the user with
        // a bare error and no account of the twenty seconds that preceded it.
        if (settle()) setSnapshot({ phase: 'error', elapsedMs: elapsed, resourceState: null })
        // Still refresh: a failed wake usually leaves the resource in a state
        // worth seeing, and showing the old one would be a second lie.
        if (startedAsleep) wokeRef.current?.()
        throw err
      }
    },
    [stopTimers],
  )

  return { snapshot, run }
}
