# 0010. Phase 2 begins without the 30-day gate

Status: ACCEPTED
Date:   2026-08-10

Supersedes guard 2 of ADR 0007. The other three guards in that ADR survive
unchanged and are, if anything, more load-bearing now.

## Context

ADR 0007 widened the scope from a Postgres tool to a platform, and it did not do
so unguarded. It replaced the old out-of-scope list with four guards, and named
one of them as the important one:

> A hard phase gate. *Phase 2 does not begin until Phase 1 has been in the
> author's daily use for 30 consecutive days.* Not "is finished." Is in use.
> This is the specific mechanism against abandonment at 40 percent, and it is
> the clause most likely to be resented later, which is why it is written down
> now.

It was right about being resented. Phase 1 merged to `main` on 2026-08-08. This
ADR is dated 2026-08-10. Two days, not thirty.

The author was asked directly whether to wait, to build without recording
anything, or to build and record it. The answer was to build.

## Decision

**Phase 2 begins now.** The 30-day daily-use gate is removed rather than waived,
because a gate that is waived the first time it binds is not a gate, and leaving
it in the tree while the code contradicts it would make the repository lie about
itself.

## Reasoning

This section is deliberately thin, because the honest reasoning is thin.

The gate existed to test one hypothesis: that a wider scope was worth taking only
if the narrow scope proved itself in use first. That hypothesis has not been
tested. It has been set aside by the person it was written to protect, which is
the only person it could ever have bound.

What can be said in favour:

- **Phase 1 is verifiably real, not merely compiled.** Eject was run end to end
  against real Docker on 2026-08-08, including a `docker compose up` from the
  emitted file and a `psql` connection to the ejected database. Cancel routing was
  verified against a live Postgres on 2026-08-10. The thing the gate was
  protecting against, building Phase 2 on a Phase 1 that had never run, is not
  the situation.
- **The first two milestones of Phase 2 are useful even if the rest is
  abandoned.** M6 is fixing Phase 1's own model, which ADR 0007 guard 1 requires
  regardless of when Phase 2 happens. M7 is an HTTP wake router, which Phase 3
  needs whether or not `app` and `worker` ever ship. If Phase 2 is abandoned at 40
  percent, the 40 percent that exists is the part with independent value. That
  ordering is not an accident and is written into the spec.

What cannot be said in favour, and is therefore recorded as a cost:

- **The gate was correct and it is being removed because it was inconvenient.**
  Not because it was wrong, not because circumstances changed, not because new
  evidence arrived. Anyone reading this later should weigh it accordingly.

## Consequences accepted

- **The project's main risk is now unmitigated by its main mitigation.** ADR 0007
  named abandonment at 40 percent as the failure mode and named this gate as the
  specific mechanism against it. That mechanism is gone. The remaining guards
  (additive by construction, the wedge breaks ties, the shorter out-of-scope
  list) are real but none of them addresses pacing.
- **The success metric is unchanged and is now the only check left.** The author
  is still using it daily in six months. Stars, forks and issue count are still
  noise.
- **Two more resource kinds mean two more things eject has to keep working for.**
  ADR 0007 already accepted this; it simply arrives sooner.

## What would have to change to revisit

Nothing reinstates this gate. A gate that has been removed once cannot be
reimposed on the same person by the same document.

What can replace it is evidence: if Phase 2 stalls, the correct response is the
one ADR 0007 already prescribed for a failed gate, which is to stop and hold what
works rather than to push through. Retreating to a platform that does one thing
well and is actually used beats a wider one nobody finished. That sentence was
true when it was written and removing the gate does not make it less true.
