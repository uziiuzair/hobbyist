# Hobbyist

Read this first, every session. It is the standing context for the whole repo.

## What this is

**A self-hosted platform that feels like Neon and Supabase, on hardware you own.**

Managed platforms sell convenience: instant provisioning, branching, scale to
zero, a connection string that just works, a dashboard that makes a database
legible, a deploy that happens on push. Every primitive underneath that
convenience is already free and mature. The convenience itself is what people
pay for, and it is the only thing missing from the self-hosted world.

Hobbyist is that convenience layer. One command gives you a project with a
Postgres in it. A studio you would actually choose to open. Everything sleeps
when nothing is using it and wakes when something connects. It runs on one box,
with no Kubernetes, and you can walk away from it at any time with a single
command.

**One-liner:** Your stack. Your box. Their convenience.

## The wedge

**Everything sleeps, and everything wakes on demand.**

This is the single reason for the project to exist, and every design decision
serves it. It is also the one thing no self-hostable alternative does:

- **Self-hosted Supabase never sleeps.** It is a large multi-container stack that
  runs at full cost whether or not anything is using it.
- **Xata's open-source scale-to-zero plugin cannot wake a database.** In their
  own words, it "can't handle reactivation because the cluster is no longer
  running once it's hibernated." Automatic reactivation on connection is what
  they kept in the paid cloud.
- **Coolify and Dokploy deploy apps well and do not sleep them.**

Sleep is what makes ten projects fit on one small box. Wake is what makes sleep
invisible. Neither is useful without the other, and the pair is the product.

When a feature conflicts with the wedge, the wedge wins.

## What this is not

This is **not a business.** Nobody is expected to pay. There is no cloud offering,
no hosted tier, no paid feature, no metering, no billing, and no roadmap toward
one. Nothing is held back behind a paid guard. The product exists so that people
who want this option have it, and we are happy knowing it helps people.

**We provide no warranty and take on no liability.** That is stated plainly in
the licence and it is not a throwaway. It is why we do not ship anything whose
failure mode is someone else getting owned or losing data quietly.

That not-a-business fact is load-bearing, not a disclaimer. It removes
multi-tenancy, isolation hardening, usage accounting, and quota enforcement from
scope, and those removals are what make the project buildable by one person.

**Success metric:** the author is still using it daily in six months. That is the
only one. Stars, forks and issue count are noise.

## Assets

| Asset | Value | Status |
|---|---|---|
| Domain | `hobbyist.sh` | Owned |
| NPM namespace | `@hobby.sh/*` | Owned. Registry showed the scope unclaimed as of 2026-08-06 |
| Repository | `github.com/uziiuzair/hobbyist` | Live, `main` |
| CLI binary | `hobby` | The primary user-facing entry point |
| Parent | Ooozzy Ltd (product studio) | This is studio infrastructure, not a studio product |

Six packages under the namespace:

```
@hobby.sh/core     Project and Resource model, state, config, ComputeRuntime interface
@hobby.sh/pg       the postgres resource kind: lifecycle, data directories, readiness
@hobby.sh/proxy    the wake router. Postgres wire protocol, HTTP from Phase 2
@hobby.sh/cli      the hobby binary and the daemon
@hobby.sh/studio   the web UI and its auth
@hobby.sh/mcp      MCP tools over the daemon API
```

Small, composable, independently versioned. A package that cannot be used without
three siblings is a module, not a package.

## Direction

The stance the whole project serves: **developer ownership over platform
dependence.** Infrastructure should be something you can leave.

Concretely, three promises, in priority order when they conflict:

1. **You can always leave.** The data directory is a plain Postgres data
   directory. `pg_dump` always works. `hobby eject` hands you a
   `docker-compose.yml` and the data, and gets out of the way.
2. **It runs on one box.** A five dollar VPS, a Mac Mini, an old ThinkPad under a
   desk. If a feature requires a cluster, it is out of scope.
3. **It feels good.** The reason people pay for managed platforms is ergonomics.
   Matching the primitives is not enough; matching the feel is the entire job.

## Scope

A **Project** is a namespace holding typed resources. Phase 1 registers one kind,
`postgres`. Later phases register more by implementing an interface, and earlier
phases do not change. That shape is the reason the phases below are additive
rather than successive rewrites. See ADR 0007.

| Phase | Ships |
|---|---|
| **1** | Studio, Postgres, CLI, MCP |
| **1.5** | Copy-on-write branching |
| **2** | Compute: workers and apps, stateless, arbitrary runtimes via containers |
| **3** | S3-compatible object storage, volumes for compute, React SDK |

Phase 2 compute is deliberately **stateless**. It gets its persistence from
Postgres. Volumes arrive in Phase 3, which keeps volume lifecycle out of the
hardest phase.

Backups, restore and `hobby eject` are not phased. Eject is a Phase 1 obligation
because it is the promise that makes everything else honest.

### Explicitly out of scope

Not to be added without an ADR that argues the case:

- **Kubernetes, clustering, multi-node anything.** One box.
- **Multi-tenancy across different owners.** Every tenant here is the same person.
- **A hosted cloud, a paid tier, billing, metering, usage accounting.**
- **End-user auth as a service.** Studio has an operator credential. We do not
  ship a GoTrue equivalent for other people's applications.
- **Realtime subscriptions, global edge execution, DNS management, secrets
  management, AI compute, Terraform providers, Helm charts.**

This list is shorter than it once was, because the project deliberately got
wider. It is not weaker. **The failure mode for this project is not competition
and not lack of revenue, since there is no revenue. It is a half-finished
platform abandoned at 40 percent.** Every item above is individually reasonable
and collectively fatal. They earn their way in by being demanded by real daily
use, never by appearing on a whiteboard.

## Architecture in one page

```
  psql / ORM / app                     browser
        |                                 |
        | :5432                           | :443
        v                                 v
  hobby proxy  <------ wake ------>  caddy (managed container)
        |            (the router)         |
        |                                 v
        |                            hobby daemon
        |                            unix socket for cli + mcp
        |                            loopback tcp for studio
        v                                 |
  postgres container                      |
        |          <---- start/stop ------+
        v
  data directory     a plain PGDATA on a reflink-capable filesystem
```

The **daemon** owns state and lifecycle. The **proxy** owns the illusion, and is
also the activity sensor that hibernation reads. **Caddy** owns TLS and HTTP
routing. The **data directory** owns the escape hatch.

Three seams that are not negotiable:

- **The proxy asks, the engine acts.** The proxy never starts a container. It
  calls `wake(resource)` and waits, which is what makes wake logic testable
  against a fake engine with no Docker in the loop.
- **`core` knows nothing about Docker.** The `ComputeRuntime` interface is the
  ADR 0002 escape hatch, and the seam Phase 2's `app` and `worker` kinds plug in
  through.
- **The daemon API is the only control surface.** CLI, Studio and MCP are three
  clients of one HTTP API and none of them touches Postgres or Docker directly.
  That turns "the CLI and MCP must never diverge" from a discipline problem into
  a structural one.

## The keystone

**The wake router is the single component that decides whether this project
works.** Everything else is orchestration around mature tools. It is the piece
that turns "your database is stopped" into "your first query was a bit slow," and
it is the piece every comparable project holds back.

**Cold start budget: under 1 second target, 3 seconds hard ceiling.** Three
seconds is roughly where common ORM and pool connect timeouts begin firing, so
anything above it is a release blocker rather than a slow path. Measure on a five
dollar VPS and a Mac Mini, file results with the hardware stated, and publish
them.

Build it second, immediately after basic instance lifecycle. Not last. If the
router cannot be made to feel good, the project has no reason to exist and it is
better to learn that in week two than month six.

## Prior art

Read these before building anything.

| Project | What to take from it |
|---|---|
| **Neon** | The architecture writeups are the best available explanation of serverless Postgres. Read them to understand precisely what we are choosing not to build. |
| **Xata** | Closest prior art on the database half. Apache 2.0: SQL gateway, branch operator, cluster and project services, scale-to-zero plugins, on CloudNativePG and OpenEBS. **Read their code before writing ours.** |
| **Supabase** | The Studio is the reference for what a database dashboard should feel like, and the self-hosted stack is the reference for how heavy this gets if you are not careful. |
| **Coolify / Dokploy / CapRover** | Now genuinely adjacent, since Phase 2 deploys apps. They deploy well and never sleep. Read them before writing compute. |
| **PostgresAI DBLab Engine** | Thin clones via ZFS and LVM, in production for years. The fallback branching path if reflinks disappoint. |
| **pgcat / PgDog / Supavisor** | Reference implementations of the Postgres wire protocol in a proxy. None do wake-on-connect. |
| **pgBackRest / Barman** | Backups are solved. We are wrapping, not reimplementing. |

## Hard constraints

- **TypeScript everywhere**, shipped as a compiled single binary. See ADR 0006.
- **Postgres stays unmodified.** No fork, no patched binaries, no required
  extensions for core function. If a feature needs a patched Postgres, the
  feature is wrong.
- **A reflink-capable filesystem for instant branching:** XFS with reflinks, ZFS,
  or APFS. **ext4 does not support reflinks**, and ext4 is the default image on a
  lot of the cheap VPS providers our audience uses. Branching degrades to a real
  copy there. Document it loudly, detect it at `hobby init`, warn rather than
  fail.
- **PostgreSQL 18 or newer is required only for cloning a database that is
  awake.** Cloning a cleanly stopped data directory is version independent, and
  hibernation means most instances are already stopped. This relaxes what was
  previously a floor. It is a claim that needs benchmarking before it is relied
  on: see `docs/branching/research/`.
- **Studio is exposed to the network**, so its auth is a security boundary rather
  than a formality. See ADR 0008.

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

Last Updated: 2026-08-07
