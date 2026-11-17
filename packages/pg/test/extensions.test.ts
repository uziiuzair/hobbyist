// Declared extensions against the fake runtime: createPostgres applies them
// on its first boot (no extra start), refuses and removes the resource when
// the image does not ship one, and a clone carries the declaration with the
// catalog. The real CREATE EXTENSION path is exercised live (see
// docs/engine/CLAUDE.md's 2026-11-17 amendment); CI has no Docker.

import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createFakeRuntime, HobbyError, openStore, resolvePaths, type HobbyConfig, type PostgresConfig } from '@hobby.sh/core'
import {
  createPostgres,
  createPostgresFromClone,
  reportExtensions,
  validateExtensionNames,
  type ExtensionOps,
  type InstalledExtension,
} from '../src/index.js'

function testHobbyConfig(): HobbyConfig {
  return {
    image: 'postgres:18-alpine',
    proxyPort: 5432,
    proxyHost: '127.0.0.1',
    proxyTls: null,
    studioPort: 8443,
    apiPort: 7432,
    httpPort: 7433,
    domain: 'localhost',
    sleepAfterSeconds: 300,
    wakeTimeoutMs: 30000,
    readinessPollMs: 25,
    queuePort: 0,
    caddyEnabled: false,
    caddyAdminPort: 2019,
    caddyStudioHost: null,
    project: null,
  }
}

// A Postgres that ships `shipped` and records what it was asked to create,
// and whether the container was running when it was asked.
function fakeExtensions(shipped: string[], isRunning: () => boolean): ExtensionOps & { applied: string[][]; runningAtApply: boolean[] } {
  const installed: InstalledExtension[] = [{ name: 'plpgsql', version: '1.0' }]
  const ops = {
    applied: [] as string[][],
    runningAtApply: [] as boolean[],
    async apply(config: PostgresConfig, names: string[]): Promise<InstalledExtension[]> {
      ops.applied.push(names)
      ops.runningAtApply.push(isRunning())
      const missing = names.filter((name) => !shipped.includes(name))
      if (missing.length > 0) {
        throw new HobbyError('usage', `the image ${config.image} does not ship the extension ${missing.join(', ')}`)
      }
      for (const name of names) {
        if (!installed.some((ext) => ext.name === name)) installed.push({ name, version: '1.0' })
      }
      return [...installed]
    },
    async list(): Promise<InstalledExtension[]> {
      return [...installed]
    },
  }
  return ops
}

function setup() {
  const store = openStore(':memory:')
  const project = store.createProject({ name: 'blog', sleepAfterSeconds: 300 })
  const runtime = createFakeRuntime()
  const paths = resolvePaths({ HOBBY_HOME: join(tmpdir(), `hobby-pg-ext-test-${randomUUID()}`) })
  let running = false
  const start = runtime.start.bind(runtime)
  const stop = runtime.stop.bind(runtime)
  runtime.start = async (name) => {
    running = true
    await start(name)
  }
  runtime.stop = async (name, opts) => {
    running = false
    await stop(name, opts)
  }
  return { store, project, runtime, paths, isRunning: () => running }
}

test('createPostgres declares extensions and applies them during its one first boot, then sleeps', async () => {
  const { store, project, runtime, paths, isRunning } = setup()
  try {
    const extensions = fakeExtensions(['pg_trgm', 'hstore'], isRunning)
    const resource = await createPostgres(
      { store, runtime, paths, config: testHobbyConfig(), probeFactory: () => async () => true, extensions },
      { project, name: 'primary', extensions: ['pg_trgm', 'hstore'] }
    )
    assert.equal(resource.state, 'sleeping')
    assert.deepEqual(resource.config.extensions, ['pg_trgm', 'hstore'])
    assert.deepEqual(extensions.applied, [['pg_trgm', 'hstore']])
    assert.deepEqual(extensions.runningAtApply, [true])
    assert.equal(isRunning(), false)
  } finally {
    store.close()
  }
})

test('createPostgres with no extensions never calls apply and writes no extensions field', async () => {
  const { store, project, runtime, paths, isRunning } = setup()
  try {
    const extensions = fakeExtensions([], isRunning)
    const resource = await createPostgres(
      { store, runtime, paths, config: testHobbyConfig(), probeFactory: () => async () => true, extensions },
      { project, name: 'primary' }
    )
    assert.equal(extensions.applied.length, 0)
    assert.equal('extensions' in resource.config, false)
  } finally {
    store.close()
  }
})

test('createPostgres with an extension the image does not ship stops, removes the resource and rethrows', async () => {
  const { store, project, runtime, paths, isRunning } = setup()
  try {
    const extensions = fakeExtensions(['pg_trgm'], isRunning)
    const removed: string[] = []
    await assert.rejects(
      createPostgres(
        {
          store,
          runtime,
          paths,
          config: testHobbyConfig(),
          probeFactory: () => async () => true,
          extensions,
          removeDataDir: async (path) => {
            removed.push(path)
          },
        },
        { project, name: 'primary', extensions: ['pg_trgm', 'vector'] }
      ),
      (err: unknown) => err instanceof HobbyError && err.code === 'usage' && /vector/.test(err.message)
    )
    assert.deepEqual(store.listResources(project.id), [])
    assert.equal(removed.length, 1)
    assert.equal((await runtime.inspect('hobby-blog-primary')).exists, false)
    assert.equal(isRunning(), false)
  } finally {
    store.close()
  }
})

test('createPostgresFromClone carries the source declaration, as it carries the catalog', async () => {
  const { store, project, runtime, paths } = setup()
  try {
    const source: PostgresConfig = {
      image: 'postgres:18-alpine',
      containerName: 'hobby-src-primary',
      dataDir: '/x/pgdata',
      hostPort: 15999,
      superuser: 'postgres',
      password: 'secret',
      database: 'src',
      extensions: ['pg_trgm'],
    }
    const clone = await createPostgresFromClone({ store, runtime, paths, config: testHobbyConfig() }, { project, name: 'primary', source })
    assert.deepEqual(clone.config.extensions, ['pg_trgm'])
  } finally {
    store.close()
  }
})

test('validateExtensionNames dedupes, accepts uuid-ossp, and refuses anything that is not a name', () => {
  assert.deepEqual(validateExtensionNames(['pg_trgm', 'uuid-ossp', 'pg_trgm'], 'r'), ['pg_trgm', 'uuid-ossp'])
  for (const bad of ['', 'Vector', 'x; drop table t', 'a"b', 'x'.repeat(64)]) {
    assert.throws(() => validateExtensionNames([bad], 'r'), (err: unknown) => err instanceof HobbyError && err.code === 'usage')
  }
  assert.throws(() => validateExtensionNames('vector', 'r'), HobbyError)
  assert.throws(() => validateExtensionNames([1], 'r'), HobbyError)
})

test('reportExtensions names declared extensions that are not installed, and passes null through', () => {
  assert.deepEqual(reportExtensions(['vector', 'pg_trgm'], [{ name: 'pg_trgm', version: '1.6' }]), {
    declared: ['vector', 'pg_trgm'],
    installed: [{ name: 'pg_trgm', version: '1.6' }],
    missing: ['vector'],
  })
  assert.deepEqual(reportExtensions(['vector'], null), { declared: ['vector'], installed: null, missing: null })
})
