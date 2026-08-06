# INDEX

The repo-wide map. If you are looking for something and do not know where it
lives, start here.

## The two halves

| Half | Location | Holds |
|---|---|---|
| The workshop | `claude_docs/` | Current state, running history, unfiled thinking |
| The shelf | `docs/` | Everything filed under a named capability |

The routing rule is in `docs/CLAUDE.md`. The project context is in the root
`CLAUDE.md`, which should be read at the start of every session.

## claude_docs/

| File | What |
|---|---|
| `INDEX.md` | This file. |
| `ACTIVE_CONTEXT.md` | What is happening right now. Current state, in-flight work, immediate next step. |
| `PROGRESS.md` | Append-only history. What shipped, when, and what it cost. |

## docs/

| Folder | Capability | Build order |
|---|---|---|
| `cli/` | The `hobby` binary, config, daemon | 1 |
| `engine/` | Postgres instance lifecycle | 1 |
| `proxy/` | Wake-on-connect wire proxy (the keystone) | 2 |
| `hibernation/` | Idle detection and sleep | 3 |
| `branching/` | Copy-on-write branches | 4 |
| `mcp/` | The MCP server | 5 |
| `backups/` | Backup, restore, PITR | 6 |
| `portability/` | `hobby eject` and the right to leave | 6 |
| `decisions/` | Architecture decision records, numbered and immutable | n/a |

## The five decisions that define the project

Read these before proposing anything structural.

| ADR | Decision |
|---|---|
| `docs/decisions/0001` | No Neon-style storage and compute separation |
| `docs/decisions/0002` | Containers, not microVMs |
| `docs/decisions/0003` | The data directory is always plain Postgres |
| `docs/decisions/0004` | No metering, no billing, no usage accounting |
| `docs/decisions/0005` | Branching via PostgreSQL 18 file clone |

---

Last Updated: 2026-08-06
