---
title: Sleep and wake
description: The wedge, and how the proxy turns "your database is stopped" into "your first query was a bit slow".
sidebar:
  order: 2
---

<p class="state state--awake">the wedge</p>

**Everything sleeps, and everything wakes on demand.** This is the single reason
for the project to exist, and every design decision serves it.

## Why it is the whole product

Sleep on its own is easy and nearly useless. Wake on its own is meaningless.
Together they are what makes ten projects fit on a box that could not run ten
databases at once, and what makes that invisible to whatever connects.

It is also the one thing no self-hostable alternative does:

- **Self-hosted Supabase never sleeps.** It is a large multi-container stack that
  runs at full cost whether or not anything is using it.
- **Xata's open-source scale-to-zero plugin cannot wake a database.** In their
  own words, it "can't handle reactivation because the cluster is no longer
  running once it's hibernated." Automatic reactivation on connection is what
  they kept in the paid cloud.
- **Coolify and Dokploy deploy apps well and do not sleep them.**

## What happens when you connect

```
your client                proxy                      daemon
    |                        |                           |
    |--- TCP connect ------->|                           |
    |                        |-- resource is sleeping    |
    |     (held open)        |-- wake(resource) -------->|
    |                        |                           |-- start container
    |                        |                           |-- poll readiness
    |                        |<--- ready ----------------|
    |<-- handshake done -----|                           |
```

The client sees one slightly slow connection. It never sees an error, never
retries, and never needs to know the database was not there a moment ago.

Two properties of that diagram are load bearing:

**The proxy asks, the engine acts.** The proxy never starts a container itself.
It calls `wake(resource)` and waits. That is what makes wake logic testable
against a fake runtime with no Docker anywhere in the loop, and it is a seam the
project treats as non-negotiable.

**Readiness means readiness.** The daemon polls until Postgres actually accepts
a query, not until the port is open. Those are different, and the difference has
caused real bugs here: a TCP connect to a published container port succeeds the
instant the container is created, because Docker's port proxy binds the host
port whether or not anything inside is listening. A readiness probe built on
that reports healthy for a process that has already exited.
`packages/cli/src/daemon/reconcile.ts` documents this at length, and two later
resource kinds shipped with the same mistake anyway before real Docker caught
it.

## The budget

**Under 1 second target, 3 seconds hard ceiling.** Three seconds is roughly
where common ORM and pool connect timeouts begin firing, so anything above it is
a release blocker rather than a slow path.

| Path | p50 | p95 | Measured on | When |
|---|---|---|---|---|
| Postgres, wire protocol | **710ms** | **859ms** | **$5 VPS: 1 vCPU, 512MB, ext4** | 2026-08-22 |
| Postgres, wire protocol | 170ms | 186ms | Apple silicon laptop | 2026-08-07 |
| HTTP app | 121ms | 133ms | Apple M5 Pro | 2026-08-10 |
| Worker, workerd | 299ms | 321ms | Apple M5 Pro | 2026-08-10 |

The first row is the one that matters, because the budget was written for that
machine. Thirty consecutive wakes on a DigitalOcean `1vcpu-512mb` droplet on
ext4: **none exceeded the 1 second target**, and the slowest was 968ms.

Those two rows are not measured the same way. The VPS figure is end to end as a
client sees it, including `psql` startup, and the laptop figure is the proxy's
own internal span. Subtracting the client's own cost from the VPS run gives
about 608ms of wake work, so a five dollar box is roughly 3.6 times slower than
an M5 Pro. Same order, both inside budget.

Read the caveats before quoting it. The very first wake was the slowest at
968ms, because nothing was cached yet, and that is the case a real user meets.
The box was otherwise idle. And 512MB needs swap to install at all, so those
numbers describe 512MB *with swap*.
[The full write-up](https://github.com/uziiuzair/hobbyist/blob/main/docs/proxy/research/2026-08-22-cold-start-on-a-five-dollar-vps.md).

App and worker wake on that hardware are still unmeasured.

## What sends something to sleep

The daemon hibernates a resource after `sleepAfterSeconds` of inactivity, 300 by
default. Activity is measured by the proxy, which is also the thing that wakes
it: the component that holds the illusion is the same component that senses
whether the illusion is needed.

A kind can refuse to sleep. `ResourceKindHandler.guard` is where that lives, and
the worker handler uses it to refuse a sleep when a Durable Object alarm is
about to fire, because an alarm cannot fire inside a stopped container.

## Keeping one thing awake

Sometimes one project genuinely cannot afford a slow first request. You can
exempt it, and only it:

```sh
hobby pin blog                       # never sleep this project
hobby unpin blog                     # back to the box-wide default
hobby unpin blog --sleep-after 3600  # or its own threshold, in seconds
```

The threshold is a property of the project rather than of the box, which is
what makes this usable: pinning your status page awake does not also keep nine
idle side projects running. "Pinned" is the hibernator's own word for a project
with no threshold set, so the command uses the same vocabulary the code does
rather than inventing a second one.

## What wakes it

| Kind | Wakes on |
|---|---|
| `postgres` | An inbound connection through the proxy on 5432 |
| `app`, `worker` | An inbound HTTP request through the router |
| `queue` consumer | **A message arriving.** No connection involved |

The queue case is the interesting one, and the newest. It is the first thing
here where stored state rather than an inbound connection starts a container: a
message posted for a sleeping consumer wakes it, and a backlog that accumulated
while it slept is drained when it comes back. Verified against real Docker with
no HTTP request in the loop.

## Sleeping has no colour

A small thing, deliberately: in Studio and on this site, `sleeping` gets no
accent colour and no warning styling. Sleeping is the product working correctly.
Only `waking` and `running` earn chroma. If a sleeping resource ever looked like
a problem, the interface would be arguing against the feature.
