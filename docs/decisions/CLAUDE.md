# `docs/decisions/` architecture decision records

**Numbered, dated, immutable.** An ADR records what was decided, when, and why,
using the information available at the time. It is never rewritten to match what
happened later. If a decision is reversed, write a new ADR and mark the old one
`SUPERSEDED BY`.

## Why this folder matters more here than in most repos

The main risk to this project is not competition, and it is not revenue, because
there is no revenue. **It is scope.** A ten-service platform half-built and
abandoned is the specific failure mode being guarded against.

So this folder is disproportionately a record of things deliberately **not**
built. That record is what stops a reasonable-sounding suggestion, six months
from now, from quietly reopening a question that was already settled for good
reasons.

## Format

`NNNN-slug.md`, with a header stating status and date:

```
Status: ACCEPTED | SUPERSEDED BY NNNN | PROPOSED
Date:   YYYY-MM-DD
```

Then: context, the decision, consequences accepted, and what would have to change
for this to be revisited. That last section is the one people skip and the one
that matters, because it is the difference between a decision and a dogma.

## When a new ADR is required

- Adding anything on the out-of-scope list in the root `CLAUDE.md`
- Adding a new capability folder under `docs/`
- Choosing a foundational dependency: runtime, container engine, filesystem
  requirement, wire-protocol library
- Reversing any existing ADR

## Index

| ADR | Decision |
|---|---|
| [0001](0001-no-storage-compute-separation.md) | No Neon-style storage and compute separation |
| [0002](0002-containers-not-microvms.md) | Containers, not microVMs |
| [0003](0003-plain-postgres-data-directory.md) | The data directory is always plain Postgres |
| [0004](0004-no-metering.md) | No metering, no billing, no usage accounting |
| [0005](0005-branching-via-pg18-clone.md) | Branching via PostgreSQL 18 file clone |
