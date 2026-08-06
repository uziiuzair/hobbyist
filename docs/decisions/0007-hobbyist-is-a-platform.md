# 0007. Hobbyist is a platform, not a Postgres tool

Status: ACCEPTED
Date:   2026-08-07

Supersedes the scope section and out-of-scope list of the 2026-08-06 root
`CLAUDE.md`. ADRs 0001 through 0005 survive unchanged.

## Context

The repository was scaffolded one day earlier around a single sentence: v1 is
Postgres and nothing else. Its out-of-scope list forbade object storage, workers,
edge functions, a web dashboard, and most of what a platform is. That list was
called the most important paragraph in the file, and the failure mode it guarded
against was named explicitly: a half-finished ten-service platform abandoned at
40 percent.

The intended product is now larger. A Studio, compute, and object storage are all
wanted, and the target experience is Neon and Supabase rather than a CLI that
manages a database. Rather than let the repository say one thing while the work
does another, the scope is being reopened deliberately, which is what
`docs/decisions/CLAUDE.md` requires.

The honest summary of the risk: the original document argued against exactly this,
and the argument was not wrong. What follows is not a rebuttal. It is an attempt
to take the wider scope while keeping the guard that made the narrow scope safe.

## Decision

**Hobbyist is a single-box platform organised around Projects.**

A **Project** is a namespace holding **typed resources**. A resource has a kind, a
lifecycle, and a sleep state. Phase 1 registers exactly one kind, `postgres`.
Later kinds are registered by implementing an interface.

| Phase | Ships | Registers |
|---|---|---|
| 1 | Studio, Postgres, CLI, MCP | `postgres` |
| 1.5 | Copy-on-write branching | none |
| 2 | Compute: stateless workers and apps | `app`, `worker` |
| 3 | S3-compatible storage, volumes, React SDK | `bucket`, `volume` |

**The wedge is that everything sleeps and everything wakes on demand.** This is
what makes the wider scope coherent rather than a feature list: Postgres waking
on connection and an app waking on request are the same mechanism behind one
router. A capability that cannot sleep does not obviously belong here.

## Four guards, which are the actual content of this decision

Widening scope without replacing the guard would be how this fails.

1. **Additive by construction.** Registering a resource kind must not modify an
   earlier phase. If Phase 2 requires changing Phase 1's model, the model was
   wrong and gets fixed before Phase 2 proceeds, not during it.
2. **A hard phase gate.** *Phase 2 does not begin until Phase 1 has been in the
   author's daily use for 30 consecutive days.* Not "is finished." Is in use.
   This is the specific mechanism against abandonment at 40 percent, and it is
   the clause most likely to be resented later, which is why it is written down
   now.
3. **The wedge breaks ties.** When a feature conflicts with sleep and wake, the
   wedge wins and the feature loses.
4. **The out-of-scope list survives, shorter and still binding.** Kubernetes,
   multi-node, multi-tenancy across owners, hosted cloud, billing and metering,
   end-user auth as a service, realtime, global edge, DNS management, secrets
   management, AI compute. Each still needs an ADR to reopen.

## Consequences accepted

- **The surface is several times larger and one person is building it.** The
  named failure mode is now materially more likely, and the phase gate is the
  only thing standing against it.
- **Phase 2 compute is stateless.** Persistence comes from Postgres. Volumes wait
  for Phase 3, which keeps volume lifecycle out of the hardest phase.
- **We now have competitors we did not have.** Coolify and Dokploy deploy apps
  well. Our claim against them is sleep, and only sleep.
- **`hobby eject` gets harder with every resource kind.** ADR 0003's promise now
  has to hold for compute and storage too, not just a data directory. Any kind
  that cannot be ejected does not ship.
- **ADRs 0001 through 0005 are untouched.** One box, containers not microVMs, a
  plain data directory, no metering, and clone-based branching all still hold.
  The expansion changes what we build, not how.

## What would have to change to revisit

If Phase 1 is not in daily use 30 days after it is finished, that is evidence the
wider scope was the wrong call, and the correct response is to stop at Phase 1
rather than to push through. Retreating to a Postgres-only tool that someone
actually uses beats a platform nobody finished.
