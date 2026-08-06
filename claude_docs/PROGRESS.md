# PROGRESS

Append-only history. Newest entry at the top. Never rewrite an entry, and never
delete one, even when it turns out to have been wrong. Especially then.

Each entry: what changed, what it cost, and what was learned.

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
