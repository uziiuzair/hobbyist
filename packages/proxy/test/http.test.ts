// The HTTP wake router, against real sockets and a fake world. Every test
// here starts a real node:http upstream on a real loopback port, so the
// proxying is genuine; what is faked is the only thing that would need
// Docker, namely resolve and wake.
//
// The wake assertions are the ones that matter. "The request waited and then
// succeeded" is the entire product, and "the request got an error while the
// container was starting" is the failure this component exists to prevent.

import assert from 'node:assert/strict'
import { createServer, get as httpGet, type Server } from 'node:http'
import net, { type AddressInfo } from 'node:net'
import { test } from 'node:test'
import { ActivityTracker } from '../src/activity.js'
import { hostnameFrom, startHttpRouter, TLS_ASK_PATH, type HttpProxyDeps, type HttpTarget } from '../src/http.js'

function listenOn(server: Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve((server.address() as AddressInfo).port)
    })
  })
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.closeAllConnections?.()
    server.close(() => resolve())
  })
}

interface Fetched {
  status: number
  body: string
  headers: Record<string, string | string[] | undefined>
}

function fetchThrough(port: number, host: string, path = '/'): Promise<Fetched> {
  return new Promise((resolve, reject) => {
    const req = httpGet({ host: '127.0.0.1', port, path, headers: { host } }, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (chunk: string) => {
        body += chunk
      })
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }))
    })
    req.on('error', reject)
  })
}

// An upstream that only starts listening when the fake wake is called, which
// is the actual shape of the thing under test: before the wake there is
// nothing on that port at all.
function sleepingUpstream(respondWith: string): {
  deps: (activity: ActivityTracker) => HttpProxyDeps
  wakeCalls: () => number
  close(): Promise<void>
} {
  let server: Server | null = null
  let port = 0
  let wakes = 0
  let state = 'sleeping'

  return {
    deps(activity: ActivityTracker): HttpProxyDeps {
      return {
        async resolve(hostname: string): Promise<HttpTarget | null> {
          if (hostname !== 'web.blog.localhost') return null
          return { resourceId: 'r1', host: '127.0.0.1', port, state }
        },
        async wake(): Promise<void> {
          wakes++
          server = createServer((_req, res) => {
            res.writeHead(200, { 'content-type': 'text/plain' })
            res.end(respondWith)
          })
          port = await listenOn(server)
          state = 'running'
        },
        activity,
      }
    },
    wakeCalls: () => wakes,
    async close(): Promise<void> {
      if (server !== null) await closeServer(server)
    },
  }
}

test('hostnameFrom strips the port, lowercases, and handles bracketed IPv6', () => {
  assert.equal(hostnameFrom('Web.Blog.localhost:8443'), 'web.blog.localhost')
  assert.equal(hostnameFrom('web.blog.localhost'), 'web.blog.localhost')
  assert.equal(hostnameFrom('[::1]:8443'), '[::1]')
  assert.equal(hostnameFrom('[::1]'), '[::1]')
  assert.equal(hostnameFrom(undefined), null)
  assert.equal(hostnameFrom(''), null)
})

// The whole product in one test: a request to a sleeping app waits and is
// then served, rather than getting a connection error.
test('a request to a sleeping resource wakes it and is served, not refused', async () => {
  const upstream = sleepingUpstream('hello from the app')
  const activity = new ActivityTracker()
  const router = await startHttpRouter(upstream.deps(activity), { port: 0 })
  try {
    const res = await fetchThrough(router.port, 'web.blog.localhost')
    assert.equal(res.status, 200)
    assert.equal(res.body, 'hello from the app')
    assert.equal(upstream.wakeCalls(), 1)
  } finally {
    await router.close()
    await upstream.close()
  }
})

test('an already-running resource is served with no wake at all', async () => {
  const server = createServer((_req, res) => {
    res.writeHead(200)
    res.end('already up')
  })
  const port = await listenOn(server)
  const activity = new ActivityTracker()
  let wakes = 0
  const router = await startHttpRouter(
    {
      async resolve(): Promise<HttpTarget> {
        return { resourceId: 'r1', host: '127.0.0.1', port, state: 'running' }
      },
      async wake(): Promise<void> {
        wakes++
      },
      activity,
    },
    { port: 0 }
  )
  try {
    const res = await fetchThrough(router.port, 'web.blog.localhost')
    assert.equal(res.body, 'already up')
    assert.equal(wakes, 0, 'a running resource must not pay for a wake')
  } finally {
    await router.close()
    await closeServer(server)
  }
})

test('an unknown hostname is a 404 that names the hostname, not a 500', async () => {
  const activity = new ActivityTracker()
  const router = await startHttpRouter(
    {
      async resolve(): Promise<null> {
        return null
      },
      async wake(): Promise<void> {},
      activity,
    },
    { port: 0 }
  )
  try {
    const res = await fetchThrough(router.port, 'nope.blog.localhost')
    assert.equal(res.status, 404)
    assert.match(res.body, /nothing is deployed at nope\.blog\.localhost/)
  } finally {
    await router.close()
  }
})

// A resolve that throws is a refusal with a reason (a released project is
// the case that exists today), and it must not read as "you never deployed
// this".
test('a resolve that throws is a 503 carrying the reason', async () => {
  const activity = new ActivityTracker()
  const router = await startHttpRouter(
    {
      async resolve(): Promise<never> {
        throw new Error('project blog was released and is no longer managed by hobby')
      },
      async wake(): Promise<void> {},
      activity,
    },
    { port: 0 }
  )
  try {
    const res = await fetchThrough(router.port, 'web.blog.localhost')
    assert.equal(res.status, 503)
    assert.match(res.body, /was released/)
  } finally {
    await router.close()
  }
})

test('a wake that never finishes becomes a 504 rather than hanging forever', async () => {
  const activity = new ActivityTracker()
  const router = await startHttpRouter(
    {
      async resolve(): Promise<HttpTarget> {
        return { resourceId: 'r1', host: '127.0.0.1', port: 1, state: 'sleeping' }
      },
      wake(): Promise<void> {
        return new Promise(() => {})
      },
      activity,
    },
    { port: 0, wakeTimeoutMs: 50 }
  )
  try {
    const res = await fetchThrough(router.port, 'web.blog.localhost')
    assert.equal(res.status, 504)
    assert.match(res.body, /did not wake up in time/)
  } finally {
    await router.close()
  }
})

// Issue #10. A resource whose wake already failed used to be woken again by
// every request, a fresh container start per request for something that
// just failed to start. It is now answered at once, and the wake is never
// called.
test('a refused resource is a 503 naming the way out, with no wake', async () => {
  const activity = new ActivityTracker()
  let wakes = 0
  const router = await startHttpRouter(
    {
      async resolve(): Promise<HttpTarget> {
        return { resourceId: 'r1', host: '127.0.0.1', port: 1, state: 'failed' }
      },
      async wake(): Promise<void> {
        wakes++
      },
      isWakeRefused: (resourceId) => resourceId === 'r1',
      activity,
    },
    { port: 0, wakeTimeoutMs: 30_000 }
  )
  try {
    const res = await fetchThrough(router.port, 'web.blog.localhost')
    assert.equal(res.status, 503)
    assert.match(res.body, /last wake failed/)
    assert.match(res.body, /hobby wake/)
    assert.equal(wakes, 0)
    assert.equal(activity.count('r1'), 0)
  } finally {
    await router.close()
  }
})

// And the label alone refuses nothing: reconcile writes `failed` for a
// container that merely stopped, and that app must still wake on a request.
test('a failed resource that is not refused is woken and served', async () => {
  const activity = new ActivityTracker()
  const upstream = sleepingUpstream('woken from failed')
  const base = upstream.deps(activity)
  let first = true
  const router = await startHttpRouter(
    {
      ...base,
      async resolve(hostname: string): Promise<HttpTarget | null> {
        const target = await base.resolve(hostname)
        if (target !== null && first) {
          first = false
          return { ...target, state: 'failed' }
        }
        return target
      },
      isWakeRefused: () => false,
    },
    { port: 0 }
  )
  try {
    const res = await fetchThrough(router.port, 'web.blog.localhost')
    assert.equal(res.status, 200)
    assert.equal(res.body, 'woken from failed')
    assert.equal(upstream.wakeCalls(), 1)
  } finally {
    await router.close()
    await upstream.close()
  }
})

// A resource the store calls running, with nothing actually listening. The
// user should be told the app answered badly, not that it does not exist.
test('a running resource with a dead upstream is a 502, not a 404', async () => {
  const dead = createServer()
  const port = await listenOn(dead)
  await closeServer(dead)

  const activity = new ActivityTracker()
  const router = await startHttpRouter(
    {
      async resolve(): Promise<HttpTarget> {
        return { resourceId: 'r1', host: '127.0.0.1', port, state: 'running' }
      },
      async wake(): Promise<void> {},
      activity,
    },
    { port: 0 }
  )
  try {
    const res = await fetchThrough(router.port, 'web.blog.localhost')
    assert.equal(res.status, 502)
    assert.match(res.body, /is running but did not answer/)
  } finally {
    await router.close()
  }
})

// Activity accounting is what hibernation reads. A handle that is opened and
// never closed means a resource that never goes idle and therefore never
// sleeps again, which is the wedge failing silently rather than loudly.
test('a served request leaves no activity handle behind', async () => {
  const server = createServer((_req, res) => {
    res.writeHead(200)
    res.end('ok')
  })
  const port = await listenOn(server)
  const activity = new ActivityTracker()
  const router = await startHttpRouter(
    {
      async resolve(): Promise<HttpTarget> {
        return { resourceId: 'r1', host: '127.0.0.1', port, state: 'running' }
      },
      async wake(): Promise<void> {},
      activity,
    },
    { port: 0 }
  )
  try {
    await fetchThrough(router.port, 'web.blog.localhost')
    // The response has ended, so the connection count is back to zero and an
    // idle clock exists to measure from.
    assert.equal(activity.count('r1'), 0)
    assert.notEqual(activity.idleSeconds('r1'), null)
  } finally {
    await router.close()
    await closeServer(server)
  }
})

// Hop-by-hop headers are per-connection and forwarding them produces
// malformed messages downstream.
test('hop-by-hop headers are not forwarded to the upstream', async () => {
  let seen: Record<string, unknown> = {}
  const server = createServer((req, res) => {
    seen = { ...req.headers }
    res.writeHead(200)
    res.end('ok')
  })
  const port = await listenOn(server)
  const activity = new ActivityTracker()
  const router = await startHttpRouter(
    {
      async resolve(): Promise<HttpTarget> {
        return { resourceId: 'r1', host: '127.0.0.1', port, state: 'running' }
      },
      async wake(): Promise<void> {},
      activity,
    },
    { port: 0 }
  )
  try {
    await new Promise<void>((resolve, reject) => {
      const req = httpGet(
        {
          host: '127.0.0.1',
          port: router.port,
          path: '/',
          headers: { host: 'web.blog.localhost', 'proxy-authorization': 'Basic nope', 'x-keep': 'yes' },
        },
        (res) => {
          res.resume()
          res.on('end', () => resolve())
        }
      )
      req.on('error', reject)
    })
    assert.equal(seen['proxy-authorization'], undefined)
    assert.equal(seen['x-keep'], 'yes', 'ordinary headers must still reach the app')
  } finally {
    await router.close()
    await closeServer(server)
  }
})

// Caddy's on-demand TLS ask endpoint. It is the one unauthenticated surface
// a stranger can reach on purpose, so it answers one bit, wakes nothing, and
// fails closed.
test('the tls ask endpoint answers yes only for a hostname this box serves', async () => {
  const activity = new ActivityTracker()
  let wakes = 0
  const router = await startHttpRouter(
    {
      async resolve(): Promise<null> {
        return null
      },
      async wake(): Promise<void> {
        wakes++
      },
      async allowHostname(hostname: string): Promise<boolean> {
        return hostname === 'web.blog.example.com'
      },
      activity,
    },
    { port: 0 }
  )
  try {
    const yes = await fetchThrough(router.port, '127.0.0.1', `${TLS_ASK_PATH}?domain=web.blog.example.com`)
    assert.equal(yes.status, 200)

    const no = await fetchThrough(router.port, '127.0.0.1', `${TLS_ASK_PATH}?domain=someone-elses.example.com`)
    assert.equal(no.status, 404)

    assert.equal(wakes, 0, 'the ask endpoint must never wake anything')
  } finally {
    await router.close()
  }
})

test('the tls ask path is not reachable under an app hostname', async () => {
  const server = createServer((req, res) => {
    res.writeHead(200)
    res.end(`app saw ${req.url}`)
  })
  const port = await listenOn(server)
  const activity = new ActivityTracker()
  const router = await startHttpRouter(
    {
      async resolve(): Promise<HttpTarget> {
        return { resourceId: 'r1', host: '127.0.0.1', port, state: 'running' }
      },
      async wake(): Promise<void> {},
      async allowHostname(): Promise<boolean> {
        return true
      },
      activity,
    },
    { port: 0 }
  )
  try {
    // The reserved path must belong to the app, not to us, whenever the
    // request arrives under an app's own hostname.
    const res = await fetchThrough(router.port, 'web.blog.localhost', `${TLS_ASK_PATH}?domain=anything`)
    assert.match(res.body, /^app saw /)
  } finally {
    await router.close()
    await closeServer(server)
  }
})

test('the ask endpoint fails closed when the lookup throws', async () => {
  const activity = new ActivityTracker()
  const router = await startHttpRouter(
    {
      async resolve(): Promise<null> {
        return null
      },
      async wake(): Promise<void> {},
      async allowHostname(): Promise<never> {
        throw new Error('store unavailable')
      },
      activity,
    },
    { port: 0 }
  )
  try {
    const res = await fetchThrough(router.port, '127.0.0.1', `${TLS_ASK_PATH}?domain=web.blog.example.com`)
    assert.equal(res.status, 404, 'a lookup failure must not become an open certificate endpoint')
  } finally {
    await router.close()
  }
})

// Issue #67: the upstream socket timeout fired on any quiet stretch of a
// response that had already started, so an SSE stream with sparse events
// was cut after the cap, and the client was left hanging.
test('a response that has started is never cut by the upstream timeout, however long the gaps', async () => {
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write('data: first\n\n')
    setTimeout(() => res.end('data: second\n\n'), 250)
  })
  const port = await listenOn(server)
  const activity = new ActivityTracker()
  const router = await startHttpRouter(
    {
      async resolve(): Promise<HttpTarget> {
        return { resourceId: 'r1', host: '127.0.0.1', port, state: 'running' }
      },
      async wake(): Promise<void> {},
      activity,
    },
    // Far shorter than the gap between the two events.
    { port: 0, upstreamTimeoutMs: 50 }
  )
  try {
    const res = await fetchThrough(router.port, 'web.blog.localhost')
    assert.equal(res.status, 200)
    assert.equal(res.body, 'data: first\n\ndata: second\n\n')
    assert.equal(activity.count('r1'), 0)
  } finally {
    await router.close()
    await closeServer(server)
  }
})

test('the upstream timeout still applies before the headers arrive', async () => {
  const server = createServer(() => {
    // Never answers.
  })
  const port = await listenOn(server)
  const router = await startHttpRouter(
    {
      async resolve(): Promise<HttpTarget> {
        return { resourceId: 'r1', host: '127.0.0.1', port, state: 'running' }
      },
      async wake(): Promise<void> {},
      activity: new ActivityTracker(),
    },
    { port: 0, upstreamTimeoutMs: 50 }
  )
  try {
    const res = await fetchThrough(router.port, 'web.blog.localhost')
    assert.equal(res.status, 502)
    assert.match(res.body, /did not respond within 50ms/)
  } finally {
    await router.close()
    await closeServer(server)
  }
})

// Issue #67, second half: when the upstream dies after the headers were
// forwarded, sendPlain had nothing to do and the client waited for a body
// that was never coming.
test('an upstream that dies mid-body ends the client connection instead of leaving it hanging', async () => {
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' })
    res.write('partial')
    setTimeout(() => res.socket?.destroy(), 20)
  })
  const port = await listenOn(server)
  const router = await startHttpRouter(
    {
      async resolve(): Promise<HttpTarget> {
        return { resourceId: 'r1', host: '127.0.0.1', port, state: 'running' }
      },
      async wake(): Promise<void> {},
      activity: new ActivityTracker(),
    },
    { port: 0 }
  )
  try {
    const outcome = await new Promise<string>((resolve) => {
      const timer = setTimeout(() => resolve('hung'), 2_000)
      const req = httpGet({ host: '127.0.0.1', port: router.port, path: '/', headers: { host: 'web.blog.localhost' } }, (res) => {
        res.on('data', () => {})
        res.on('end', () => {
          clearTimeout(timer)
          resolve(res.complete ? 'complete' : 'cut')
        })
        res.on('error', () => {
          clearTimeout(timer)
          resolve('cut')
        })
        res.on('aborted', () => {
          clearTimeout(timer)
          resolve('cut')
        })
      })
      req.on('error', () => {
        clearTimeout(timer)
        resolve('cut')
      })
    })
    assert.equal(outcome, 'cut')
  } finally {
    await router.close()
    await closeServer(server)
  }
})

// Issue #68: a client that closed its side of a WebSocket left the pair
// half-open when the upgrade handler did not end its own, and the activity
// handle with it, so the app never slept.
function upgradeThrough(port: number, host: string): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1', () => {
      socket.write(`GET /ws HTTP/1.1\r\nHost: ${host}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n`)
    })
    socket.once('data', (chunk: Buffer) => {
      if (chunk.toString('latin1').startsWith('HTTP/1.1 101')) resolve(socket)
      else reject(new Error(`unexpected upgrade answer: ${chunk.toString('latin1').split('\r\n')[0]}`))
    })
    socket.once('error', reject)
  })
}

function waitFor(check: () => boolean, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    const started = Date.now()
    const tick = (): void => {
      if (check()) return resolve(true)
      if (Date.now() - started > ms) return resolve(false)
      setTimeout(tick, 10)
    }
    tick()
  })
}

test('a client that half-closes an upgraded connection releases the activity handle and tears the upstream down', async () => {
  const upstreamSockets: net.Socket[] = []
  const server = createServer()
  server.on('upgrade', (_req, socket) => {
    upstreamSockets.push(socket as net.Socket)
    socket.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n')
    // Deliberately never ends its side when the peer does.
    socket.on('data', () => {})
  })
  const port = await listenOn(server)
  const activity = new ActivityTracker()
  const router = await startHttpRouter(
    {
      async resolve(): Promise<HttpTarget> {
        return { resourceId: 'r1', host: '127.0.0.1', port, state: 'running' }
      },
      async wake(): Promise<void> {},
      activity,
    },
    { port: 0 }
  )
  try {
    const client = await upgradeThrough(router.port, 'web.blog.localhost')
    assert.equal(activity.count('r1'), 1)
    client.end()
    assert.equal(await waitFor(() => activity.count('r1') === 0, 2_000), true, 'activity handle released')
    // The router's side of the upstream connection is gone, which the app
    // sees as its end of the stream. What the app does with that is its
    // business; this upstream deliberately does nothing, which is the shape
    // that used to leak.
    assert.equal(await waitFor(() => upstreamSockets.every((s) => s.readableEnded || s.destroyed), 2_000), true, 'upstream told')
  } finally {
    for (const s of upstreamSockets) s.destroy()
    await router.close()
    await closeServer(server)
  }
})

test('closing the router destroys upgraded sockets it detached, so shutdown does not wait on them', async () => {
  const upstreamSockets: net.Socket[] = []
  const server = createServer()
  server.on('upgrade', (_req, socket) => {
    upstreamSockets.push(socket as net.Socket)
    socket.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n')
    socket.on('data', () => {})
  })
  const port = await listenOn(server)
  const activity = new ActivityTracker()
  const router = await startHttpRouter(
    {
      async resolve(): Promise<HttpTarget> {
        return { resourceId: 'r1', host: '127.0.0.1', port, state: 'running' }
      },
      async wake(): Promise<void> {},
      activity,
    },
    { port: 0 }
  )
  const client = await upgradeThrough(router.port, 'web.blog.localhost')
  client.on('error', () => {})
  const closed = await Promise.race([
    router.close().then(() => 'closed'),
    new Promise<string>((resolve) => setTimeout(() => resolve('hung'), 2_000)),
  ])
  assert.equal(closed, 'closed')
  assert.equal(await waitFor(() => client.destroyed || client.readableEnded, 2_000), true)
  assert.equal(activity.count('r1'), 0)
  client.destroy()
  for (const s of upstreamSockets) s.destroy()
  await closeServer(server)
})

// Issue #54, the HTTP shape: a container that died behind the daemon is
// still `running` in the store, so its refused port was a 502 in
// milliseconds on every request until a human ran `hobby wake`.
test('a running resource whose port refuses the dial is woken once and the request is served', async () => {
  const probe = createServer()
  const port = await listenOn(probe)
  await closeServer(probe)

  let server: Server | null = null
  let wakes = 0
  const activity = new ActivityTracker()
  const router = await startHttpRouter(
    {
      async resolve(): Promise<HttpTarget> {
        return { resourceId: 'r1', host: '127.0.0.1', port, state: 'running' }
      },
      async wake(): Promise<void> {
        wakes++
        server = createServer((_req, res) => {
          res.writeHead(200)
          res.end('back')
        })
        await new Promise<void>((resolve) => server!.listen(port, '127.0.0.1', () => resolve()))
      },
      activity,
    },
    { port: 0 }
  )
  try {
    const res = await fetchThrough(router.port, 'web.blog.localhost')
    assert.equal(res.status, 200)
    assert.equal(res.body, 'back')
    assert.equal(wakes, 1)
    assert.equal(activity.count('r1'), 0)
  } finally {
    await router.close()
    if (server !== null) await closeServer(server)
  }
})

test('a running resource that still refuses after its one restart is a 502, with no second wake', async () => {
  const probe = createServer()
  const port = await listenOn(probe)
  await closeServer(probe)
  let wakes = 0
  const router = await startHttpRouter(
    {
      async resolve(): Promise<HttpTarget> {
        return { resourceId: 'r1', host: '127.0.0.1', port, state: 'running' }
      },
      async wake(): Promise<void> {
        wakes++
      },
      activity: new ActivityTracker(),
    },
    { port: 0 }
  )
  try {
    const res = await fetchThrough(router.port, 'web.blog.localhost')
    assert.equal(res.status, 502)
    assert.equal(wakes, 1)
  } finally {
    await router.close()
  }
})
