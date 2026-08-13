# ACTIVE CONTEXT

What is true right now. Overwrite freely, this file is not history.

## State: Phase 1 and Phase 2 compute both on `main`. Five sub-projects close the gap to Studio and MCP.

Phase 1 is merged and has been exercised against real Docker: eject end to end
on 2026-08-08, cancel routing against a live Postgres on 2026-08-10.

**Phase 2 compute merged to `main` at `fe16613` on 2026-08-11**, the morning
after it was built. This section said "on branch `phase-2-compute`, not
merged" until this update; that was true on 2026-08-10 and has been false
since. Two resource kinds, `app` and `worker`, the model fix they needed, and
the HTTP wake router. The design is at
`docs/compute/specs/2026-08-10-phase-2-compute-design.md`.

**What shipped after the merge: creation and deploy split into two acts.**
The daemon originally required a build source before it would commit a
resource row at all, which meant Studio and MCP could not create an `app` or
`worker`, having no filesystem path to hand the daemon. `docs/decisions/0014`
(branch `record-before-code`, not yet merged to `main`) splits `POST
/v1/projects/:name/resources` from `POST /v1/resources/:id/deploy`: a resource
can now exist as a row with an id and a hostname, holding no code, in a new
resting state `undeployed`. `hobby deploy` still resolves-or-creates and
deploys in one command, so nothing changes for the CLI. Giving Studio and MCP
the create half is the next sub-project, D1, not this one.

**Main also gained a private ingress lane.** `8fa4846` (2026-08-13) merged
Tailscale support: the daemon can report a tailnet connection string
alongside the public Caddy path. Research is filed at
`docs/compute/research/2026-08-13-tunnels-and-tailscale.md` and
`docs/proxy/research/2026-08-13-postgres-over-tailnet.md`. An ADR for it is
expected but not yet filed as of this writing.

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
| Resource creation vs. deploy | Two acts, not one. `undeployed` is a real resting state | ADR 0014 |

## Build order

| Milestone | Ships | State |
|---|---|---|
| M0 to M5 | Phase 1 | merged to `main` |
| **M6** | Resource kind registry, model widened | **merged to `main`** |
| **M7** | HTTP wake router, static Caddy catch-all | **merged to `main`** |
| **M8** | `app` kind: build, deploy, wake, logs, eject | **merged to `main`** |
| **M9** | `worker` kind: wrangler.toml, Miniflare, hyperdrive | **merged to `main`, verified against real Docker** |
| **M10** | HTTP cold start measured | **half done**: Mac yes, five dollar VPS no |

Phase 1 and Phase 2 compute are both on `main` as of `fe16613` (2026-08-11).
What is left is not a phase, it is closing the gap between what the daemon can
do and what Studio, MCP and a remote box can reach. Five sub-projects, in the
order they were scoped:

| Sub-project | Ships | State |
|---|---|---|
| **A** record before code | Resource creation split from deploy; `undeployed` state; ADR 0014 | **built, branch `record-before-code`, not yet merged to `main`** |
| **B** wire Caddy | `createCaddyManager` gets a production caller | not started |
| **D1** Studio and MCP for all kinds | Drop the hardcoded `kind: 'postgres'` at `packages/studio/src/api.ts:152` and `packages/mcp/src/tools.ts:116`, once A is merged and gives them something else to send | not started |
| **D2** Studio API tokens | Not yet designed beyond the label; no spec filed as of this writing | not started |
| **C** remote deploy | Laptop to VPS. Needs its own ADR: the CLI talks to a unix socket (`packages/cli/src/cli/client.ts`), so today it must run on the daemon's own box | not started |

## The immediate next steps

1. **Merge `record-before-code` (sub-project A) to `main`.** This is Task 10
   of that plan, the docs commit, landing now; the code (Tasks 1 through 9b)
   is already done and reviewed on the branch.
2. **Wire Caddy (sub-project B).** `createCaddyManager` still has no caller,
   which is a Phase 1 loose end (see `HANDOFF-2026-08-07.md`), and compute
   makes it load-bearing: an `undeployed` resource has an allocated hostname
   with nothing behind it, so Caddy's on-demand TLS ask has to answer for it
   before there is any code to serve. `network: 'host'` does not exist on
   Docker Desktop for macOS, so this fails on the author's own machine first.
3. **D1: give Studio and MCP the ability to create compute**, now that A
   makes it possible.
4. **D2: Studio API tokens.**
5. **C: remote deploy**, laptop to VPS.
6. **Run the cold start matrix on a five dollar VPS.** Still unmeasured, still
   the easy end of the matrix having been the only end run so far. Not part
   of the five-project sequence above, but not forgotten either.

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

Last Updated: 2026-08-13
