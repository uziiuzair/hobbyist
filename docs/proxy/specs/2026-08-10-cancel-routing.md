# Cancel routing

Status: RATIFIED. Built and shipped in `packages/proxy/`.
Date:   2026-08-10

Closes the half of the flow in `docs/proxy/CLAUDE.md` that was promised and
not built:

```
CancelRequest? -> route to the right upstream, do not treat as a wake
```

Only the second clause existed. `handleConnectionInner` in
`packages/proxy/src/proxy.ts` recognised a cancel and called `socket.end()`,
so Ctrl-C in `psql` against a hobbyist database did nothing at all and a
runaway query could not be stopped by the client that started it.

Raised as Finding 1 of `../research/2026-08-10-neon-proxy-prior-art.md`.

## Why it could not simply be forwarded

Postgres cancellation is deliberately outside the connection it cancels. A
client that wants to stop a running query opens a **second, separate,
unauthenticated** TCP connection, sends a CancelRequest carrying only the
`(processId, secretKey)` pair the backend gave it in BackendKeyData during
startup, and the backend closes the connection without replying. There is no
authentication on that second connection, which is why the pair is a secret
rather than an identifier.

For a proxy that means the cancel arrives with no database name, no user, and
nothing else to route on. **The key is the whole address.** A proxy that
splices the backend's real key straight through to the client therefore
receives a cancel bearing a key it has no map for, and can only drop it.

That is not a gap that better forwarding closes. The proxy has to own the key.

## What was built

Four pieces, all inside `@hobby.sh/proxy`. The daemon is unchanged, and so is
`ProxyDeps`: this is state that exists only because connections pass through
the proxy, not world the daemon has to supply.

| Piece | Where |
|---|---|
| The key pair as a type, and a CancelRequest builder | `src/startup.ts`, `CancelKey` and `buildCancelRequest` |
| Reading the backend's startup messages and swapping the key | `src/startup.ts`, `scanBackendStartup` |
| The map from a minted key to a live connection | `src/cancel.ts`, `CancelRegistry` |
| Rewriting on the way past, and delivering a cancel | `src/proxy.ts`, `spliceAndTrackActivity` and `handleCancel` |

The sequence, for one connection:

1. `spliceAndTrackActivity` registers the connection with `CancelRegistry.add`
   before the backend has said anything, and gets back a minted key. The
   address is already known; the backend's own key is not yet.
2. The backend to client direction is read one message at a time by
   `scanBackendStartup`. When BackendKeyData arrives, the backend's pair is
   recorded on the route and the minted pair is written into the copy that
   goes to the client.
3. ReadyForQuery ends the scan. From that point the connection is
   `upstream.pipe(client)`, exactly as it was before, and query traffic is
   never parsed or rewritten.
4. A CancelRequest arriving on any connection is looked up by its pair.
   `handleCancel` dials the recorded address and sends a CancelRequest
   carrying the **backend's** key.
5. `finish()` removes the entry when the connection ends, whichever of the
   four close or error events fires first.

### Minted, not merely observed

The proxy could have recorded the backend's key and routed on that, leaving
the bytes untouched. It does not, because two containers can each hand out
process id 42, and a 32 bit secret is not enough to make that pair unique
across a box. A cancel would then be ambiguous between two databases, and
resolving it wrongly cancels a stranger's query. Minting makes the key
something this proxy issued and therefore something it can guarantee unique.

### A Map, not Redis

Neon solves the same problem in `proxy/src/cancellation.rs` with Redis, a 60
second initial period, a 10 minute refresh and a 30 second TTL slack. They
need all of it because they run many proxy processes and a cancel can land on
one that never saw the original connection.

We run one daemon on one box (root `CLAUDE.md`), so this is a `Map`, and an
entry lives exactly as long as the connection it describes. Nothing to expire,
nothing to tune, nothing left behind by a connection that ended.

### Cancel never wakes

This falls out of the design rather than being enforced by a check. An entry
only exists while a connection is spliced, and a spliced connection means the
resource is running. A cancel for a sleeping resource finds no entry, and
there was no query to cancel anyway. `handleCancel` calls neither
`deps.resolve` nor `deps.wake`, which
`packages/proxy/test/proxy.test.ts` asserts directly.

### Degrading rather than breaking

Two paths give up instead of failing:

- A message `scanBackendStartup` cannot frame (a length below 4, or above
  `MAX_BACKEND_STARTUP_MESSAGE`) stops the scan and forwards the bytes
  untouched. Losing cancel routing on one connection is small. Killing a
  working database connection over an unexpected message is not.
- `CancelRegistry.add` returns null if it cannot mint a unique key, and that
  connection then behaves exactly as every connection did before this existed.
  Unreachable with real randomness; it exists so a degenerate mint cannot spin.

## Verification

Unit and integration tests: 15 added, 300 passing.
`packages/proxy/test/cancel.test.ts` covers the registry,
`startup.test.ts` covers the scanner against hand-built wire bytes, and
`proxy.test.ts` covers the routed path, the closed-connection path, and that
post-startup traffic shaped like BackendKeyData is forwarded verbatim.

Against a real Postgres 18.4 (`postgres:18-alpine`) with a real `psql`, on a
Mac17,9 running Darwin 25.3.0 arm64, Docker 29.7.1, the proxy in front of a
container on loopback:

| Build | `select pg_sleep(30)`, SIGINT at 3s | psql output |
|---|---|---|
| `main`, before this change | returned at **31s** | `Cancel request sent`, then nothing |
| this change | returned at **3s** | `Cancel request sent`, then `ERROR: canceling statement due to user request` |

The error text comes from the backend, which is what proves the cancel was
delivered rather than the client giving up. SCRAM authentication negotiated
end to end through the rewritten startup phase in both runs, which is the
property the rewrite most risked breaking.

## What this does not do

- **No rate limiting.** Finding 2 of the same research note is still open, and
  is about the wake path rather than this one. An unauthenticated CancelRequest
  now causes a dial where it previously caused nothing, which is a smaller
  surface than a wake but not zero: a lookup miss costs a `Map` read.
- **No survival across a daemon restart.** The registry is in memory. A restart
  drops every spliced connection anyway, so there is nothing to survive.
- **Nothing for a direct connection.** A client that connects to a container's
  published port rather than through the proxy gets the backend's own key and
  cancels normally, without this code being involved.

## Open questions

- Should a cancel for an unknown key be rate limited by source address? It is
  the one unauthenticated packet that reaches this proxy and causes a lookup.
  The answer probably depends on the same undecided fact as Finding 2: whether
  the proxy port is expected to be internet-facing.
- TLS termination is still not built, and a cancel arriving inside a TLS
  session would be unreadable for the same reason a startup packet is. This
  change assumes the plaintext path that `docs/proxy/CLAUDE.md` documents.
