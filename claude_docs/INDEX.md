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
| `plans/` | Implementation plans, one per milestone, `YYYY-MM-DD-<name>.md`. Working state, deleted or left stale once the milestone lands. The durable record of what a milestone was for lives in its `docs/<capability>/specs/` file, not here. |

## docs/

| Folder | Capability | When |
|---|---|---|
| `cli/` | The `hobby` binary, config, the daemon and its control API | M1 |
| `engine/` | Postgres instance lifecycle | M1 |
| `portability/` | `hobby eject` and the right to leave | M1 |
| `proxy/` | The wake router (the keystone) | M2 |
| `hibernation/` | Idle detection and sleep | M3 |
| `studio/` | The web UI and its auth | M4 |
| `mcp/` | The MCP server | M5 |
| `branching/` | Copy-on-write branches | Phase 1.5 |
| `backups/` | Backup, restore, PITR | Phase 1.5 |
| `compute/` | Stateless workers and apps | Phase 2 |
| `storage/` | S3-compatible buckets, volumes | Phase 3 |
| `sdk/` | Client libraries, React first | Phase 3 |
| `decisions/` | Architecture decision records, numbered and immutable | n/a |

## The eleven decisions that define the project

Read these before proposing anything structural. **Start with 0007**, which is
what makes this a platform rather than a database tool, and which supersedes the
scope section of the original root `CLAUDE.md`. Then read 0010, which removes
0007's phase gate, because 0007 on its own now describes a guard that is no
longer in force.

| ADR | Decision |
|---|---|
| `docs/decisions/0001` | No Neon-style storage and compute separation |
| `docs/decisions/0002` | Containers, not microVMs |
| `docs/decisions/0003` | The data directory is always plain Postgres |
| `docs/decisions/0004` | No metering, no billing, no usage accounting |
| `docs/decisions/0005` | Branching via PostgreSQL 18 file clone |
| `docs/decisions/0006` | TypeScript everywhere, Bun as the runtime |
| `docs/decisions/0007` | Hobbyist is a platform, not a Postgres tool |
| `docs/decisions/0008` | Studio is network exposed, with an operator credential |
| `docs/decisions/0009` | Caddy as the HTTP front door, run as a managed container |
| `docs/decisions/0010` | Phase 2 begins without the 30-day gate |
| `docs/decisions/0011` | workerd, via Miniflare, as the `worker` runtime |

## The one number

**Cold start: under 1 second target, 3 seconds hard ceiling.** Everything sleeps,
so this is what the project is judged on. Postgres wake was measured on
2026-08-07 (`spike/m0/`, and `docs/proxy/research/2026-08-07-cold-start-measurements.md`).
HTTP wake, for Phase 2's `app` and `worker` kinds, holds the same budget and is
still unmeasured; M10 in the Phase 2 spec exists to close it.

---

Last Updated: 2026-08-10
