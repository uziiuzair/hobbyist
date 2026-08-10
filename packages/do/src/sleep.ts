// The sleep policy for a Durable Object namespace. Pure: every value it needs
// is handed in, nothing here reaches for the clock, the store, the filesystem
// or a runtime, so the whole decision table is testable in a plain loop.
//
// Deliberately the same shape as shouldSleep in
// packages/cli/src/daemon/hibernator.ts:32, because the hibernator is what
// calls it and one policy function that looks like another is easier to keep
// honest than two that diverge. It adds exactly one rule to that function's:
// an imminent alarm blocks sleep.

import type { ResourceState } from '@hobby.sh/core'

export interface ShouldSleepNamespaceInput {
  state: ResourceState
  idleSeconds: number | null
  sleepAfterSeconds: number | null
  // The earliest pending alarm, from alarms.ts's nextAlarmAtMs. null means
  // nothing is scheduled, which is the common case and never blocks sleep.
  nextAlarmAtMs: number | null
  nowMs: number
  wakeGraceSeconds: number
}

// True only when every one of these holds:
//   - sleepAfterSeconds is not null (null means pinned, checked first as the
//     cheapest possible rejection, matching hibernator.ts)
//   - state is exactly 'running'
//   - idleSeconds is known and at or above the threshold
//   - no alarm is due within wakeGraceSeconds
export function shouldSleepNamespace(input: ShouldSleepNamespaceInput): boolean {
  if (input.sleepAfterSeconds === null) {
    return false
  }
  if (input.state !== 'running') {
    return false
  }
  if (input.idleSeconds === null) {
    return false
  }
  if (input.idleSeconds < input.sleepAfterSeconds) {
    return false
  }
  if (isAlarmImminent(input.nextAlarmAtMs, input.nowMs, input.wakeGraceSeconds)) {
    return false
  }
  return true
}

// Stopping a container at 02:59:58 in order to start it again at 03:00:00 pays
// a full cold start to buy two seconds of idle memory on a box the owner
// already has. The grace window is the amount of "about to be needed" that is
// not worth sleeping through.
//
// An *overdue* alarm deliberately does not block sleep. A namespace stopped
// with a deadline already in the past is the mirror's problem, not the
// predicate's: startAlarmMirror wakes it. If both rules fired, a namespace
// with a permanently unfireable alarm would be pinned awake forever by the
// predicate while the mirror kept waking it, and the two would be arguing
// about the same row.
export function isAlarmImminent(
  nextAlarmAtMs: number | null,
  nowMs: number,
  wakeGraceSeconds: number
): boolean {
  if (nextAlarmAtMs === null) {
    return false
  }
  if (nextAlarmAtMs < nowMs) {
    return false
  }
  return nextAlarmAtMs - nowMs <= wakeGraceSeconds * 1000
}

// A namespace is due when its earliest alarm has arrived. Deliberately `<=`
// and deliberately not "within the next tick": the mirror polls, so an alarm
// set for a moment between two ticks is picked up by the later one, one
// interval late at worst. Trying to wake early to compensate would mean
// guessing the interval here, and the interval belongs to the caller.
export function isAlarmDue(nextAlarmAtMs: number | null, nowMs: number): boolean {
  if (nextAlarmAtMs === null) {
    return false
  }
  return nextAlarmAtMs <= nowMs
}
