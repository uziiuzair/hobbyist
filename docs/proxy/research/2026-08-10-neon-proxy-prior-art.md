# Reading Neon's proxy, and what it says about ours

Status: NOTES. A survey, not a decision. Two findings are actionable against
shipped code and are called out as such.
Date:   2026-08-10

`docs/proxy/CLAUDE.md` names `pgcat`, `PgDog` and `Supavisor` as the prior art to
read, and notes that none of them do wake-on-connect. That is true, and it means
the most useful reference is not on that list. **Neon's `proxy/` crate is the
only production wire-protocol proxy that wakes a stopped compute**, and it is
Apache 2.0 at `github.com/neondatabase/neon`.

It is Rust, so ADR 0006 rules out taking the code. The value is entirely in the
shape, and the shape turns out to be one we already chose independently.

## The seam we already have, confirmed

`proxy/src/proxy/wake_compute.rs` defines a `WakeComputeBackend` trait with a
single `wake_compute(&self, ctx)` method, and a free function that wraps it in a
retry loop with backoff. The proxy calls it. The proxy never starts a compute.

That is `docs/proxy/CLAUDE.md`'s "the proxy asks, the engine acts", arrived at
separately by a team that has run it at scale for years. Our `ProxyDeps.resolve`
and `wake` in `packages/proxy/src/proxy.ts` occupy the same position. Nothing to
change here. It is worth recording because the seam is the thing that lets our
wake logic be tested against a fake engine with no Docker in the loop, and
independent convergence is the strongest evidence available that it is right.

## The stale address problem, which we already handle

`proxy/src/proxy/connect_compute.rs` carries this comment:

> If we couldn't connect, a cached connection info might be to blame (e.g. the
> compute node's address might've changed at the wrong time). Invalidate the
> cache entry (if any) to prevent subsequent errors.

The handling is `invalidate_cache(node_info)` followed by a second
`wake_compute` call. `proxy/src/cache/node_info.rs` is the cache being
invalidated.

`packages/proxy/src/proxy.ts:339` does the equivalent, and for the stated reason:

> a new port allocation. Re-resolve rather than trust them.

Confirmed correct. This is a real failure mode and we are not exposed to it.

## Finding 1: cancel requests are detected and then dropped

`packages/proxy/src/proxy.ts:451` recognises a `CancelRequest` and closes the
socket, with a comment explaining that routing needs a `processId`/`secretKey`
to upstream registry which does not exist yet. `packages/proxy/test/proxy.test.ts:460`
asserts exactly that behavior.

`docs/proxy/CLAUDE.md`'s flow diagram says:

```
CancelRequest? -> route to the right upstream, do not treat as a wake
```

The second half is implemented. **The first half is not.** The user-visible
consequence is that Ctrl-C in `psql` against a hobbyist database silently does
nothing, and a runaway query cannot be cancelled by the client that started it.

Why this cannot be made stateless: Postgres hands the client a
`(processId, secretKey)` pair in `BackendKeyData` during startup, and the client
cancels by opening a **second, separate, unauthenticated TCP connection** that
carries only that pair. A proxy that passes the backend's real key straight
through therefore receives a cancel connection bearing a key it has no map for.

Neon's answer is `proxy/src/cancellation.rs`, which stores cancel keys in Redis
because they run many proxy processes. Constants there are worth stealing even if
the storage is not: `CANCEL_KEY_INITIAL_PERIOD` of 60 seconds, refreshed at 10
minutes, with a 30 second TTL slack, so short-lived connections do not leave
entries behind. It also rate limits incoming cancels per IP subnet using
`LeakyBucketRateLimiter`, because an unauthenticated packet that causes work is a
DoS surface.

We run one daemon on one box, so a `Map` from a proxy-minted key pair to the
upstream connection replaces the whole Redis layer. The proxy would mint its own
`BackendKeyData` toward the client, keep the backend's, and translate on cancel.

## Finding 2: nothing rate limits wake

`grep` for `rateLimit` across `packages/proxy/src` and `packages/cli/src` returns
nothing. Auth has a rate limiter; the wake path does not.

An unauthenticated TCP connection carrying a startup packet naming a sleeping
database currently causes a container start. Auth passthrough means the proxy has
not yet learned whether the client can authenticate at the point it decides to
wake, and that ordering is forced: we cannot authenticate without an upstream to
authenticate against.

That is inherent to wake-on-connect rather than a bug in our implementation, and
Neon hits it too. Their `proxy/src/rate_limiter/` holds `leaky_bucket.rs`,
`limiter.rs` and a `limit_algorithm/` for adaptive limits, applied per endpoint.

The threat model here is not a hostile internet, since ADR 0004 and the root
`CLAUDE.md` put multi-tenancy out of scope and every tenant is the same person.
It is a port-scanned box waking ten databases at once and swapping itself to
death, which is precisely the failure `docs/hibernation/CLAUDE.md` exists to
prevent. A per-resource wake cooldown is probably enough, and is much smaller
than what Neon needs.

## The rest of the crate, and what each part is good for

| Path | Why read it |
|---|---|
| `proxy/src/pglb/handshake.rs`, `proxy/src/pqproto.rs` | Startup and SSL negotiation reference. `pglb` is their Postgres load balancer half. |
| `proxy/src/pglb/copy_bidirectional.rs`, `passthrough.rs` | The socket pump after wake, including shutdown ordering. |
| `proxy/src/serverless/sql_over_http.rs` | Query over HTTP, with `conn_pool_lib.rs` behind it. Directly relevant to the Studio question in `docs/studio/CLAUDE.md` about what a query against a sleeping database does. |
| `proxy/src/scram/`, `proxy/src/sasl/` | A full SCRAM implementation, needed because they authenticate at the proxy. We pass through, so this is the subsystem our design avoids owning. Useful as a measure of what passthrough saves. |
| `compute_tools/src/pg_isready.rs`, `configurator.rs` | Readiness detection, which is the second segment of our cold start budget. |
| `compute_tools/src/compute_prewarm.rs` | Prewarming. Relevant only if the 170ms p50 in `2026-08-07-cold-start-measurements.md` regresses. |

Everything below the proxy in that repository (`pageserver/`, `safekeeper/`) is
the storage and compute separation that ADR 0001 declines to build. It is the
best available description of what we are choosing not to do, and no more.

## A debugging tool worth having

`github.com/neondatabase/elephantshark`, Apache 2.0, Ruby, actively maintained.
It sits in front of a Postgres and prints the wire traffic in both directions,
decoded by message type. That is exactly the instrument for the client matrix
listed as an open question in `docs/proxy/CLAUDE.md`, where the question is what
psql, node-postgres, Prisma, Drizzle and a GUI client actually send and expect
when the first connection is slow.

Ruby is not in our stack, but this is a development tool rather than a
dependency, so `docs/CLAUDE.md`'s rule about executables not living beside docs
is the only constraint, and it belongs in `tools/` if we keep it.

## Open questions this raises

- Does cancel routing land in M2 as part of the keystone, or later? It is a
  correctness gap in a shipped component, and the flow diagram in
  `docs/proxy/CLAUDE.md` already promises it.
- Is a per-resource wake cooldown sufficient, or does the wake path need a real
  limiter? The answer depends on whether the proxy port is expected to be
  internet-facing, which is not written down anywhere yet.
- `docs/proxy/CLAUDE.md` still reads `Status: PROPOSED. Nothing built.` The proxy
  is built. That header needs reconciling with `packages/proxy/`, separately from
  this file.
