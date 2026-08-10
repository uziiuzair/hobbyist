// Where a cancel goes.
//
// Postgres cancellation is deliberately outside the connection it cancels: a
// client that wants to stop a running query opens a second, separate TCP
// connection, sends a CancelRequest carrying only the (processId, secretKey)
// pair the backend gave it at startup, and the backend closes it without a
// reply. There is no authentication on that second connection, which is why
// the pair is a secret rather than an identifier.
//
// For a proxy that means the cancel arrives with no database name, no user,
// and nothing else to route on. The key is the whole address. So the proxy
// hands the client a key of its own making (see scanBackendStartup, which
// swaps it into BackendKeyData on the way past) and keeps this map from that
// key to the connection it stands for. A cancel then resolves to a real
// upstream and a real backend key.
//
// Neon solves the same problem in proxy/src/cancellation.rs with Redis and a
// set of TTLs, because they run many proxy processes and a cancel can land
// on one that never saw the original connection. We run one daemon on one
// box (root CLAUDE.md), so this is a Map, and an entry lives exactly as long
// as the connection it describes: no expiry to tune, and nothing left behind
// by a connection that ended.
//
// Nothing here wakes anything, and that is a property rather than an
// omission. An entry only exists while a connection is spliced, and a
// spliced connection means the resource is running, so a cancel for a
// sleeping resource finds no entry and there was nothing to cancel anyway.

import { randomBytes } from 'node:crypto'
import type { CancelKey } from './startup.js'

// One live client connection, as much of it as a cancel needs. `backendKey`
// is null between the moment the connection is registered and the moment
// BackendKeyData arrives from the backend, which is a real window: a
// connection that fails authentication never leaves it.
export interface CancelRoute {
  readonly host: string
  readonly port: number
  backendKey: CancelKey | null
}

// What a lookup that succeeded hands back. Separate from CancelRoute so that
// "this cancel can be delivered" is a fact the type carries, rather than a
// null check the caller is trusted to repeat.
export interface ResolvedCancelRoute {
  readonly host: string
  readonly port: number
  readonly backendKey: CancelKey
}

// Unreachable with real randomness, and present so that a degenerate mint
// (a test double returning a constant) cannot spin here forever.
const MINT_ATTEMPTS = 8

export function mintCancelKey(): CancelKey {
  const bytes = randomBytes(8)
  return {
    // Forced positive because a real process id is, and a client that
    // displays or logs this pair should see something plausible. Nothing
    // treats it as a process id: to this proxy it is half of a lookup key.
    processId: (bytes.readInt32BE(0) & 0x7fffffff) || 1,
    secretKey: bytes.readInt32BE(4),
  }
}

function keyOf(key: CancelKey): string {
  return `${key.processId}:${key.secretKey}`
}

export class CancelRegistry {
  private readonly routes = new Map<string, CancelRoute>()

  // mint is injectable for the same reason ActivityTracker's clock is: a
  // test that wants to assert which bytes reached the backend needs to know
  // what the proxy handed the client, and guessing at 64 bits of randomness
  // is not a test.
  constructor(private readonly mint: () => CancelKey = mintCancelKey) {}

  // Registers a connection and returns the key to present to its client, or
  // null if a unique one could not be minted. Null is not a failure the
  // caller has to handle loudly: it means this one connection has no cancel
  // routing, which is exactly the behavior everything had before this
  // existed. The connection itself is unaffected.
  add(route: CancelRoute): CancelKey | null {
    for (let attempt = 0; attempt < MINT_ATTEMPTS; attempt++) {
      const key = this.mint()
      const id = keyOf(key)
      if (!this.routes.has(id)) {
        this.routes.set(id, route)
        return key
      }
    }
    return null
  }

  // Returns the route only once it can actually be used. An entry whose
  // backendKey is still null belongs to a connection that has not finished
  // authenticating, and there is no query to cancel on it yet.
  lookup(key: CancelKey): ResolvedCancelRoute | null {
    const route = this.routes.get(keyOf(key))
    if (route === undefined || route.backendKey === null) {
      return null
    }
    return { host: route.host, port: route.port, backendKey: route.backendKey }
  }

  remove(key: CancelKey): void {
    this.routes.delete(keyOf(key))
  }

  // Live entries. Nothing in the proxy reads this; it is how a test asserts
  // that a closed connection left nothing behind, which is the property that
  // keeps this map bounded by the number of open connections.
  get size(): number {
    return this.routes.size
  }
}
