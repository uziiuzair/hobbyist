# Hobbyist

Read this first, every session. It is the standing context for the whole repo.

## What this is

**Postgres that feels like Neon, on hardware you own.**

Managed Postgres platforms sell convenience: instant provisioning, branching,
scale-to-zero, a connection string that just works, backups you never think
about. Every primitive underneath that convenience is already free and mature.
The convenience itself is what people pay for, and it is the only thing missing
from the self-hosted world.

Hobbyist is that convenience layer. One command gives you a Postgres. Another
gives you a branch. The database sleeps when nothing is connected and wakes when
something connects. It runs on one box, with no Kubernetes, and you can walk away
from it at any time with a single command.

**One-liner:** Your Postgres. Your box. Their convenience.

## What this is not

This is **not a business.** Nobody is expected to pay. There is no cloud offering,
no hosted tier, no metering, no billing, and no roadmap toward one. The product
exists so that people who want this option have it.

That fact is load-bearing, not a disclaimer. It removes multi-tenancy, isolation
hardening, usage accounting, and quota enforcement from scope, and those removals
are what make the project buildable by one person.

**Success metric:** the author is still using it daily in six months. That is the
only one. Stars, forks and issue count are noise.

## Assets

| Asset | Value | Status |
|---|---|---|
| Domain | `hobbyist.sh` | Owned |
| NPM namespace | `@hobby.sh/*` | Owned. Registry showed the scope unclaimed as of 2026-08-06 |
| Repository | `github.com/uziiuzair/hobbyist` | Live, `main` |
| CLI binary | `hobby` | The single user-facing entry point |
| Parent | Ooozzy Ltd (product studio) | This is studio infrastructure, not a studio product |

Package layout under the namespace, as capabilities land:

```
@hobby.sh/cli      the hobby binary
@hobby.sh/core     shared types, config, the compute runtime interface
@hobby.sh/pg       Postgres instance lifecycle
@hobby.sh/proxy    wake-on-connect wire proxy
@hobby.sh/mcp      MCP server over the CLI verbs
```

Small, composable, independently versioned. A package that cannot be used without
three siblings is a module, not a package.

## Direction

The stance the whole project serves: **developer ownership over platform
dependence.** Infrastructure should be something you can leave.

Concretely, that means three promises, in priority order when they conflict:

1. **You can always leave.** The data directory is a plain Postgres data
   directory. `pg_dump` always works. `hobby eject` hands you a
   `docker-compose.yml` and the data, and gets out of the way.
2. **It runs on one box.** A five dollar VPS, a Mac Mini, an old ThinkPad under a
   desk. If a feature requires a cluster, it is out of scope.
3. **It feels good.** The reason people pay for managed Postgres is ergonomics.
   Matching the primitives is not enough; matching the feel is the entire job.

## Scope: v1 is Postgres and nothing else

**In scope.** Instance lifecycle, wake-on-connect proxying, idle hibernation,
copy-on-write branching, backup and restore, an MCP server, and eject.

**Explicitly out of scope,** and not to be added without an ADR that argues the
case: object storage, workers, edge functions, cron, auth, secrets management,
DNS, AI compute, a hosted cloud, a web dashboard, multi-tenancy, Kubernetes,
Terraform providers, and Helm charts.

That out-of-scope list is the most important paragraph in this file. The failure
mode for this project is not competition and not lack of revenue, since there is
no revenue. It is a half-finished ten-service platform that gets abandoned at 40
percent. Every one of those items is individually reasonable and collectively
fatal. They earn their way in by being demanded by real daily use, never by
appearing on a whiteboard.

## Architecture in one page

```
  client (psql, app, ORM)
        |
        v
  hobby proxy            speaks the Postgres wire protocol.
        |                reads the startup packet, resolves the target project,
        |                and if that project is asleep, starts it, waits for
        |                readiness, then forwards the connection through.
        v
  postgres container     unmodified Postgres 18+. one per project.
        |                started and stopped by the daemon. no fork, no patches,
        |                no extensions required for core function.
        v
  data directory         a plain PGDATA on a reflink-capable filesystem.
                         branching is a filesystem-level copy-on-write clone.
```

The daemon owns lifecycle and idle detection. The proxy owns the illusion. The
data directory owns the escape hatch.

### The three decisions that define the shape

**No Neon-style storage and compute separation.** Neon replaced Postgres's storage
substrate with a Rust pageserver that reconstructs any page at any point in WAL
history, fed by a Paxos-consensus safekeeper tier. It is genuinely excellent and
it is the part that cost a large team of Postgres specialists years. We are not
building it. We take the three user-visible behaviors it delivers (branching,
sleep, durable data across restarts) and get them a cheaper way. See
`docs/decisions/0001`.

**Containers, not microVMs, for now.** Firecracker isolates untrusted multi-tenant
workloads. On your own box every tenant is you, so the isolation buys nothing and
costs a kernel boot, a device model, network plumbing and an image pipeline.
Containers start faster and are far simpler. The compute runtime sits behind an
interface so a microVM implementation can land later if multi-tenancy ever
becomes real. See `docs/decisions/0002`.

**Branching is a filesystem clone, not a storage engine.** PostgreSQL 18's
`file_copy_method = clone` plus `CREATE DATABASE ... STRATEGY = FILE_COPY` produces
a copy-on-write clone on reflink-capable filesystems. Published benchmark: a 6GB
database cloned in 212ms versus roughly 67 seconds with the default WAL_LOG
strategy. Neon-style branching as a config flag and one SQL statement. See
`docs/branching/`.

## The keystone

**The wake-on-connect proxy is the single component that decides whether this
project works.** Everything else is orchestration around mature tools. The proxy
is the piece that turns "your database is stopped" into "your first query was a
bit slow," and it is the piece every existing project holds back.

Build it second, immediately after basic instance lifecycle. Not last. If the
proxy cannot be made to feel good, the project has no reason to exist and it is
better to learn that in week two than month six.

## Prior art

Read these before building anything. Two of them have already solved parts of
this and one has solved almost all of it.

| Project | What to take from it |
|---|---|
| **Neon** | The architecture writeups are the best available explanation of serverless Postgres. Read them to understand precisely what we are choosing not to build. |
| **Xata** | The closest prior art by a wide margin. Apache 2.0, open source: SQL gateway, branch operator, cluster and project services, auth, and scale-to-zero plugins, built on CloudNativePG and OpenEBS with NVMe-over-Fabrics for copy-on-write. **Read their code before writing ours.** |
| **PostgresAI DBLab Engine** | Thin clones via ZFS and LVM, in production for years. The fallback branching path if the reflink route disappoints. |
| **pgcat / PgDog / Supavisor** | Reference implementations of the Postgres wire protocol in a proxy. None of them do wake-on-connect. |
| **pgBackRest / Barman** | Backups are solved. We are wrapping, not reimplementing. |
| **Coolify / Dokploy / CapRover** | Adjacent, not competitors. They deploy apps. We do one database well. |

### Why Xata does not make this redundant

Two gaps, and the second is the whole opening.

1. Xata explicitly recommends **against** self-hosting their open source version
   for a single instance, because it runs on Kubernetes and is overkill. Their
   words. The single instance is our entire audience.
2. Their scale-to-zero plugin **cannot wake the database.** From their own
   writeup: the plugin "can't handle reactivation because the cluster is no longer
   running once it's hibernated," and automatic reactivation on connection is what
   they kept in the paid cloud.

Single box, no Kubernetes, wake-on-connect. That is the wedge. It is narrow and it
is real.

## Hard constraints

- **PostgreSQL 18 or newer** for the clone-based branching path.
- **A reflink-capable filesystem** for instant branching: XFS with reflinks
  enabled, ZFS, or APFS. **ext4 does not support reflinks**, and ext4 is the
  default image on a lot of the cheap VPS providers our audience uses. Branching
  degrades to a real copy there. Document this loudly on day one, detect it at
  `hobby init`, and warn rather than fail.
- **`CREATE DATABASE ... STRATEGY = FILE_COPY` requires no active connections on
  the source database.** Branching needs a quiesce, clone, restore sequence or a
  clone taken from a paused replica. This is real engineering, not a footnote.
- **Postgres stays unmodified.** No fork, no patched binaries. If a feature needs
  a patched Postgres, the feature is wrong.

## Working agreements

- **No em-dashes anywhere**, in docs, code comments, commit messages or output.
  Use commas, colons, parentheses, or restructure.
- **Ground claims in code.** Cite `path/to/file.ts` with a symbol name instead of
  describing what you believe the code does.
- **Mark what is not real yet.** A reader must never execute an aspiration.
- **Every deliberate non-build gets an ADR.** The record of what we chose not to
  build is more valuable here than the record of what we did, because scope is the
  main risk.
- **Prefer deleting a feature to deferring it.** A deferred feature still occupies
  attention. A deleted one does not.

## Where things live

| Location | What |
|---|---|
| `CLAUDE.md` | This file. Standing project context. |
| `docs/` | The filed half. Per-capability folders, decisions, cross-cutting reference. Read `docs/CLAUDE.md` before adding anything. |
| `claude_docs/` | The workshop. Current state, running history, the repo-wide map. |
| `README.md` | Public-facing. Currently empty. |

---

Last Updated: 2026-08-06
