// The public surface of @hobby.sh/mcp.
//
// No SQL query tool is exported here, deliberately. Letting an agent run
// arbitrary SQL against a real database is a decision this package does not
// make; see the task report for the record of that omission and
// docs/mcp/CLAUDE.md's own open question about it.

export * from './tools.js'
export * from './server.js'
