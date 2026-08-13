// ULIDs, so `ORDER BY id` is creation order.
//
// A UUID would have been one line shorter and would have made every ordered
// read need a second column. Cloudflare promises best-effort ordering and
// nothing more, and this is how we get that much for free, including in
// `hobby queue peek`, whose output would otherwise be arbitrary.

import { randomInt } from 'node:crypto'

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
const TIME_CHARS = 10
const RANDOM_CHARS = 16

// Monotonic within a millisecond: the same millisecond increments the previous
// random suffix rather than drawing a fresh one, so two messages enqueued in
// one tick still sort in send order. Drawing fresh randomness would sort them
// arbitrarily, and a batch of ten sends arriving out of order is exactly the
// surprise ordering is supposed to prevent.
let lastMs = -1
let lastRandom: number[] = []

function encodeTime(ms: number): string {
  let out = ''
  let value = ms
  for (let i = TIME_CHARS - 1; i >= 0; i -= 1) {
    out = ALPHABET[value % 32] + out
    value = Math.floor(value / 32)
  }
  return out
}

function drawRandom(): number[] {
  return Array.from({ length: RANDOM_CHARS }, () => randomInt(0, 32))
}

function increment(random: number[]): number[] {
  const out = [...random]
  for (let i = out.length - 1; i >= 0; i -= 1) {
    const digit = out[i] ?? 0
    if (digit < 31) {
      out[i] = digit + 1
      return out
    }
    out[i] = 0
  }
  // Overflowed all 16 characters, which needs 32^16 ids inside one
  // millisecond. Starting over is the only option and is unreachable in
  // practice; it is here so the function has no undefined path.
  return drawRandom()
}

export function newMessageId(nowMs: number): string {
  if (nowMs === lastMs) {
    lastRandom = increment(lastRandom)
  } else {
    lastMs = nowMs
    lastRandom = drawRandom()
  }
  const suffix = lastRandom.map((digit) => ALPHABET[digit] ?? '0').join('')
  return encodeTime(nowMs) + suffix
}
