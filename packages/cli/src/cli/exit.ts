// The one place ErrorCode maps to a process exit code. Deliberately a
// Record<ErrorCode, number>, not a switch with a default: TypeScript rejects
// this file at compile time if @hobby.sh/core ever adds an ErrorCode without
// a mapping here, which is exactly the "no default you did not think about"
// requirement from the task brief.
//
// The six codes scripts can trust, per the brief:
//   0 success, 1 operation failed, 2 usage, 3 not found, 4 conflict,
//   5 daemon unreachable.
// 0 is never produced from an ErrorCode (every ErrorCode is, by definition,
// a failure); 5 is never produced here either, since "daemon unreachable" is
// a client-side condition (the socket refused or does not exist), not
// something the daemon itself ever returns as an ErrorCode. See
// DaemonUnreachableError in client.ts and its handling in main.ts.

import type { ErrorCode } from '@hobby.sh/core'

export const EXIT_SUCCESS = 0
export const EXIT_OPERATION_FAILED = 1
export const EXIT_USAGE = 2
export const EXIT_NOT_FOUND = 3
export const EXIT_CONFLICT = 4
export const EXIT_DAEMON_UNREACHABLE = 5

const EXIT_CODE_BY_ERROR: Record<ErrorCode, number> = {
  // The two "no such thing" codes. Both are, by name, exactly what exit 3
  // means.
  project_not_found: EXIT_NOT_FOUND,
  resource_not_found: EXIT_NOT_FOUND,

  // The two "that name/state is already taken" codes.
  name_taken: EXIT_CONFLICT,
  conflict: EXIT_CONFLICT,

  // Bad input from the human at the keyboard: a malformed name, or a target
  // that does not resolve to exactly one resource without the caller
  // disambiguating it. Both are things a script or a human can fix by
  // typing something different, which is what exit 2 promises.
  invalid_name: EXIT_USAGE,
  ambiguous_target: EXIT_USAGE,
  usage: EXIT_USAGE,

  // Everything below is "the daemon tried and the operation did not
  // succeed," which is exit 1's whole job. None of these are "you typed it
  // wrong" (that's 2), "it doesn't exist" (3), "it's already there" (4), or
  // "I couldn't reach the daemon at all" (5, which never comes from an
  // ErrorCode in the first place, see the file comment above).
  runtime_unavailable: EXIT_OPERATION_FAILED,
  wake_failed: EXIT_OPERATION_FAILED,
  wake_timeout: EXIT_OPERATION_FAILED,
  not_ready: EXIT_OPERATION_FAILED,
  // No auth model exists yet in M1 (docs/cli/CLAUDE.md: the unix socket's
  // filesystem permissions are the whole authentication story), so
  // `unauthorized` has no dedicated exit code carved out for it either;
  // "operation failed" is the closest honest bucket until Studio's operator
  // credential (M4) gives this code a real meaning worth a code of its own.
  unauthorized: EXIT_OPERATION_FAILED,
  internal: EXIT_OPERATION_FAILED,
}

export function exitCodeForError(code: ErrorCode): number {
  return EXIT_CODE_BY_ERROR[code]
}
