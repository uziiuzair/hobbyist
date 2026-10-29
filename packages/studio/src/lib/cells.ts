// How a table cell's value becomes text, by column type.
//
// The daemon's query route hands rows back as JSON, and two Postgres types
// arrive as objects rather than strings: bytea as Node's Buffer serialization
// ({ type: 'Buffer', data: [...] }) and json/jsonb as the parsed value. The
// table editor used String(value) for both display and the inline editor,
// which renders either as "[object Object]", and then wrote that text back
// on an unchanged edit, so opening a bytea cell and pressing Enter replaced
// the bytes with the literal string "[object Object]" (issue #119).

export interface BufferJson {
  type: 'Buffer'
  data: number[]
}

export function isBufferJson(value: unknown): value is BufferJson {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { type?: unknown }).type === 'Buffer' &&
    Array.isArray((value as { data?: unknown }).data)
  )
}

// Postgres's own hex input format, so the text is also what psql would show
// and what a `select encode(col, 'hex')` would confirm.
export function bufferToHex(value: BufferJson): string {
  return '\\x' + value.data.map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

export function isJsonType(dataType: string): boolean {
  return dataType === 'json' || dataType === 'jsonb'
}

// Binary is shown, never edited inline: there is no text a person types into
// a one-line box that is unambiguously the bytes they meant, and the one
// edit that used to happen here was the destructive accident above.
export function isBinaryType(dataType: string): boolean {
  return dataType === 'bytea'
}

// `dataType` is information_schema's name for the column, '' when unknown.
// null is left to the caller: the table renders it as a NULL badge and the
// editor seeds it as empty text, which are different things.
export function cellText(value: unknown, dataType: string): string {
  if (isBufferJson(value) || isBinaryType(dataType)) {
    return isBufferJson(value) ? bufferToHex(value) : String(value)
  }
  if (isJsonType(dataType)) {
    // A json column's text form round-trips: the string goes back as the
    // parameter of the update, and Postgres parses it as json.
    return typeof value === 'string' ? value : JSON.stringify(value)
  }
  if (Array.isArray(value)) {
    // Unchanged from before: a Postgres array arrives as a JS array, and
    // its comma-joined form is at least readable. Round-tripping it as an
    // edit is its own task.
    return String(value)
  }
  if (typeof value === 'object' && value !== null) {
    return JSON.stringify(value)
  }
  return String(value)
}
