<div align="center">

# Hobbyist

**Your stack. Your box. Their convenience.**

A self-hosted platform that feels like Neon and Supabase, on hardware you own.
Everything sleeps when nothing is using it, and wakes when something connects.

[Documentation](https://hobbyist.sh/docs/) ·
[Comparison and pricing](https://hobbyist.sh/compare/) ·
[Decisions](https://hobbyist.sh/docs/decisions/)

</div>

---

> [!WARNING]
> **This is v0-alpha. It is not production ready and it is not a business.**
>
> Postgres is the part that is reliably configured and working. Everything
> else on this page is somewhere between solid and openly broken, and the
> [Status](#status) section says which is which, by name. There is no warranty
> and no support obligation. Do not put data you cannot afford to lose in here
> without your own backups.

```sh
curl -fsSL https://hobby.sh/install | bash
```

Then:

```sh
hobby daemon &
hobby new blog
```

The second command prints a connection string. Point `psql` at it, walk away,
come back tomorrow: the database stopped while you were gone and started again
when you connected.

## What this is

Managed platforms sell convenience. Instant provisioning, branching, scale to
zero, a connection string that just works, a dashboard that makes a database
legible, a deploy that happens on push.

Every primitive underneath that convenience is already free and mature.
Postgres is free. Containers are free. Caddy gets you TLS for nothing. The
convenience itself is what people pay for, and it is the only thing missing
from the self-hosted world.

Hobbyist is that convenience layer. One command gives you a project with a
Postgres in it. A studio you would actually choose to open. Everything sleeps
when nothing is using it and wakes when something connects. It runs on one box,
with no Kubernetes, and you can walk away from it at any time with a single
command.

**Who it is for.** With the rise of AI came a lot of new hobbyists, people who
build far more things for themselves than they used to, and who do not want a
separate bill for each experiment. If you have a home server, an old laptop, or
a five dollar VPS, and a folder of half-finished projects that each want a
database, this is for you.

## The wedge

**Everything sleeps, and everything wakes on demand.** This is the single
reason for the project to exist, and it is the one thing no self-hostable
alternative does:

- **Self-hosted Supabase never sleeps.** It is a large multi-container stack
  that runs at full cost whether or not anything is using it.
- **Xata's open-source scale-to-zero plugin cannot wake a database.** In their
  own words, it "can't handle reactivation because the cluster is no longer
  running once it's hibernated." Automatic reactivation on connection is what
  they kept in the paid cloud.
- **Coolify and Dokploy deploy apps well and do not sleep them.**

Sleep is what makes ten projects fit on one small box. Wake is what makes sleep
invisible. Neither is useful without the other, and the pair is the product.

The component that does it is a proxy speaking the Postgres wire protocol. It
holds your connection open, asks the daemon to start the container, waits for
the database to actually accept queries, and then finishes the handshake. Your
client sees one slightly slow connection. It never sees an error.

### Cold start, measured

The budget is **under 1 second target, 3 seconds hard ceiling**. Three seconds
is roughly where common ORM and pool connect timeouts start firing, so anything
above it is a release blocker rather than a slow path.

| Path | p50 | p95 | Measured on | When |
|---|---|---|---|---|
| Postgres, on a $5 VPS | **691ms** | **845ms** | 1 vCPU, 512MB and 1GB, ext4 | 2026-08-22 |
| Postgres, wire protocol | 170ms | 186ms | Apple silicon laptop | 2026-08-07 |
| HTTP app | 121ms | 133ms | Apple M5 Pro | 2026-08-10 |
| Worker (workerd) | 299ms | 321ms | Apple M5 Pro | 2026-08-10 |

**The five dollar VPS is measured.** Sixty consecutive wakes on DigitalOcean
droplets on ext4, through the shipped proxy and daemon with a real `psql`
client: thirty on a 512MB box with swap, thirty on a 1GB box without.
**59 of the 60 came in under the 1 second target**, the slowest was 1336ms, and
**none came within half of the 3 second ceiling**, which is the number that
matters because that is where clients give up.

The more useful finding is the comparison. Doubling the memory improved the
median wake by about 12 percent and did nothing at all for the tail: p95 wake
work went from 757ms to 751ms, while the worst case got worse and the spread
between median and maximum nearly tripled. **Memory sets the median; the shared
vCPU sets the tail.** A wake that stalls because a neighbour took the CPU is not
something more RAM fixes. If tail latency matters to you more than the median,
buy a dedicated CPU rather than more memory.

Caveats that travel with these numbers: the first wakes of a run are the slowest
because nothing is cached, both boxes were otherwise idle, and 512MB cannot
build at all without swap.

The two Postgres rows are not the same metric: the VPS figure is end to end as a
client sees it, including `psql` startup, and the laptop figure is the proxy's
own internal span. Net of the client's own cost the VPS does about 608ms of wake
work, roughly 3.6 times an M5 Pro. Same order, both inside budget.

Still unmeasured: app and worker wake on cheap hardware, and any provider that
is not DigitalOcean. Reproduce with `scripts/measure-cold-start.sh`.

Raw data: [`docs/proxy/research/`](docs/proxy/research/) and
[`docs/compute/research/`](docs/compute/research/).

## What is in the box

A **project** is a namespace holding typed resources.
`packages/core/src/types.ts` defines four kinds:

| Kind | What it is | Sleeps | Wakes on |
|---|---|---|---|
| `postgres` | Postgres 18 in a container, on a plain `PGDATA` | yes | an inbound connection |
| `app` | any Dockerfile, built and served over HTTP | yes | an inbound request |
| `worker` | a Cloudflare-style Worker on workerd, via Miniflare | yes | an inbound request |
| `queue` | a durable message queue with a consumer binding | yes | **a message arriving** |

Durable Objects are a capability of `worker`, not a fifth kind. Their alarms
are mirrored outside the runtime so an alarm can fire for an object whose
container is stopped, which is the part that is normally impossible.

Around those four:

- **Studio**, a web UI for browsing tables, running SQL and reading schema.
- **MCP**, 14 tools over the daemon API, so an agent drives the same control
  surface the CLI does.
- **`hobby eject`**, which hands you a `docker-compose.yml` and the data
  directory and gets out of the way.

## Quickstart

Every verb below exists today in `packages/cli/src/cli/main.ts`.

```sh
hobby init                        # prepare the host, check the filesystem
hobby daemon                      # run the daemon in the foreground

hobby new blog                    # project + postgres + connection string
hobby ls                          # everything, with sleep state
hobby connect blog                # open psql against it

hobby deploy ./my-app             # build a Dockerfile here and serve it
hobby create worker api --project blog

hobby sleep blog                  # put it to sleep now
hobby wake blog                   # wake it back up
hobby logs blog --tail 100

hobby queue create jobs --project blog
hobby queue send blog/jobs '{"hello":"world"}'
hobby queue peek blog/jobs

hobby studio passwd               # set the operator password
hobby studio                      # print the studio URL

hobby eject blog                  # docker-compose.yml plus the data
hobby eject blog --release        # the same, and stop managing it
hobby adopt blog                  # manage a released project again
```

`<target>` is `project` when the project holds one resource, and
`project/resource` otherwise. Every command that returns data takes `--json`.

## Status

The vocabulary: **reliable** means it has been run in anger. **Works, rough
edges** means it has been verified against real Docker but is young. **Known
broken** means exactly that, and links to the file recording it. **Not
reachable** means the code exists and no user-facing surface calls it.

| | Status | Notes |
|---|---|---|
| `postgres` | **reliable** | Cold start measured, eject verified end to end 2026-08-08 |
| `app` | works, rough edges | Cold start measured 2026-08-10 |
| `worker` | works, rough edges | Durable Object state verified across a sleep against real Docker |
| Durable Object alarms | works, rough edges | Can be up to one mirror tick (10s) late, plus a cold start |
| `queue` | **known broken on Linux** | The consumer half works. `env.MY_QUEUE.send()` from inside a container fails DNS on Linux, see below |
| Studio | alpha | Network exposed by design (ADR 0008). Run it behind Tailscale or a tunnel, not on the open internet |
| MCP | works, postgres only | 14 tools. Creating an `app` or `worker` from MCP is not wired yet |
| `hobby eject` | **reliable** | Verified end to end against real Docker 2026-08-08 |
| Caddy and TLS | works, off by default | `caddyEnabled` defaults to `false`. Certificates are not persisted across container replacement |
| Snapshots | **not reachable** | `takeSnapshot` is implemented and tested but has no CLI verb and no HTTP route |
| Copy-on-write branching | not built | Phase 1.5 |
| Remote deploy | not built | The CLI talks to a unix socket, so it must run on the daemon's own box |
| Object storage | not built | Phase 3 |

### Known gaps, in detail

**The queue producer path does not work on Linux.** Not untested,
unimplemented. `packages/worker/src/worker.ts` hands every producer container
`http://host.docker.internal:<port>/enqueue`, which macOS resolves and Linux
does not unless the container was created with
`--add-host=host.docker.internal:host-gateway`. Nothing passes that flag. The
daemon's own half is correct. The two halves live in different packages and
never meet. Consuming works on both. See
[`docs/queues/CLAUDE.md`](docs/queues/CLAUDE.md).

**Snapshots are built but you cannot take one.** `takeSnapshot`, `restore`,
`listSnapshots` and a manifest format all exist in
`packages/cli/src/daemon/snapshots.ts` with tests, and every caller today is a
test. There is no `hobby snapshot` verb and no route. Until that changes, back
up with `pg_dump` and treat the snapshot code as unreleased.

**Caddy's certificate store is not persisted.** The container is created with
no volume, so replacing it re-issues certificates. That matters against Let's
Encrypt rate limits.

**Caddy on Docker Desktop for macOS is unmeasured.** It needs host networking.
Linux and OrbStack are both measured and fine. `hobby init` detects the absence
and warns rather than failing later.

**ext4 has no reflinks.** Instant branching, and cheap snapshots, need a
reflink-capable filesystem: XFS with reflinks, ZFS, or APFS. ext4 is the
default image on a lot of the cheap VPS providers this project is aimed at, and
there the copy is a real copy. `hobby init` detects it and warns.

**Studio has an operator credential and is exposed by design.** ADR 0008 makes
that a security boundary rather than a formality. It is also the youngest
surface here. Put it behind Tailscale or a Cloudflare Tunnel.

## Requirements

- **Linux or macOS.** Ubuntu and Debian are the tested Linux targets. There is
  no Windows path.
- **Docker.** Every resource is a container, so this is not optional. OrbStack
  works on macOS and is what the measurements were taken on.
- **`git` and `unzip`.** `unzip` is needed by Bun's own installer and is absent
  from a fresh Ubuntu cloud image, which is how a five dollar VPS fails at the
  Bun step. `sudo apt-get install -y git unzip`.
- **About 640MB of memory and swap together, to build.** Measured on one core
  with no swap: the TypeScript build was killed by the kernel at 512MB, and
  completed at 640MB. 512MB is marginal and went both ways across runs. On a
  512MB droplet, add swap before installing.
- **Bun 1.1 or newer.** `install.sh` installs it under `~/.bun` if it is
  missing, and needs no root to do it.
- **A reflink-capable filesystem** if you want cheap copies: XFS with reflinks,
  ZFS, or APFS. Optional, and warned about rather than enforced.
- **PostgreSQL 18 or newer** is required only for cloning a database that is
  awake. Cloning a cleanly stopped data directory is version independent, and
  since hibernation means most instances are stopped, that is the usual case.

## Architecture

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

The **daemon** owns state and lifecycle. The **proxy** owns the illusion, and
is also the activity sensor hibernation reads. **Caddy** owns TLS and HTTP
routing. The **data directory** owns the escape hatch.

Three seams that are not negotiable:

- **The proxy asks, the engine acts.** The proxy never starts a container. It
  calls `wake(resource)` and waits, which is what makes wake logic testable
  against a fake engine with no Docker in the loop.
- **`core` knows nothing about Docker.** The `ComputeRuntime` interface
  (ADR 0002) is the escape hatch and the seam new resource kinds plug in
  through.
- **The daemon API is the only control surface.** CLI, Studio and MCP are three
  clients of one HTTP API, and none of them touches Postgres or Docker
  directly.

Ports, all overridable: proxy `5432`, Studio `8443`, daemon API `7432`
(loopback), HTTP router `7433`, queues `7434`. State lives under `~/.hobby`,
and a database's files are at
`~/.hobby/projects/<project>/<resource>/pgdata/18/docker`.

## You can always leave

This is the first promise and the one that makes the rest honest.

The data directory is a plain Postgres data directory. Nothing here is a
proprietary format, no extension is required, and Postgres itself is
unmodified. `pg_dump` always works.

```sh
hobby eject blog             # docker-compose.yml plus the data, still managed
hobby eject blog --release   # the same, and hobby stops managing it
hobby adopt blog             # changed your mind
```

What you get is a directory you can `docker compose up` on any machine with
Docker, with no Hobbyist installed anywhere. That is the whole exit.

## Not a business

Nobody is expected to pay. There is no cloud offering, no hosted tier, no paid
feature, no metering and no billing, and no roadmap toward one. Nothing is held
back behind a paid guard.

That fact is load-bearing rather than a disclaimer. It removes multi-tenancy,
isolation hardening, usage accounting and quota enforcement from scope, and
those removals are what make the project buildable by one person.

The success metric is that the author is still using it daily in six months.
Stars, forks and issue count are noise.

## Comparison

The short version, with the full table and the pricing at
[hobbyist.sh/compare](https://hobbyist.sh/compare/):

| | Hobbyist | Neon | Supabase | Fly.io | Cloudflare |
|---|---|---|---|---|---|
| Wake on connect | yes | yes | no, free tier pauses for a week | partial | n/a |
| Self-hostable with wake | **yes** | no | no | no | no |
| Runs on your hardware | yes | no | self-host without sleep | no | no |
| Walk away with your data | `hobby eject` | `pg_dump` | `pg_dump` | `pg_dump` | varies |
| Cost of ten idle projects | one box | free tier fits | needs a paid plan | per machine | free tier fits |
| Production ready | **no** | yes | yes | yes | yes |

That last row is the one that matters right now.

## Documentation

- [Getting started](https://hobbyist.sh/docs/) and
  [your first project](https://hobbyist.sh/docs/first-project/)
- [Roadmap](https://hobbyist.sh/roadmap/), every phase with what is actually
  built, what is half built, and what is deliberately never coming
- [Sleep and wake](https://hobbyist.sh/docs/concepts/sleep-and-wake/), the wedge
  explained
- [CLI reference](https://hobbyist.sh/docs/reference/cli/) and the
  [daemon HTTP API](https://hobbyist.sh/docs/reference/api/)
- [Decisions](https://hobbyist.sh/docs/decisions/), fifteen ADRs. The record of
  what this project chose **not** to build is the more useful half

## Contributing

Welcome, and please read [CONTRIBUTING.md](CONTRIBUTING.md) first. It says what
is likely to be accepted, what needs an ADR before any code, and the two
working agreements that will get a patch sent back (no em-dashes, and ground
claims in code).

The most useful contributions right now, in order: the Linux queue producer
fix, a CLI verb for snapshots, and a cold start measurement on hardware nobody
has tried (Hetzner, a Pi, anything not DigitalOcean).
`scripts/measure-cold-start.sh` runs it and prints the hardware with the
numbers.

## Licence

Apache License 2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).

Provided on an "AS IS" basis, without warranties or conditions of any kind.
Here that is not boilerplate: this is a v0-alpha project written by one person
and nobody is paid to keep it running.
