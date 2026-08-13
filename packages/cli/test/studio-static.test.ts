// Studio's built bundle, served from the loopback TCP listener. Two things
// have to be true at once, and each gets its own tests: the whole bundle
// loads with no session (App.tsx is one chunk, see static.ts's own file
// comment on why that is deliberate rather than a gap), and /v1/ and
// /studio/ stay exactly as gated as routes.test.ts already proves, static
// serving or not. A fixture dist directory stands in for a real
// `npm run build -w @hobby.sh/studio` output; nothing here depends on that
// build having actually run.

import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { createServer, request as httpRequest } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Writable } from 'node:stream'
import { test } from 'node:test'
import { createFakeRuntime, openStore, resolvePaths, type HobbyConfig, type Store } from '@hobby.sh/core'
import { ActivityTracker } from '@hobby.sh/proxy'
import { createDefaultKindRegistry } from '../src/daemon/context.js'
import { createApp, createStudioApp, serveStudioStatic, setOperatorPassword, type DaemonContext } from '../src/index.js'

function testConfig(): HobbyConfig {
  return {
    image: 'postgres:18-alpine',
    proxyPort: 5432,
    studioPort: 8443,
    apiPort: 7432,
    httpPort: 7433,
    domain: 'localhost',
    sleepAfterSeconds: 300,
    wakeTimeoutMs: 150,
    readinessPollMs: 20,
    caddyEnabled: false,
    caddyAdminPort: 2019,
    caddyStudioHost: null,
  }
}

function buildContext(): DaemonContext {
  const store: Store = openStore(':memory:')
  const home = join(tmpdir(), `hobby-studio-static-test-${randomUUID()}`)
  mkdirSync(home, { recursive: true })
  const paths = resolvePaths({ HOBBY_HOME: home })
  return { store, runtime: createFakeRuntime(), paths, config: testConfig(), activity: new ActivityTracker(), kinds: createDefaultKindRegistry() }
}

// A small stand-in for `npm run build -w @hobby.sh/studio`'s real output
// shape: index.html at the root, one hashed asset under assets/. Real Vite
// output looks like this; nothing in static.ts depends on more than that.
function buildFixtureDist(): string {
  const dir = join(tmpdir(), `hobby-studio-dist-fixture-${randomUUID()}`)
  mkdirSync(join(dir, 'assets'), { recursive: true })
  writeFileSync(join(dir, 'index.html'), '<!doctype html><title>Hobbyist Studio</title><div id="root"></div>')
  writeFileSync(join(dir, 'assets', 'app.js'), 'console.log("studio")')
  writeFileSync(join(dir, 'assets', 'app.css'), 'body { margin: 0 }')
  return dir
}

async function withStudioServer(
  ctx: DaemonContext,
  studioDistDir: string,
  fn: (baseUrl: string) => Promise<void>
): Promise<void> {
  const app = createStudioApp(ctx, createApp(ctx), { studioDistDir })
  const server = createServer(app)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const address = server.address() as AddressInfo
  try {
    await fn(`http://127.0.0.1:${address.port}`)
  } finally {
    // See auth.test.ts's withStudioServer for why closeAllConnections() runs
    // before awaiting close(): without it, a lingering keep-alive socket can
    // leave close()'s callback pending forever, and this file's own process
    // never exits even though every test has already reported a result.
    const closed = new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())))
    server.closeAllConnections()
    await closed
    ctx.store.close()
  }
}

interface RawResponse {
  status: number
  headers: Record<string, string | string[] | undefined>
  text: string
}

// Same reasoning as routes.test.ts's own rawCall: fetch() normalizes the URL
// before a byte reaches the wire, which is exactly what a path-traversal
// attempt must not be allowed to rely on either succeeding or failing
// because of. node:http's `path` option is passed through verbatim.
function rawCall(baseUrl: string, method: string, path: string): Promise<RawResponse> {
  const url = new URL(baseUrl)
  return new Promise((resolve, reject) => {
    const req = httpRequest({ hostname: url.hostname, port: url.port, method, path }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => chunks.push(chunk))
      res.on('end', () => {
        resolve({ status: res.statusCode ?? 0, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') })
      })
    })
    req.on('error', reject)
    req.end()
  })
}

// --- the whole bundle loads unauthenticated ---------------------------

test('GET / serves index.html with no session, because it is the only way the login screen can ever render', async () => {
  const distDir = buildFixtureDist()
  await withStudioServer(buildContext(), distDir, async (baseUrl) => {
    const res = await rawCall(baseUrl, 'GET', '/')
    assert.equal(res.status, 200)
    assert.match(res.text, /Hobbyist Studio/)
    assert.match(String(res.headers['content-type']), /text\/html/)
  })
})

test('GET /assets/app.js serves the real built asset with no session and the right content type', async () => {
  const distDir = buildFixtureDist()
  await withStudioServer(buildContext(), distDir, async (baseUrl) => {
    const res = await rawCall(baseUrl, 'GET', '/assets/app.js')
    assert.equal(res.status, 200)
    assert.equal(res.text, 'console.log("studio")')
    assert.match(String(res.headers['content-type']), /javascript/)
  })
})

test('GET /assets/app.css serves the real built asset with no session and the right content type', async () => {
  const distDir = buildFixtureDist()
  await withStudioServer(buildContext(), distDir, async (baseUrl) => {
    const res = await rawCall(baseUrl, 'GET', '/assets/app.css')
    assert.equal(res.status, 200)
    assert.equal(res.text, 'body { margin: 0 }')
    assert.match(String(res.headers['content-type']), /css/)
  })
})

test('an unrecognized path falls back to index.html (SPA fallback), unauthenticated, so a reload on a hash route works', async () => {
  const distDir = buildFixtureDist()
  await withStudioServer(buildContext(), distDir, async (baseUrl) => {
    const res = await rawCall(baseUrl, 'GET', '/projects/blog/resources/primary/sql')
    assert.equal(res.status, 200)
    assert.match(res.text, /Hobbyist Studio/)
  })
})

// --- the static route stays out of /v1/ and /studio/'s way -------------

test('GET /v1/projects on the studio-fronted listener is still gated even with static serving wired in', async () => {
  const ctx = buildContext()
  await setOperatorPassword(ctx.paths, 'correct horse battery staple')
  const distDir = buildFixtureDist()

  await withStudioServer(ctx, distDir, async (baseUrl) => {
    const res = await rawCall(baseUrl, 'GET', '/v1/projects')
    assert.equal(res.status, 401)
    // And it must not have been served as the static SPA fallback either:
    // an authentic 401 error envelope, never the HTML shell.
    assert.doesNotMatch(res.text, /Hobbyist Studio/)
  })
})

test('POST /studio/login is still handled by the real login route, never by static serving', async () => {
  const ctx = buildContext()
  await setOperatorPassword(ctx.paths, 'correct horse battery staple')
  const distDir = buildFixtureDist()

  await withStudioServer(ctx, distDir, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/studio/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'correct horse battery staple' }),
    })
    assert.equal(res.status, 200)
    assert.ok(res.headers.get('set-cookie')?.startsWith('hobby_studio_session='))
  })
})

test('a v1-shaped path with no real route stays gated rather than falling back to static content', async () => {
  const distDir = buildFixtureDist()
  await withStudioServer(buildContext(), distDir, async (baseUrl) => {
    const res = await rawCall(baseUrl, 'GET', '/v1/not-a-real-route')
    assert.equal(res.status, 401)
  })
})

// --- path traversal cannot escape dist ----------------------------------

test('serveStudioStatic cannot escape distRoot even when a segment decodes to "../"', async () => {
  // Exercises the defense directly, bypassing the URL layer entirely: real
  // requests never reach this function with a literal ".." segment (WHATWG
  // URL parsing already removes those, both literal and %2e-encoded, see
  // routes.ts's pathSegments comment), but a single segment whose percent
  // decoding produces "a/../b" is not itself a dot-segment and survives URL
  // parsing untouched. This is the case that only a check on the resolved
  // output, not the input, can catch.
  const distDir = buildFixtureDist()
  const outsideDir = join(tmpdir(), `hobby-studio-outside-${randomUUID()}`)
  mkdirSync(outsideDir, { recursive: true })
  writeFileSync(join(outsideDir, 'secret.txt'), 'do not serve this')

  const fakeReq = { method: 'GET' } as unknown as Parameters<typeof serveStudioStatic>[0]

  // sendFile (static.ts) pipes a real fs.createReadStream into `res`, so the
  // fake here has to be an actual Writable, not just an object with
  // writeHead/end methods: .pipe() calls .on(), .once() and .emit() on its
  // destination internally, none of which a plain object provides. A small
  // Writable subclass gets that machinery for free and only has to add the
  // one method (writeHead) that a real ServerResponse has and Writable does
  // not.
  class FakeResponse extends Writable {
    status = 0
    headers: Record<string, string> = {}
    chunks: Buffer[] = []

    override _write(chunk: Buffer, _encoding: string, callback: (err?: Error | null) => void): void {
      this.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
      callback()
    }

    writeHead(status: number, headers?: Record<string, string>): void {
      this.status = status
      this.headers = headers ?? {}
    }
  }

  const fakeRes = new FakeResponse()

  // A single raw segment (as split() would produce it from a URL that never
  // actually reaches here, since WHATWG URL parsing already blocks the
  // simpler forms) whose decodeURIComponent output is "../../<outsideDir>/secret.txt".
  const traversalSegment = encodeURIComponent(`../../${outsideDir}/secret.txt`)
  const handled = serveStudioStatic(
    fakeReq,
    fakeRes as unknown as Parameters<typeof serveStudioStatic>[1],
    [traversalSegment],
    distDir
  )

  assert.equal(handled, true)

  await new Promise<void>((resolve) => {
    fakeRes.on('finish', resolve)
    fakeRes.on('close', resolve)
  })

  const sentStatus = fakeRes.status
  const headers = fakeRes.headers
  const sentBody = Buffer.concat(fakeRes.chunks).toString('utf8')
  // Never the secret content, whatever was served instead (the SPA fallback
  // or, if index.html happens to be missing, a 404).
  assert.doesNotMatch(sentBody, /do not serve this/)
  assert.ok(sentStatus === 200 || sentStatus === 404)
  if (sentStatus === 200) {
    assert.match(sentBody, /Hobbyist Studio/)
    assert.match(headers['content-type'] ?? '', /text\/html/)
  }
})

test('a raw HTTP request for a percent-encoded traversal segment never returns content from outside dist', async () => {
  const distDir = buildFixtureDist()
  const outsideDir = join(tmpdir(), `hobby-studio-outside-http-${randomUUID()}`)
  mkdirSync(outsideDir, { recursive: true })
  writeFileSync(join(outsideDir, 'secret.txt'), 'do not serve this either')

  await withStudioServer(buildContext(), distDir, async (baseUrl) => {
    const encodedOutside = encodeURIComponent(`../../${outsideDir}/secret.txt`)
    const res = await rawCall(baseUrl, 'GET', `/${encodedOutside}`)
    assert.notEqual(res.status, 500)
    assert.doesNotMatch(res.text, /do not serve this either/)
  })
})

test('index.html itself cannot be traversed to from a nested-looking path either', async () => {
  const distDir = buildFixtureDist()
  await withStudioServer(buildContext(), distDir, async (baseUrl) => {
    // A deep, made-up path with no matching file: still the SPA fallback,
    // still 200, still only ever index.html's own real content.
    const res = await rawCall(baseUrl, 'GET', '/a/b/c/d/e/f/g')
    assert.equal(res.status, 200)
    assert.match(res.text, /Hobbyist Studio/)
  })
})
