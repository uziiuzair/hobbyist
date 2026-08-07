// Postgres identifiers cannot be passed as query parameters (a $1 in a
// FROM clause is not valid SQL), so table and column names that Studio
// interpolates into generated SQL go through here first. Values always go
// through parameters instead; see Tables.tsx and schema.ts for both halves.

const SAFE_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/

export class UnsafeIdentifierError extends Error {
  constructor(name: string) {
    super(`refusing to build SQL against an unexpected identifier: ${JSON.stringify(name)}`)
    this.name = 'UnsafeIdentifierError'
  }
}

// Quotes an identifier that came back from information_schema (so it is
// already a real, existing name) defensively, and rejects outright
// anything containing a character that has no business in an unquoted
// Postgres identifier. This is a belt-and-braces check, not the primary
// defense: the primary defense is that every value in generated SQL is a
// bound parameter, never a concatenated string.
export function quoteIdentifier(name: string): string {
  if (!SAFE_IDENTIFIER.test(name)) {
    throw new UnsafeIdentifierError(name)
  }
  return `"${name}"`
}
