// Two in-memory Duplex streams wired back to back: what one side writes, the
// other side reads. This is how the serverless endpoints (serverless.ts) hand
// a connection to the proxy's own connection handler without a TCP hop: one
// side goes to handleConnectionInner in proxy.ts exactly as an accepted
// socket would, the other side is what the WebSocket bridge or the /sql
// handler's `pg` client talks to. So a WebSocket session or an HTTP query
// is routed, woken, cancel-tracked and counted as activity by the very code
// a TCP connection is, with no second implementation of any of it.
//
// Hand-written rather than node:stream's duplexPair because the close
// semantics have to be exactly these under both runtimes (ADR 0006): ending
// one side ends the other's readable side, and destroying either side
// destroys both, so the proxy's `finish()` on one end tears the whole pair
// down the way it tears down a TCP pair.

import { Duplex } from 'node:stream'

export class PairSide extends Duplex {
  other: PairSide | null = null
  // Read by proxy.ts only when a certificate is configured and only for an
  // accepted socket; an in-process pair is never asked, but the property
  // keeps the shape of a socket for anything that logs it.
  readonly remoteAddress: string | undefined = undefined
  private pendingWrite: (() => void) | null = null

  constructor() {
    // allowHalfOpen: a pair side whose peer finished writing can still write
    // back, as a TCP socket can. The proxy relies on 'close', which arrives
    // once both directions are done (autoDestroy) or on destroy.
    super({ allowHalfOpen: true })
  }

  override _read(): void {
    // The peer was holding a write until this side drained; let it go on.
    const peer = this.other
    if (peer?.pendingWrite) {
      const release = peer.pendingWrite
      peer.pendingWrite = null
      release()
    }
  }

  override _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    const peer = this.other
    if (peer === null || peer.destroyed) {
      callback(new Error('the other side of this in-memory connection is closed'))
      return
    }
    if (peer.push(chunk)) {
      callback()
    } else {
      this.pendingWrite = () => callback()
    }
  }

  override _final(callback: (error?: Error | null) => void): void {
    const peer = this.other
    if (peer !== null && !peer.destroyed) peer.push(null)
    callback()
  }

  override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    const peer = this.other
    if (this.pendingWrite) {
      this.pendingWrite = null
    }
    if (peer !== null && !peer.destroyed) {
      // The peer's readable side ends cleanly, then it is destroyed too, so
      // whoever reads it sees 'end' and then 'close', as with a TCP reset
      // seen from the other side of a proxy.
      peer.push(null)
      peer.destroy()
    }
    callback(error)
  }

  // The socket methods node-postgres calls on its stream (pg's
  // lib/connection.js: connect, setNoDelay, setKeepAlive, ref, unref). On a
  // pair there is nothing to dial; `connect` only announces that the
  // connection is up, on the next tick, as a socket would.
  connect(): this {
    process.nextTick(() => this.emit('connect'))
    return this
  }
  setNoDelay(): this {
    return this
  }
  setKeepAlive(): this {
    return this
  }
  ref(): this {
    return this
  }
  unref(): this {
    return this
  }
}

export function socketPair(): [PairSide, PairSide] {
  const a = new PairSide()
  const b = new PairSide()
  a.other = b
  b.other = a
  return [a, b]
}
