# `docs/decisions/` architecture decision records

**Numbered, dated, immutable.** An ADR records what was decided, when, and why,
using the information available at the time. It is never rewritten to match what
happened later. If a decision is reversed, write a new ADR and mark the old one
`SUPERSEDED BY`.

## Why this folder matters more here than in most repos

The main risk to this project is not competition, and it is not revenue, because
there is no revenue. **It is scope.** A platform half-built and abandoned is the
specific failure mode being guarded against.

That risk went up, not down, on 2026-08-07. ADR 0007 deliberately widened the
scope from a Postgres tool to a platform, and said so plainly rather than
pretending the original argument had been wrong. The guard did not go away, it
changed form: a shorter out-of-scope list, resource kinds that must be additive,
a wedge that breaks ties, and a 30-day daily-use gate before Phase 2. This folder
is where all four are enforced.

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
| [0006](0006-typescript-everywhere.md) | TypeScript everywhere, Bun as the runtime |
| [0007](0007-hobbyist-is-a-platform.md) | Hobbyist is a platform, not a Postgres tool |
| [0008](0008-studio-is-network-exposed.md) | Studio is network exposed, with an operator credential |
| [0009](0009-caddy-as-http-front-door.md) | Caddy as the HTTP front door, run as a managed container |
| [0010](0010-phase-2-begins-without-the-30-day-gate.md) | Phase 2 begins without the 30-day gate |
| [0011](0011-workerd-via-miniflare-as-the-worker-runtime.md) | workerd, via Miniflare, as the `worker` runtime |
| [0012](0012-durable-objects-and-the-alarm-mirror.md) | Durable Objects as a resource kind, and the alarm mirror that lets them sleep |
| [0013](0013-queues-and-the-broker-outside-the-runtime.md) | Queues as a resource kind, with the broker held outside the runtime |

0007 supersedes the scope section of the original root `CLAUDE.md` and is the one
to read first if you are wondering why this is bigger than a database tool. 0001
through 0005 survive it unchanged.

0010 removes 0007's 30-day daily-use gate, which was the guard this folder's
own text above calls the one that matters. Read it before concluding the gate
still protects anything. 0007's other three guards are unaffected.
