// How Studio tells a failed wake apart from a failed statement (issue #120).
//
// Both arrive as a rejected promise from the same call, POST
// /v1/resources/:id/query, and both come back as a non-2xx response, so the
// HTTP status alone cannot separate them (wake_failed is a 500 and a bad
// statement is a 400, but so is a malformed body, and a wake_timeout is a
// 504 that a proxy page could also produce). The daemon's error envelope
// carries a code for exactly this purpose: getOrCreateWake raises
// `wake_failed` or `wake_timeout` (packages/pg/src/postgres.ts,
// packages/cli/src/daemon/context.ts), and a statement Postgres rejected
// comes back from toQueryError (packages/pg/src/query.ts) as `usage`, with
// the SQLSTATE in the hint. Branch on that code, never on the status.

import { ApiError } from '../api.js'

const WAKE_FAILURE_CODES = new Set<ApiError['code']>(['wake_failed', 'wake_timeout'])

// True only when the daemon said the database did not come up. Every other
// rejection, including a statement the database refused, is the task's own
// failure and gets no wake narrative.
export function isWakeFailure(err: unknown): boolean {
  return err instanceof ApiError && WAKE_FAILURE_CODES.has(err.code)
}

// One line of text for a failure, with the hint appended when the daemon
// sent one. For a statement Postgres rejected, the hint is where the
// SQLSTATE travels (packages/pg/src/query.ts, toQueryError), so a syntax
// error renders as `syntax error at or near "selec" (SQLSTATE 42601)`
// rather than as the bare message. A non-ApiError (a thrown string, a
// network failure already wrapped as `unreachable`) falls back to the
// caller's own phrasing, which is what the views always did.
export function describeError(err: unknown, fallback: string): string {
  if (!(err instanceof ApiError)) return fallback
  if (err.hint === undefined || err.hint.length === 0) return err.message
  return `${err.message} (${err.hint})`
}
