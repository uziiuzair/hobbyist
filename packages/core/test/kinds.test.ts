// The resource kind registry, tested with no Docker, no Postgres and no
// daemon: every handler here is a stub that records what it was called with.
// That is the point of the interface existing at all, and it is what lets
// `app` and `worker` be added later without any of these tests changing.

import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  createKindRegistry,
  expectKind,
  guardFor,
  HobbyError,
  type ActivityGuardResult,
  type AppResource,
  type KindContext,
  type PostgresResource,
  type Resource,
  type ResourceKindHandler,
} from '../src/index.js'

// A handler that does nothing but remember. Typed against the general
// Resource rather than one kind, because these tests are about dispatch, not
// about any kind's behaviour.
function recordingHandler(kind: Resource['kind']): ResourceKindHandler & { calls: string[] } {
  const calls: string[] = []
  return {
    kind,
    calls,
    async start(_ctx: KindContext, resource: Resource): Promise<void> {
      calls.push(`start:${resource.id}`)
    },
    async stop(_ctx: KindContext, resource: Resource): Promise<void> {
      calls.push(`stop:${resource.id}`)
    },
    async destroy(_ctx: KindContext, resource: Resource): Promise<void> {
      calls.push(`destroy:${resource.id}`)
    },
    async probe(_ctx: KindContext, resource: Resource): Promise<boolean> {
      calls.push(`probe:${resource.id}`)
      return true
    },
  }
}

const CTX = {} as KindContext

function postgresResource(id = 'r-pg'): PostgresResource {
  return {
    id,
    projectId: 'p1',
    kind: 'postgres',
    name: 'primary',
    state: 'running',
    lastActiveAt: null,
    createdAt: new Date(0),
    config: {
      image: 'postgres:18-alpine',
      containerName: 'hobby-blog-primary',
      hostPort: 15432,
      dataDir: '/tmp/pgdata',
      superuser: 'postgres',
      password: 'secret',
      database: 'blog',
    },
  }
}

function appResource(id = 'r-app'): AppResource {
  return {
    id,
    projectId: 'p1',
    kind: 'app',
    name: 'web',
    state: 'sleeping',
    lastActiveAt: null,
    createdAt: new Date(0),
    config: {
      image: 'hobby/blog-web:1',
      containerName: 'hobby-blog-web',
      hostPort: 15500,
      containerPort: 3000,
      hostname: 'web.blog.localhost',
      source: null,
      env: {},
      databaseResourceId: null,
    },
  }
}

test('createKindRegistry keys handlers by their own declared kind', async () => {
  const pg = recordingHandler('postgres')
  const app = recordingHandler('app')
  const registry = createKindRegistry([pg, app])

  await registry.get('postgres').start(CTX, postgresResource())
  await registry.get('app').stop(CTX, appResource())

  assert.deepEqual(pg.calls, ['start:r-pg'])
  assert.deepEqual(app.calls, ['stop:r-app'])
})

// The invariant the whole design rests on: a dispatch site reads
// registry.get(resource.kind), so a handler only ever sees resources of its
// own kind. If registration trusted a caller-supplied key instead of the
// handler's own, that invariant would be one typo away from breaking.
test('a handler is only ever reachable through its own kind', async () => {
  const pg = recordingHandler('postgres')
  const registry = createKindRegistry([pg])

  const app = appResource()
  assert.throws(() => registry.get(app.kind), (err: unknown) => {
    assert.ok(err instanceof HobbyError)
    assert.equal(err.code, 'unknown_kind')
    return true
  })
  assert.deepEqual(pg.calls, [])
})

test('registering two handlers for one kind is a conflict, not a silent overwrite', () => {
  assert.throws(
    () => createKindRegistry([recordingHandler('postgres'), recordingHandler('postgres')]),
    (err: unknown) => {
      assert.ok(err instanceof HobbyError)
      assert.equal(err.code, 'conflict')
      return true
    }
  )
})

test('an unregistered kind throws unknown_kind and names what IS registered', () => {
  const registry = createKindRegistry([recordingHandler('postgres')])
  assert.throws(
    () => registry.get('worker'),
    (err: unknown) => {
      assert.ok(err instanceof HobbyError)
      assert.equal(err.code, 'unknown_kind')
      // The hint is the whole value of this error: "no handler for worker" on
      // its own does not tell an operator whether they are running a build
      // without the worker package or have a corrupt row.
      assert.match(err.hint ?? '', /postgres/)
      return true
    }
  )
})

test('has and kinds report exactly what was registered', () => {
  const registry = createKindRegistry([recordingHandler('postgres'), recordingHandler('app')])
  assert.equal(registry.has('postgres'), true)
  assert.equal(registry.has('app'), true)
  assert.equal(registry.has('worker'), false)
  assert.deepEqual(registry.kinds().sort(), ['app', 'postgres'])
})

// The default that keeps a kind with nothing to interrupt from having to
// write a function that always says so. 'idle' rather than 'unreachable',
// because a handler that declares no guard is stating there is nothing to
// check, not failing to check.
test('guardFor answers idle for a handler that declares no guard', async () => {
  const registry = createKindRegistry([recordingHandler('app')])
  assert.equal(await guardFor(registry, CTX, appResource()), 'idle')
})

test('guardFor delegates to a handler that declares one', async () => {
  const handler: ResourceKindHandler = {
    ...recordingHandler('postgres'),
    async guard(): Promise<ActivityGuardResult> {
      return 'active'
    },
  }
  const registry = createKindRegistry([handler])
  assert.equal(await guardFor(registry, CTX, postgresResource()), 'active')
})

test('expectKind narrows a matching resource and rejects a mismatched one', () => {
  const pg = postgresResource()
  assert.equal(expectKind(pg, 'postgres').config.database, 'blog')

  assert.throws(
    () => expectKind(appResource(), 'postgres'),
    (err: unknown) => {
      assert.ok(err instanceof HobbyError)
      // internal, not usage: every caller has already established which kind
      // it holds, so reaching this is a bug in the daemon rather than a
      // mistake by whoever ran the command.
      assert.equal(err.code, 'internal')
      assert.match(err.message, /is a app, but a postgres was expected/)
      return true
    }
  )
})
