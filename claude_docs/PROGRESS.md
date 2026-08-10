# PROGRESS

Append-only history. Newest entry at the top. Never rewrite an entry, and never
delete one, even when it turns out to have been wrong. Especially then.

Each entry: what changed, what it cost, and what was learned.

## 2026-08-10: Phase 2 compute, built in one session

Two resource kinds, `app` and `worker`, plus the model fix and the HTTP wake
router they needed. Branch `phase-2-compute`. 380 tests pass, up from 302.

**The gate went first, and it went honestly.** ADR 0007's 30-day daily-use
requirement was the guard that made the wider scope defensible, and ADR 0010
removes it two days after Phase 1 merged. The ADR says plainly that the gate
was correct and was removed because it was inconvenient, because a record that
argues its own case is worth less than one that states what happened. The
project's main risk is now unmitigated by its main mitigation.

**The `worker` kind is not what `docs/compute/CLAUDE.md` described.** That file
said "containers, and only containers"; a worker is now specifically a
Cloudflare Worker on Cloudflare's own open-source runtime, driven by the
`miniflare` npm package, with `wrangler.toml` as its manifest (ADR 0011).
Miniflare's own README says it is not intended for production use, and the ADR
overrides that explicitly with a named fallback rather than quietly.

**M6 was the whole architectural cost, and it was Phase 1's bill.**
`ResourceKind` was the single literal `'postgres'`, `Resource.config` was typed
`PostgresConfig`, `store.ts` parsed every config as one, and `config.ts`
appended `pgdata` to every resource of every kind. Making `Resource` a union
discriminated on the `kind` column it already had cost no migration, and the
compiler then found every place Phase 1 assumed Postgres. None of them was
found by hand.

**Three bugs came from running it, not from testing it.** Miniflare does not
work under Bun (it asserts on a control pipe fd Bun's child_process does not
provide). workerd ships no musl binary, so an Alpine runtime stage fails with
an ENOENT that reads like a missing file and is a missing platform. And the
readiness probe was lying: a TCP connect to a published container port succeeds
the instant the container is created, because Docker's port proxy binds the
host port whether or not anything inside is listening, so a worker whose
process had already exited was recorded `running`. That last one is the same
bug `reconcile.ts` documents at length for Postgres, reintroduced for two new
kinds. The lesson did not transfer automatically, which is the part worth
keeping.

**The numbers.** End to end through the real wake router, on an Apple M5 Pro:
`app` p95 133ms, `worker` p95 321ms, against a 1 second target and a 3 second
ceiling. Both pass comfortably and both are from the easy end of the matrix;
the five dollar VPS is not measured and the budget stays provisional until it
is. Filed with hardware stated at
`docs/compute/research/2026-08-10-http-cold-start-measurements.md`.

**Cost:** one session. The scope taken was larger than any previous one, and
the phase gate that existed to prevent exactly that is gone.

---

## 2026-08-07: scope reopened, Hobbyist becomes a platform

Still no code. Four new ADRs, four new capability folders, a rewritten root
`CLAUDE.md`, and two dated research notes.

The 2026-08-06 scope was Postgres and nothing else, guarded by an out-of-scope
list that forbade a dashboard, workers and object storage, and by a named failure
mode: a half-finished ten-service platform abandoned at 40 percent. One day later
the intended product is a Studio, compute and storage. Rather than let the repo
say one thing while the work did another, the scope was reopened deliberately, in
ADR 0007.

**What made the wider scope defensible rather than reckless** was picking a wedge
first: everything sleeps and everything wakes on demand. That is what turns a
feature list into one architecture, because a database waking on connection and
an app waking on an HTTP request are the same router. It also gives a tiebreaker:
a capability that cannot sleep does not obviously belong here.

**The guard that replaced the old out-of-scope list** is four clauses in ADR
0007, and the one that matters is the phase gate: Phase 2 does not begin until
Phase 1 has been in daily use for 30 consecutive days. Not "is finished." Is in
use. It was written down at the moment it was cheap to accept, because it will be
resented at the moment it binds.

**Decisions closed:** TypeScript on Bun (0006), which the previous entry called
the blocker on all code; Studio network exposed with one operator credential
(0008), chosen against the recommendation to keep it on localhost behind a
tunnel; Caddy as a managed container (0009). ADRs 0001 through 0005 survived
untouched, which is the useful signal that the expansion changed what gets built
and not how.

**The finding worth keeping:** hibernation may make branching much easier rather
than harder. ADR 0005's hardest constraint is that cloning needs no active
connections on the source, and sleeping instances are cleanly stopped by
definition. A stopped `PGDATA` can be reflink-copied and started directly, with
no SQL, no quiesce sequence, and no PostgreSQL 18 requirement. Filed as a
hypothesis to benchmark, not adopted.

**Cost:** documentation only, one session. The out-of-scope list is now shorter
and the risk is now materially higher, which is stated plainly in ADR 0007 rather
than argued away.

---

## 2026-08-06: repository scaffolded

Documentation structure created. No code.

- Root `CLAUDE.md` establishing project context: Postgres-only scope, the
  not-a-business framing, assets, hard constraints, and an explicit out-of-scope
  list
- `docs/` split into eight capability folders, each with `CLAUDE.md`, `research/`
  and `specs/`
- Five decision records covering the deliberate non-builds

**The decision behind the scope:** the original vision listed ten services
(Postgres, object storage, workers, edge functions, cron, auth, secrets, DNS, an
MCP gateway and AI compute). That was cut to one. The reasoning is in the root
`CLAUDE.md` and the failure mode being avoided is a half-finished platform
abandoned at 40 percent, which is a far likelier ending than any competitive
threat.

**The finding that set the direction:** the Neon bill being paid for a workload
with several cron-driven workers is not a case of an expensive product, it is a
case of the wrong product. Neon prices CU-hours and its value is scale-to-zero. A
database that is pinged every few hours never scales to zero, so the serverless
premium is being paid for an always-on workload. That is what Hobbyist exists to
fix, and it is a sharper problem statement than "managed Postgres is expensive."

---
