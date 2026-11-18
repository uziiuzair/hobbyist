// Reconcile's cleanup after a rolling app deploy the previous daemon did not
// finish (rollOver and removeStrayAppContainer, packages/app/src/app.ts). A
// daemon that died during the drain leaves the old container running under
// the alternate name with no config pointing at it; reconcile removes it and
// must never touch the container the config records.

import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createFakeRuntime, resolvePaths, type AppConfig, type HobbyConfig } from '@hobby.sh/core'
import { createDaemonContext, reconcile } from '../src/index.js'

function testConfig(): HobbyConfig {
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
    wakeTimeoutMs: 150,
    readinessPollMs: 20,
    queuePort: 0,
    caddyEnabled: false,
    caddyAdminPort: 2019,
    caddyStudioHost: null,
    project: null,
  }
}

async function setup(recordedName: string, containers: string[]) {
  const runtime = createFakeRuntime()
  const paths = resolvePaths({ HOBBY_HOME: mkdtempSync(join(tmpdir(), 'hobby-reconcile-stray-')) })
  const ctx = createDaemonContext({ paths, config: testConfig(), runtime })
  const project = ctx.store.createProject({ name: 'blog', sleepAfterSeconds: 300 })
  const config: AppConfig = {
    image: 'hobby/blog-web:2',
    containerName: recordedName,
    hostPort: 25999,
    containerPort: 3000,
    hostname: 'web.blog.localhost',
    source: null,
    env: {},
    databaseResourceId: null,
  }
  const resource = ctx.store.createResource({ projectId: project.id, kind: 'app', name: 'web', config })
  ctx.store.setResourceState(resource.id, 'running')
  for (const name of containers) {
    await runtime.ensureCreated({ name, image: 'hobby/blog-web:x', env: {}, ports: [], binds: [], network: project.networkName })
    await runtime.start(name)
  }
  return { ctx, runtime }
}

test('reconcile removes the old container a deploy left mid-drain, and keeps the recorded one', async () => {
  // The switch had happened: the config names _b, the plain one is the old.
  const { ctx, runtime } = await setup('hobby-blog-web_b', ['hobby-blog-web', 'hobby-blog-web_b'])
  await reconcile(ctx, { probeBudgetMs: 0 })
  assert.equal((await runtime.inspect('hobby-blog-web')).exists, false)
  assert.equal((await runtime.inspect('hobby-blog-web_b')).running, true)
  ctx.store.close()
})

test('reconcile removes an unrouted new container a deploy left before its switch', async () => {
  // The switch had not happened: the config still names the plain one.
  const { ctx, runtime } = await setup('hobby-blog-web', ['hobby-blog-web', 'hobby-blog-web_b'])
  await reconcile(ctx, { probeBudgetMs: 0 })
  assert.equal((await runtime.inspect('hobby-blog-web_b')).exists, false)
  assert.equal((await runtime.inspect('hobby-blog-web')).running, true)
  ctx.store.close()
})

test('reconcile with no leftover touches nothing', async () => {
  const { ctx, runtime } = await setup('hobby-blog-web_b', ['hobby-blog-web_b'])
  await reconcile(ctx, { probeBudgetMs: 0 })
  assert.equal((await runtime.inspect('hobby-blog-web_b')).running, true)
  assert.equal(runtime._state.size, 1)
  ctx.store.close()
})
