// Host port allocation that asks the operating system, not only the store.
//
// Store.allocatePort knows every port a resource row holds and nothing
// else. Issue #60: any other process sitting on the next "free" port made
// every `hobby new` fail the same way, forever, with "address already in
// use", and a port taken while a database slept made its next wake fail
// (#59). The store cannot probe the host itself: it is synchronous SQLite,
// and binding a socket is not. So this wraps it, asks the store for a
// candidate, tries to bind it, and moves on when the bind fails.
//
// The probe binds the loopback literal because that is where every
// container port is published (DEFAULT_PORT_BIND in runtime.ts): a port
// held on 127.0.0.1 is the one docker would fail to publish. Binding and
// releasing is a check, not a reservation. Nothing stops another process
// taking the port in the gap before docker binds it, which is the same
// race the store alone always had, now narrowed from "ever" to "this
// moment".

import net from 'node:net'
import type { Store } from './store.js'

export async function isHostPortFree(port: number, host: string = '127.0.0.1'): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer()
    server.unref()
    server.once('error', () => resolve(false))
    server.listen(port, host, () => {
      server.close(() => resolve(true))
    })
  })
}

export async function allocateHostPort(
  store: Pick<Store, 'allocatePort'>,
  from: number,
  to: number,
  exclude: number[] = [],
  probe: (port: number) => Promise<boolean> = isHostPortFree
): Promise<number> {
  const taken = [...exclude]
  for (;;) {
    // Throws 'conflict' by itself once the range is exhausted, which is the
    // right answer here too: a range in which every port is either stored or
    // held by someone else has no free port.
    const port = store.allocatePort(from, to, taken)
    if (await probe(port)) {
      return port
    }
    taken.push(port)
  }
}
