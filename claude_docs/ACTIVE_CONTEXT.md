# ACTIVE CONTEXT

What is true right now. Overwrite freely, this file is not history.

## State: Phase 1 on `main`, Phase 2 compute on `phase-2-compute`

Phase 1 is merged and has been exercised against real Docker: eject end to end
on 2026-08-08, cancel routing against a live Postgres on 2026-08-10.

**Phase 2 compute is built on branch `phase-2-compute`, not merged.** Two new
resource kinds, `app` and `worker`, the model fix they needed, and the HTTP
wake router. 380 tests pass. The design is at
`docs/compute/specs/2026-08-10-phase-2-compute-design.md` and is the thing to
read before touching any of it.

**The phase gate is gone.** ADR 0007 required 30 consecutive days of Phase 1
daily use before Phase 2 began. `docs/decisions/0010` removes it, two days
after Phase 1 merged, and says plainly that the gate was correct and was
removed anyway. Nothing now paces this project except the author.

## What is settled

| Question | Answer | Where |
|---|---|---|
| Language and runtime | TypeScript on Bun, compiled to one binary | ADR 0006 |
| Scope | Platform, four phases, Projects holding typed resources | ADR 0007 |
| Studio access | Network exposed, TLS, one operator credential | ADR 0008 |
| HTTP front door | Caddy, as a managed container, via its admin API | ADR 0009 |
| Phase 2 pacing | No gate. Removed deliberately | ADR 0010 |
| `worker` runtime | workerd, via the miniflare npm package, pinned to 4.20260730.0 | ADR 0011 |
| How a kind is added | Implement `ResourceKindHandler`, add one line to `createDefaultKindRegistry` | `packages/core/src/kinds.ts` |
| The wedge | Everything sleeps, everything wakes on demand | root `CLAUDE.md` |
| Cold start, Postgres | 170 to 186ms p50/p95, measured 2026-08-07 | `docs/proxy/research/` |
| Cold start, HTTP | app p95 133ms, worker p95 321ms, measured 2026-08-10 on a Mac | `docs/compute/research/` |

## Build order

| Milestone | Ships | State |
|---|---|---|
| M0 to M5 | Phase 1 | merged to `main` |
| **M6** | Resource kind registry, model widened | **built** |
| **M7** | HTTP wake router, static Caddy catch-all | **built** |
| **M8** | `app` kind: build, deploy, wake, logs, eject | **built** |
| **M9** | `worker` kind: wrangler.toml, Miniflare, hyperdrive | **built, verified against real Docker** |
| **M10** | HTTP cold start measured | **half done**: Mac yes, five dollar VPS no |

## The immediate next steps

1. **Run the cold start matrix on a five dollar VPS.** The Mac numbers pass
   comfortably and are the easy end. Until the VPS is measured, the budget is
   an assertion with one favourable data point.
2. **Wire Caddy.** `createCaddyManager` still has no caller, which is a Phase 1
   loose end (see `HANDOFF-2026-08-07.md`), and Phase 2 makes it load-bearing.
   `network: 'host'` does not exist on Docker Desktop for macOS, so this fails
   on the author's own machine first.
3. **Merge `phase-2-compute` to `main`,** or decide not to.

## Open risks

- **Scope, and nothing now checks it.** ADR 0007 named abandonment at 40
  percent as the failure mode and named the phase gate as the mechanism against
  it. The gate is gone. The remaining guards are real but none of them paces
  anything.
- **Miniflare is a documented dev tool running as a server.** ADR 0011, with a
  named fallback: drop it from the runtime path and generate workerd capnp
  directly, at the cost of the storage APIs.
- ~~**A Durable Object alarm cannot fire inside a stopped container.**~~ Closed
  2026-08-11, and verified against real Docker rather than asserted: an alarm
  armed 60s out fired 61s after the container was stopped, with no request in
  between. `@hobby.sh/do` holds the schedule outside the runtime, the `worker`
  handler's `guard` refuses to sleep with an alarm imminent, and the daemon's
  mirror wakes one whose deadline arrives. Remaining caveat: an alarm can be up
  to one mirror tick (10s) late, plus a cold start.
- **Caddy on macOS.** Above.
- **The ext4 problem.** Unchanged: instant branching needs reflinks, ext4 has
  none, detect at `hobby init` and warn.
- **Studio has not been read by a person.** Unchanged from Phase 1 and still
  the largest security surface in the project.

## The lesson from this session worth keeping

Three real bugs came from running the thing, none from testing it, and one of
them was a bug the codebase had already documented at length for a different
kind. `reconcile.ts` explains exactly why a TCP-level check cannot answer "is
it serving"; both new kinds shipped with that check anyway until real Docker
proved it wrong. A lesson recorded in one kind's comments does not transfer to
the next kind by itself.

---

Last Updated: 2026-08-10
