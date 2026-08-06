# 0004. No metering, no billing, no usage accounting

Status: ACCEPTED
Date:   2026-08-06

## Context

Neon's pricing model, CU-hours, is elegant enough that it reads as a product
feature rather than a billing mechanism. Reproducing that experience was part of
the original vision.

Worth separating two things that get conflated: the **behavior** (compute runs
only when needed) and the **meter** (counting what ran, in order to charge for
it).

## Decision

**Build the behavior. Do not build the meter.**

Hibernation and wake-on-connect are in v1 because they make a single small box
usable. There is no usage accounting, no CU-hour equivalent, no quota
enforcement, no billing subsystem, and no plan for one.

## Reasoning

Nobody is paying, so there is nothing to charge for and nothing to count. A meter
with no invoice attached is a subsystem that costs build time, adds storage, adds
a query surface, and produces numbers no one acts on.

Metering also drags multi-tenancy in behind it, because per-tenant accounting is
the only reason to be precise about attribution, and multi-tenancy is what makes
this a much larger project (see ADR 0002).

## Consequences accepted

- No usage dashboards, no cost projections, no "what did this cost me" answers.
- **Basic observability is still in scope**, and is a different thing: is it
  awake, how much disk is it using, when did it last sleep. Operational
  visibility, not accounting.
- If a hosted offering ever appeared, metering would need building from scratch.
  That is correct, because it should be built against real billing requirements
  rather than guessed at years early.

## What would have to change to revisit

A hosted, paid offering, which is explicitly out of scope in the root `CLAUDE.md`.
