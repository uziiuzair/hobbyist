// Written but not executed in this task, see task-1-report.md. Each test
// opens its own in-memory database (':memory:', supported directly by
// node:sqlite) so tests do not share state or touch the filesystem.

import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { openStore, type PostgresConfig } from '../src/index.js'

function samplePostgresConfig(hostPort: number): PostgresConfig {
  return {
    image: 'postgres:18-alpine',
    containerName: 'hobby-blog-primary',
    dataDir: '/home/user/.hobby/projects/blog/primary/pgdata',
    hostPort,
    superuser: 'postgres',
    password: 'secret',
    database: 'blog',
  }
}

test('store round-trips a project and a resource', () => {
  const store = openStore(':memory:')
  try {
    const project = store.createProject({ name: 'blog', sleepAfterSeconds: 300 })
    assert.equal(project.name, 'blog')
    assert.equal(project.networkName, 'hobby-blog')
    assert.equal(project.sleepAfterSeconds, 300)
    assert.deepEqual(store.getProject(project.id), project)
    assert.deepEqual(store.getProjectByName('blog'), project)
    assert.deepEqual(store.listProjects(), [project])

    const resource = store.createResource({
      projectId: project.id,
      kind: 'postgres',
      name: 'primary',
      config: samplePostgresConfig(15432),
    })
    assert.equal(resource.state, 'creating')
    assert.equal(resource.lastActiveAt, null)
    assert.deepEqual(store.getResource(resource.id), resource)
    assert.deepEqual(store.getResourceByName(project.id, 'primary'), resource)
    assert.deepEqual(store.listResources(project.id), [resource])

    store.setResourceState(resource.id, 'running')
    assert.equal(store.getResource(resource.id)?.state, 'running')

    const touchedAt = new Date()
    store.touchResource(resource.id, touchedAt)
    assert.equal(
      store.getResource(resource.id)?.lastActiveAt?.toISOString(),
      touchedAt.toISOString()
    )

    const newConfig = samplePostgresConfig(15433)
    store.updateResourceConfig(resource.id, newConfig)
    assert.deepEqual(store.getResource(resource.id)?.config, newConfig)

    store.deleteResource(resource.id)
    assert.equal(store.getResource(resource.id), null)

    store.deleteProject(project.id)
    assert.equal(store.getProject(project.id), null)
  } finally {
    store.close()
  }
})

test('store enforces unique project names', () => {
  const store = openStore(':memory:')
  try {
    store.createProject({ name: 'blog', sleepAfterSeconds: null })
    assert.throws(() => store.createProject({ name: 'blog', sleepAfterSeconds: null }))
  } finally {
    store.close()
  }
})

test('store enforces unique resource names within a project', () => {
  const store = openStore(':memory:')
  try {
    const project = store.createProject({ name: 'blog', sleepAfterSeconds: null })
    store.createResource({
      projectId: project.id,
      kind: 'postgres',
      name: 'primary',
      config: samplePostgresConfig(15432),
    })
    assert.throws(() =>
      store.createResource({
        projectId: project.id,
        kind: 'postgres',
        name: 'primary',
        config: samplePostgresConfig(15433),
      })
    )
  } finally {
    store.close()
  }
})

test('allocatePort skips a taken port', () => {
  const store = openStore(':memory:')
  try {
    const project = store.createProject({ name: 'blog', sleepAfterSeconds: null })
    store.createResource({
      projectId: project.id,
      kind: 'postgres',
      name: 'primary',
      config: samplePostgresConfig(15432),
    })
    assert.equal(store.allocatePort(15432, 15440), 15433)
  } finally {
    store.close()
  }
})

// The one test here that touches the filesystem, because the property under
// test IS a filesystem property. Every resource row's `config` column holds
// that database's superuser password as plaintext JSON, and sqlite creates
// its files 0644 by default, which makes every password on the box readable
// by every local user.
test('openStore restricts the state file, and its WAL sidecars, to the owner', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hobby-store-mode-'))
  const path = join(dir, 'state.db')
  const store = openStore(path)
  try {
    const project = store.createProject({ name: 'blog', sleepAfterSeconds: null })
    store.createResource({
      projectId: project.id,
      kind: 'postgres',
      name: 'primary',
      config: samplePostgresConfig(15432),
    })

    for (const file of [path, `${path}-wal`, `${path}-shm`]) {
      if (!existsSync(file)) continue
      assert.equal(statSync(file).mode & 0o777, 0o600, `${file} must not be readable by other users`)
    }
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
