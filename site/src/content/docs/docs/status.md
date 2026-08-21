---
title: Alpha status and known gaps
description: What works, what is rough, what is openly broken, and what is built but not reachable. The honest inventory.
---

<p class="state state--failed">read this before you rely on anything</p>

This is v0-alpha. The purpose of this page is that you can decide correctly
whether to run it, and know which half is safe.

Last reviewed 2026-08-21, against `main`.

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
| `queue`, consuming | works, rough edges | A message arriving wakes a sleeping consumer. This is the first thing here where stored state, not a connection, starts a container |
| Studio | alpha | Browsing, SQL and schema work. Network exposed by design |
| MCP | works, postgres only | Fourteen tools over the daemon API |
| Caddy and TLS | works, off by default | `caddyEnabled` defaults to `false`. Measured on Linux and OrbStack |

## Known broken

### The queue producer path does not work on Linux

Unimplemented, not untested. `packages/worker/src/worker.ts` hands every
producer container `http://host.docker.internal:<port>/enqueue`. macOS resolves
that name; Linux does not, unless the container was created with
`--add-host=host.docker.internal:host-gateway`, and nothing passes that flag.
The daemon's own half is correct: it binds the project bridge gateway on Linux.
The two halves live in different packages and never meet, so
`env.MY_QUEUE.send()` fails DNS on exactly the five dollar VPS this project is
aimed at.

Consuming works on both platforms. Found by reading the code during a
whole-branch review, after every end-to-end run had passed on macOS.
[The write-up](https://github.com/uziiuzair/hobbyist/blob/main/docs/queues/CLAUDE.md).

### Retention never sweeps a queue with no drainable consumer

Which includes every dead letter queue. Messages accumulate there and the
retention setting does not remove them.

### Caddy's certificate store is not persisted

The Caddy container is created with no volume, so replacing it re-issues every
certificate. On a busy box that runs into Let's Encrypt rate limits. Avoid
recreating the container casually until this is fixed.

### ext4 has no reflinks

Cheap copies need a reflink-capable filesystem: XFS with reflinks, ZFS, or APFS.
ext4 has none, and ext4 is the default image on a lot of the cheap VPS providers
this is aimed at. There the copy is a real copy, which is correct but slow and
costs full disk space. `hobby init` detects it and warns rather than failing.
[Filesystem requirements](/docs/reference/filesystems/).

## Not reachable

### Snapshots

`takeSnapshot`, `restore`, `listSnapshots`, a manifest format and a quiesce and
resume cycle all exist in `packages/cli/src/daemon/snapshots.ts`, with tests.
Every caller today is a test. There is no `hobby snapshot` verb and no HTTP
route, so **you cannot take one**.

Until that changes, back up with `pg_dump`, and do not read the presence of
snapshot code as a backup story.

## Not built

| Thing | Notes |
|---|---|
| Copy-on-write branching | Phase 1.5. The `cloneTree` primitive it needs already exists |
| Remote deploy, laptop to VPS | The CLI talks to a unix socket, so today it must run on the daemon's own box. Needs its own decision record first |
| Creating an `app` or `worker` from Studio or MCP | Both hardcode `kind: 'postgres'`. The daemon side that makes it possible has landed (ADR 0014) |
| Studio API tokens | Not designed beyond the label |
| Object storage, volumes for compute | Phase 3 |
| Point in time recovery | Cut deliberately rather than deferred. [ADR 0016](/docs/decisions/0016-project-snapshots-and-no-pitr/) |

## Unmeasured

~~**The five dollar VPS.**~~ Closed 2026-08-22. Measured on a DigitalOcean
`1vcpu-512mb` droplet on ext4: 30 consecutive wakes, p50 710ms, p95 859ms, max
968ms, none over the 1 second target.
[The write-up and its caveats](https://github.com/uziiuzair/hobbyist/blob/main/docs/proxy/research/2026-08-22-cold-start-on-a-five-dollar-vps.md).

**App and worker wake on cheap hardware.** Only the database path has been
measured there. The published app and worker figures are still from a laptop.

**Other providers.** One box, one provider, one region, one afternoon. Hetzner,
Vultr and a Raspberry Pi are all still unmeasured.

**Caddy on Docker Desktop for macOS.** It needs host networking. Linux and
OrbStack are both measured and fine. `hobby init` detects the absence and warns,
and nobody has confirmed the warning actually fires.

## Security posture

Studio is exposed to the network by design
([ADR 0008](/docs/decisions/0008-studio-is-network-exposed/)), which makes its
operator credential a real boundary rather than a formality. It is also the
youngest surface here. Put it behind Tailscale or a Cloudflare Tunnel rather
than on the open internet.

Hobbyist assumes every tenant is the same person. There is no isolation between
projects beyond what Docker gives you, and hardening that is explicitly out of
scope, because it is one of the removals that makes the project buildable at
all. Do not use it to host other people's workloads.

Security reports go to business@uziiuzair.com rather than a public issue.
