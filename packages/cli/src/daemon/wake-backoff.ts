// The pure half of the wake refusal (issue #10): how long a resource whose
// wake failed is left alone before the daemon tries it again by itself, how
// that delay is said to a person, and what of the failure is safe to repeat
// back. The stateful half, the per-context map and the wake that reads it,
// is buildWake in packages/cli/src/daemon/context.ts. Split out so that
// `hobby ls` (renderResourceLine, packages/cli/src/cli/output.ts) formats a
// delay with the same function the daemon's own refusal message uses, and
// so the schedule is testable as arithmetic, with no context and no clock.

// The first refusal lasts 30 seconds and each consecutive failure doubles
// it, up to 15 minutes. The shape is a compromise between the two ways this
// goes wrong. Too short, and a resource whose boot reliably fails is back in
// the crash loop issue #10 was about, only slower: one container start per
// window, for as long as anything keeps connecting. Too long, and a failure
// that was transient (a disk briefly full, the Docker daemon restarting, a
// slow first boot after a host reboot) leaves a database down long after the
// cause went away, which is what the permanent refusal did and why this
// replaced it. 30 seconds is short enough that the first retry after a
// transient failure lands while someone is still looking; the doubling
// means a resource that is genuinely broken costs a handful of starts in
// its first quarter of an hour and then four an hour, which is a cost a
// small box can carry indefinitely.
export const WAKE_RETRY_BASE_MS = 30_000
export const WAKE_RETRY_CAP_MS = 15 * 60_000

// How long automatic wakes are refused after the Nth consecutive failure:
// 30s, 1m, 2m, 4m, 8m, then 15m for every failure after that. `failures`
// below 1 is treated as 1, since there is no refusal without a failure.
// The exponent is clamped before it is used so that a resource that has
// failed a few thousand times (a month of a box nobody looked at) never
// computes 2 ** 5000, which is Infinity, and is harmless only by accident.
export function wakeRetryDelayMs(failures: number): number {
  const exponent = Math.min(Math.max(failures, 1) - 1, 20)
  return Math.min(WAKE_RETRY_BASE_MS * 2 ** exponent, WAKE_RETRY_CAP_MS)
}

// "4m 0s", "45s", "0s". Rounded up to the next whole second, so a retry
// 200ms away reads as 1s rather than 0s: "retry in 0s" read by someone who
// then connects and is still refused would be a small lie. Minutes are the
// largest unit on purpose, because the cap is 15 of them.
export function formatRetryDelay(ms: number): string {
  const totalSeconds = Math.max(0, Math.ceil(ms / 1000))
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return minutes === 0 ? `${seconds}s` : `${minutes}m ${seconds}s`
}

// lastError travels further than the error it came from: it is kept for up
// to a quarter of an hour and handed to every `hobby ls --json`, Studio
// listing and MCP call in that window, and wire output is exactly what ends
// up in shell history, CI logs and agent transcripts (see the file comment
// in packages/cli/src/daemon/wire.ts). The start errors it is taken from are
// not known to carry secrets today: startPostgres's own messages name only
// the resource id and the server's reply, a Postgres ErrorResponse never
// echoes the password it rejected, and the Docker runtime's errors are
// `docker <verb> failed` with stderr kept in the hint, which this never
// reads. But a kind handler is free to throw anything, and an app's start
// path passes user env to `docker create`. So the one secret-shaped thing an
// error message plausibly carries, a URL with credentials in it (every
// DATABASE_URL looks like one), has its userinfo replaced, and anything
// spelled like `password=...` loses its value. The length cap is for the
// listing: this is a reminder of what went wrong, and `hobby logs` is the
// full story.
const MAX_LAST_ERROR_LENGTH = 300

export function redactWakeError(message: string): string {
  const redacted = message
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]*@/gi, '$1<redacted>@')
    .replace(/\b(password|passwd|pwd)=[^\s&;]*/gi, '$1=<redacted>')
    .replace(/\s+/g, ' ')
    .trim()
  return redacted.length > MAX_LAST_ERROR_LENGTH ? `${redacted.slice(0, MAX_LAST_ERROR_LENGTH - 3)}...` : redacted
}
