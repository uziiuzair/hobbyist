# ACTIVE CONTEXT

What is true right now. Overwrite freely, this file is not history.

## State: pre-code, scope reopened and settled

The repository contains documentation and no implementation. Nothing has been
built and no dependency has been added.

The scope was deliberately widened on 2026-08-07, one day after it was written.
Hobbyist is now a single-box platform rather than a Postgres-only tool. That is
recorded in `docs/decisions/0007`, which supersedes the original scope section
and is the first thing to read.

## What is settled

| Question | Answer | Where |
|---|---|---|
| Language and runtime | TypeScript on Bun, compiled to one binary | ADR 0006 |
| Scope | Platform, four phases, Projects holding typed resources | ADR 0007 |
| Studio access | Network exposed, TLS, one operator credential | ADR 0008 |
| HTTP front door | Caddy, as a managed container, via its admin API | ADR 0009 |
| One box | Still one box. ADRs 0001 through 0005 all survive | ADR 0007 |
| The wedge | Everything sleeps, everything wakes on demand | root `CLAUDE.md` |
| Cold start | Under 1s target, 3s hard ceiling | `docs/proxy/` |
| Routing | Database name is the project | `docs/proxy/` |
| Activity sensor | The proxy, not `pg_stat_activity` polling | `docs/hibernation/` |
| Control surface | One daemon HTTP API. CLI and MCP over a unix socket, Studio over loopback behind Caddy | `docs/cli/` |

## Build order

| Milestone | Ships | State |
|---|---|---|
| **M0** | Throwaway spike: container start, readiness, TCP splice, benchmarked on a five dollar VPS and a Mac Mini | **next** |
| **M1** | `core`, `pg`, `cli`, daemon, the ADR 0003 invariant tests | not started |
| **M2** | `proxy`. Wake on connect. **The keystone** | not started |
| **M3** | Hibernation | not started |
| **M4** | `studio`, and Caddy arrives with it | not started |
| **M5** | `mcp` | not started |

Each of M1 through M5 gets its own spec in the relevant capability's `specs/`
folder, then its own plan. There is deliberately no single Phase 1 spec.

## The immediate next step

**M0, and it is not building anything.** Prove the cold start budget before
committing to a design that assumes it. Container start, plus Postgres readiness,
plus a spliced socket, measured honestly on real hardware, on both Bun and Node.

If it cannot beat 3 seconds, the project changes shape, and finding that out in
week one is the entire point of putting it first.

## Open risks

- **Cold start is still unmeasured.** It is the number the project is judged on
  and M0 exists to close this.
- **Scope is now the dominant risk**, not a background one. The mitigation is the
  30-day daily-use gate before Phase 2 in ADR 0007, and it will feel unreasonable
  at exactly the moment it matters.
- **The ext4 problem.** Instant branching needs reflinks. ext4 is the default on
  many cheap VPS images and has no reflink support. Detect at `hobby init`, warn
  loudly, proceed.
- **Client connect timeouts.** Some ORMs and pool managers default to timeouts
  shorter than a container start. Still the most likely source of "it does not
  work" reports, and the M2 client matrix is the gate for it.
- **Studio is the largest security surface in the project** now that it is
  exposed. It gets reviewed as security code, not as UI.
- **A JavaScript wire proxy is unusual.** M0 measures it on both runtimes rather
  than assuming.

## Prior art not yet read

Still none of it. Xata's open-source core is the closest existing work on the
database half and Coolify and Dokploy are now genuinely adjacent on the compute
half. Read Xata before writing the proxy.

---

Last Updated: 2026-08-07
