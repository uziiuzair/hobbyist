// A single error type for the whole project. The CLI, the daemon and the MCP
// server all catch HobbyError and know how to render it: httpStatus for the
// HTTP-shaped surfaces, toWire() for anything that crosses a process boundary.

export type ErrorCode =
  | 'project_not_found'
  | 'resource_not_found'
  | 'name_taken'
  | 'invalid_name'
  | 'ambiguous_target'
  | 'runtime_unavailable'
  | 'wake_failed'
  | 'wake_timeout'
  | 'not_ready'
  | 'conflict'
  | 'usage'
  | 'unauthorized'
  // A resource row names a kind no handler was registered for, which means
  // the daemon was built without a package it has rows for. Not a user
  // error and not a 404: the resource exists, and nothing on this box knows
  // how to run it. See kinds.ts's KindRegistry.
  | 'unknown_kind'
  // The user's Dockerfile or wrangler manifest failed to build. Distinct
  // from wake_failed, which is about a built thing refusing to serve.
  | 'build_failed'
  // The caller is inside a login or bearer-token backoff window (issue
  // #117). Distinct from `unauthorized` so a client never tells a throttled
  // user that a correct password is wrong: 429, with the seconds to wait in
  // the message and a Retry-After header where the transport allows one.
  | 'too_many_attempts'
  // No route matches the method and path (issue #117). Distinct from
  // `usage` (400), which is a malformed request to a route that exists.
  | 'not_found'
  // A write hit ENOSPC or EDQUOT (issue #139). The filesystem under
  // HOBBY_HOME is full, which is not a daemon fault and not something a
  // retry fixes until space is freed. 507 Insufficient Storage.
  | 'disk_full'
  | 'internal'

const HTTP_STATUS_BY_CODE: Record<ErrorCode, number> = {
  project_not_found: 404,
  resource_not_found: 404,
  name_taken: 409,
  invalid_name: 400,
  ambiguous_target: 500,
  runtime_unavailable: 503,
  wake_failed: 500,
  wake_timeout: 504,
  not_ready: 500,
  conflict: 409,
  usage: 400,
  unauthorized: 401,
  unknown_kind: 500,
  build_failed: 422,
  too_many_attempts: 429,
  not_found: 404,
  disk_full: 507,
  internal: 500,
}

// Errno codes that mean "the filesystem has no room", on the two shapes
// Node reports them in: a plain fs error (`err.code === 'ENOSPC'`) and a
// child process whose stderr carried the message (cp on darwin, tar). One
// predicate for every writer that wants to turn a full disk into a
// disk_full HobbyError rather than an internal error.
export function isDiskFullError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) {
    return false
  }
  const code = (err as { code?: unknown }).code
  if (code === 'ENOSPC' || code === 'EDQUOT') {
    return true
  }
  const text = [
    (err as { message?: unknown }).message,
    (err as { stderr?: unknown }).stderr,
    (err as { hint?: unknown }).hint,
  ]
    .filter((part): part is string => typeof part === 'string')
    .join('\n')
  return /no space left on device|disk quota exceeded/i.test(text)
}

export class HobbyError extends Error {
  readonly httpStatus: number

  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly hint?: string
  ) {
    super(message)
    this.name = 'HobbyError'
    this.httpStatus = HTTP_STATUS_BY_CODE[code]
  }

  toWire(): { error: { code: ErrorCode; message: string; hint?: string } } {
    return {
      error:
        this.hint === undefined
          ? { code: this.code, message: this.message }
          : { code: this.code, message: this.message, hint: this.hint },
    }
  }
}
