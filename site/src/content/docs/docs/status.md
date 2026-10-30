---
title: Alpha status and known gaps
description: What works, what is rough, what is openly broken, and what is built but not reachable. The honest inventory.
---

<p class="state state--failed">read this before you rely on anything</p>

This is v0-alpha. The purpose of this page is that you can decide correctly
whether to run it, and know which half is safe.

Last reviewed 2026-10-30, against `main`, after the QA lanes of 2026-10-16 to
2026-10-19 (Apple M5 Pro with Docker 29.4 via OrbStack, and an Ubuntu 24.04
container with its own dockerd on the same host).

## The vocabulary

| Label | Means |
|---|---|
| **reliable** | Run in anger, and verified against real Docker rather than only tested |
| **works, rough edges** | Verified against real Docker, but young and under-exercised |
| **known broken** | Broken, with the reason written down and linked |
| **not reachable** | The code exists and passes tests, and no command or route calls it |
| **not built** | Designed or not, but absent |

## Working

| Thing | Status | Notes |
|---|---|---|
| `postgres` | reliable | Cold start measured 2026-08-07. Eject verified end to end against real Docker 2026-08-08 |
| `hobby eject` | reliable | The promise that makes the rest honest, and the one exercised most deliberately |
| `app` | works, rough edges | Any Dockerfile, built and served. Cold start p50 121ms, p95 133ms |
| `worker` | works, rough edges | workerd via Miniflare. Durable Object state verified to survive a sleep against real Docker |
| Durable Object alarms | works, rough edges | An alarm armed 60s out fired 61s after the container was stopped, verified 2026-08-11. Can be up to one mirror tick (10s) late, plus a cold start |
| `queue` | works, rough edges | Consuming, producing from a container, retries, dead letters and lease expiry all ran against real Docker on macOS, 2026-10-19. The Linux producer fix still owes a Linux re-run, see [Unmeasured](#unmeasured) |
| Studio | alpha | Browsing, SQL and schema work. Network exposed by design |
| MCP | works, postgres and queues | Eighteen tools over the daemon API (`packages/mcp/src/server.ts`). No deploy tool |
| Caddy and TLS | works, off by default | `caddyEnabled` defaults to `false`. Measured on Linux and OrbStack |
| `hobby branch` | works, rough edges | A new project from a clone of a project's data. Postgres-only projects. Ran against real Docker on ext4 in an Ubuntu 24.04 container, 2026-10-16, with the full-copy warning. Clone times on a reflink filesystem are unmeasured |
| `hobby snapshot` | works, rough edges | Take, list, restore into a copy or in place, delete. `--online` for Postgres-only projects. Ran against real Docker on APFS, 2026-10-19. Local to the box; see [Snapshots](/docs/guides/snapshots/) |
| Remote CLI | works, rough edges | `hobby login <url>` and every command runs against that box with an API token. [ADR 0018](/docs/decisions/0018-the-cli-talks-to-a-remote-daemon/) |
| The proxy binds loopback | reliable | Default since [ADR 0017](/docs/decisions/0017-the-proxy-binds-loopback-by-default/); `proxyHost` opens it, and `proxyTls` makes `"all"` safe ([ADR 0019](/docs/decisions/0019-the-proxy-terminates-tls/)). `ss` on a fresh install shows `127.0.0.1:5432` |

## Known broken

### Retention never sweeps a queue with no drainable consumer

Which includes every dead letter queue. Messages accumulate there and the
retention setting does not remove them. `sweepRetention` has exactly one
caller, `tickOneQueue` (`packages/queue/src/tick.ts`), and `drainableQueues`
(`packages/cli/src/daemon/queues.ts`) excludes any queue whose consumer is
null, undeployed or released.

### Caddy's certificate store is not persisted

The Caddy container is created with no volume, so replacing it re-issues every
certificate. On a busy box that runs into Let's Encrypt rate limits. Avoid
recreating the container casually until this is fixed.

### ext4 has no reflinks

Cheap copies need a reflink-capable filesystem: XFS with reflinks, ZFS, or APFS.
ext4 has none, and ext4 is the default image on a lot of the cheap VPS providers
this is aimed at. There the copy is a real copy, which is correct but slow and
costs full disk space. `hobby init` detects it and warns rather than failing,
and so does `hobby branch`.
[Filesystem requirements](/docs/reference/filesystems/).

### An app cannot wake its own database by container name

An app that reaches its sibling database by container name on the project's
docker network gets `EAI_AGAIN` while the database sleeps, because Docker
resolves running containers only. The fix that exists is `--database`: a bound
database is handed to the app as `DATABASE_URL` built against
`host.docker.internal` and the proxy port (`HOST_FROM_CONTAINER`,
`packages/app/src/app.ts`; `hyperdriveUrl` in `packages/worker/src/worker.ts`
does the same for a worker), so the app's first query wakes it. An app that builds its own
connection string against the container name still has the problem.
Measured 2026-08-22.
[The finding, with three options](https://github.com/uziiuzair/hobbyist/blob/main/docs/compute/research/2026-08-22-real-app-cold-start-and-the-sibling-wake-gap.md).

### A real Next.js monorepo does not build on a 1GB box

A Next.js image that copies the whole repository came out at 2 to 3GB and
needed a 6GB Node heap to build, which is not a thing a 1 vCPU, 1GB VPS can
do. Found deploying a production monorepo in October 2026. The workaround is
to build elsewhere and have the box pull the image; see
[Next.js on Hobby](/docs/guides/nextjs/).

## Not reachable

Nothing at the moment. Snapshots were the last entry here and are now
`hobby snapshot`.

## Not built

| Thing | Notes |
|---|---|
| Creating an `app` or `worker` from Studio or MCP | Both hardcode `kind: 'postgres'` (`packages/mcp/src/tools.ts`, `hobby_new`). The daemon side that makes it possible has landed ([ADR 0014](/docs/decisions/0014-resource-records-exist-before-code/)) |
| MCP over the network | By decision, not omission: the MCP server stays on the unix socket (`docs/mcp/CLAUDE.md`). The CLI reaches a remote box; an agent runs on the box |
| Scheduled snapshots, retention, offsite copies | `hobby snapshot` is manual. The schedule, the free-space floor and the weekly restore verification are designed in `docs/backups/specs/` and not built |
| Branching a project that holds apps, workers or queues | Refused. Their state is keyed to resource identity |
| `hobby do` verbs | The 2026-08-10 Durable Objects spec sketches `hobby do ls`, `inspect` and `rm`. None exists; Durable Object storage is reached only through the worker that owns it |
| Shipping a prebuilt image to `hobby deploy` | There is no `--image` flag. The off-box build path in [Next.js on Hobby](/docs/guides/nextjs/) works through a one-line Dockerfile instead |
| Object storage, volumes for compute | Phase 3 |
| Point in time recovery | Cut deliberately rather than deferred. [ADR 0016](/docs/decisions/0016-project-snapshots-and-no-pitr/) |

## Unmeasured

~~**The five dollar VPS.**~~ Closed 2026-08-22. Measured on DigitalOcean ext4
droplets, 512MB with swap and 1GB without, 60 wakes total: p50 691ms, p95
845ms, max 1336ms. 59 of 60 under the 1 second target, none over the 3 second
ceiling. More memory improved the median and not the tail.
[The write-up and its caveats](https://github.com/uziiuzair/hobbyist/blob/main/docs/proxy/research/2026-08-22-cold-start-on-a-five-dollar-vps.md).

**The queue producer path on a real Linux box, after the fix.** The two halves
of the Linux producer bug are both in the code now: `packages/worker/src/worker.ts`
passes `extraHosts` and `packages/core/src/docker.ts` emits `--add-host`, and
the daemon binds a new project's bridge gateway as it appears
(`queueEndpoint.addHost`, called from `packages/cli/src/daemon/server.ts`).
Everything ran on macOS. The bug was about Linux, and nobody has re-run the
producer path there since.
[The write-up of the second half](https://github.com/uziiuzair/hobbyist/blob/main/docs/queues/research/2026-08-22-the-producer-path-on-real-linux.md).

**App and worker wake on cheap hardware.** Only the database path has been
measured there. The published app and worker figures are still from a laptop.

**Other providers.** One box, one provider, one region, one afternoon. Hetzner,
Vultr and a Raspberry Pi are all still unmeasured.

**Clone times.** `hobby branch` has run against real Docker on ext4 (a full
copy of a tiny database, 0.9s end to end, which is not a benchmark). Nobody
has timed a clone on a reflink filesystem with a dataset worth timing, so the
"instant" claim rests on the filesystem's documentation rather than on this
project's numbers. On Linux, a daemon running as an ordinary user may also be
unable to read a data directory the Postgres container owns; the one Linux
run so far was as root in a container. Details in `docs/branching/CLAUDE.md`.

**Caddy on Docker Desktop for macOS.** It needs host networking. Linux and
OrbStack are both measured and fine. `hobby init` detects the absence and warns,
and nobody has confirmed the warning actually fires.

## Security posture

Studio is exposed to the network by design
([ADR 0008](/docs/decisions/0008-studio-is-network-exposed/)), which makes its
operator credential a real boundary rather than a formality. The same gate now
covers the loopback API port: every `/v1` route there needs the session cookie
or an API token from `hobby token create` or `hobby login`
([ADR 0018](/docs/decisions/0018-the-cli-talks-to-a-remote-daemon/)); only the
unix socket is open to whoever can read it. It is also the youngest surface
here. Put it behind Tailscale or a Cloudflare Tunnel rather than on the open
internet.

The Postgres proxy binds loopback by default. Two boxes installed from
`hobby.sh/install` were measured with it on every interface and no TLS on
2026-08-22, which is why the default changed
([ADR 0017](/docs/decisions/0017-the-proxy-binds-loopback-by-default/)).
Opening it with `proxyHost: "all"` without `proxyTls` puts your database on
the internet in cleartext; see
[configuration](/docs/reference/configuration/#reaching-a-database-from-another-machine).

Hobbyist assumes every tenant is the same person. There is no isolation between
projects beyond what Docker gives you, and hardening that is explicitly out of
scope, because it is one of the removals that makes the project buildable at
all. Do not use it to host other people's workloads.

Security reports go to business@uziiuzair.com rather than a public issue.
