# What a real app actually costs to wake, and a bug found doing it

Status: NOTES, measured 2026-08-22 on a DigitalOcean `1vcpu-1gb` on ext4.
**Contains a correction to a published number and one open bug.**

The published app figure, p50 386ms, was measured against a busybox static
server. That is the lightest thing that can answer HTTP, and it cannot answer
the question people actually ask, which is whether a real framework app takes
long enough to boot that the request times out. Someone asked exactly that in
public. This measures it.

## Four fixtures, same box, same day

| Fixture | Boots | n | p50 | p95 | max | warm p50 |
|---|---|---|---|---|---|---|
| `static` busybox httpd | nothing | 20 | 386ms | 632ms | 911ms | 21ms |
| `express` Node 22 + Express 5 | a Node runtime | 15 | 724ms | 979ms | 1041ms | 23ms |
| `nextjs` Next.js 15 standalone, dynamic page | Node + the React server runtime | 15 | **1828ms** | **1989ms** | 1991ms | 68ms |

Against the budget of a 1 second target and a 3 second hard ceiling:

- `static`: comfortably inside the target.
- `express`: p50 inside, **max 1041ms is outside**.
- `nextjs`: **every single one of 15 wakes missed the 1 second target**, the
  fastest being 1600ms. All were inside the 3 second ceiling, with about a
  second to spare.

## The decomposition is the useful part

Net of each fixture's own client cost:

| | wake work | added by |
|---|---|---|
| `static` | ~365ms | container start and the readiness probe |
| `express` | ~701ms | +336ms for a Node runtime |
| `nextjs` | ~1760ms | +1059ms for the Next.js server |

**About 21 percent of a Next.js cold start is the container. The other 79
percent is the application booting**, and nothing in the container runtime's
control makes that faster. This matters for any proposal to change the runtime:
swapping Docker for something that starts faster addresses the 365ms and leaves
the 1395ms alone.

The lever that would actually move it is restoring an already-booted process
rather than booting one, which is a different feature from the runtime choice.

## The correction

The site and README say app wake is p50 386ms on a five dollar box. That is
true and it is the best case. Quoted without the fixture it is misleading,
because the number a reader cares about is their app, and a Next.js app is
**4.7x slower** than the number published.

## The bug: an app cannot wake its own database

While measuring the app-plus-database fixture, the deploy failed:

```
hobby-bench-nxtdb did not start listening on port 8080 within 30343ms
```

The container was up and Next.js was serving. The real error was in its log:

```
Error: getaddrinfo EAI_AGAIN hobby-bench-primary
```

`resolveDatabaseUrl` (`packages/app/src/app.ts:82`) points an app at its
sibling by **container name**, on the project's docker network. Docker's
embedded DNS resolves running containers only, and the database was
`Exited (0)`, which is what `sleeping` means.

So a woken app cannot resolve a sleeping database, and, worse, **cannot wake
it**: the connection is aimed inside the docker network at the container name,
which never touches the wake-on-connect proxy on 5432. There is no code path
where an app's connection attempt wakes a sibling.

The design assumed otherwise, and says so in a comment at `app.ts:73`:

> An app must reach its database directly, because the wake-on-connect proxy
> would otherwise be woken by an app that was itself only just woken, and the
> app's own liveness is already the thing keeping the pair awake.

That reasoning holds only while the two are awake together. They sleep
independently, on independent idle timers, so an app that wakes to a sleeping
database gets a DNS failure and stays broken until something else happens to
wake the database.

This is the product's central claim failing in the most ordinary arrangement it
has: a web app and its database.

### Options, none of them taken here

1. **Point the app at the proxy instead of the container.** The proxy already
   wakes on connect and already accounts for activity. The comment above
   objects that an app would then wake its own database, but that is the
   desired behaviour, not a hazard. Needs the proxy reachable from inside the
   project network, which is the same gateway problem the queue endpoint
   already solved.
2. **Wake siblings when an app wakes.** Simple and blunt: waking an app wakes
   every resource it is bound to. Costs memory on a small box by waking things
   that may not be used.
3. **Keep bound pairs on a shared sleep decision.** They sleep and wake
   together, which removes the failure by removing the independence.

Option 1 is the one that fits what already exists.

## Method notes

Every request asserts HTTP 200, so a fast failure cannot be recorded as a fast
wake. `nextjs` uses `output: 'standalone'` and a `force-dynamic` page, so this
measures Next.js answering a request rather than a filesystem serving a
prerendered file. The box had 2GB of swap added so the Next.js image could
build; swap was not under pressure during measurement.

Fixtures are committed at `scripts/fixtures/`, so the numbers are reproducible
rather than described.
