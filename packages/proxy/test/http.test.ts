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
import type { AddressInfo } from 'node:net'
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
