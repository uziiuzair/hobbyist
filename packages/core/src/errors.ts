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
  internal: 500,
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
