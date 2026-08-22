// Written but not executed in this task, see task-3-report.md.

import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { PostgresConfig, PostgresResource, Project } from '@hobby.sh/core'
import { connectionString } from '../src/index.js'

function sampleProject(): Project {
  return {
    id: 'project-1',
    name: 'blog',
    networkName: 'hobby-blog',
    sleepAfterSeconds: 300,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    releasedAt: null,
  }
}

function sampleConfig(): PostgresConfig {
  return {
    image: 'postgres:18-alpine',
    containerName: 'hobby-blog-primary',
    dataDir: '/home/user/.hobby/projects/blog/primary/pgdata',
    hostPort: 15432,
    superuser: 'postgres',
    password: 'abc123',
    database: 'blog',
  }
}

function sampleResource(): PostgresResource {
  return {
    id: 'resource-1',
    projectId: 'project-1',
    kind: 'postgres',
    name: 'primary',
    state: 'sleeping',
    config: sampleConfig(),
    lastActiveAt: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
  }
}

test('connectionString renders the proxy port for viaProxy: true', () => {
  const result = connectionString(sampleProject(), sampleResource(), {
    host: 'db.example.com',
    proxyPort: 5432,
    viaProxy: true,
  })
  assert.equal(result, 'postgres://postgres:abc123@db.example.com:5432/blog')
})

test('connectionString renders the resource host port for viaProxy: false', () => {
  const result = connectionString(sampleProject(), sampleResource(), {
    host: '127.0.0.1',
    proxyPort: 5432,
    viaProxy: false,
  })
  // hostPort (15432) is rendered, not the supplied proxyPort (5432): the
  // caller no longer picks which port shows up, viaProxy does.
  assert.equal(result, 'postgres://postgres:abc123@127.0.0.1:15432/blog')
})

test('connectionString renders a different port for each viaProxy value given the same opts.proxyPort', () => {
  const project = sampleProject()
  const resource = sampleResource()
  const opts = { host: 'db.example.com', proxyPort: 5432,
  proxyHost: '127.0.0.1', viaProxy: true }

  const proxied = connectionString(project, resource, opts)
  const direct = connectionString(project, resource, { ...opts, viaProxy: false })

  assert.equal(proxied, 'postgres://postgres:abc123@db.example.com:5432/blog')
  assert.equal(direct, `postgres://postgres:abc123@db.example.com:${resource.config.hostPort}/blog`)
  assert.notEqual(proxied, direct)
})

test('connectionString URL-encodes superuser and password', () => {
  const project = sampleProject()
  const resource = sampleResource()
  resource.config = { ...resource.config, superuser: 'a b', password: 'p@ss/word' }

  const result = connectionString(project, resource, {
    host: '127.0.0.1',
    proxyPort: 5432,
    viaProxy: false,
  })
  assert.equal(result, 'postgres://a%20b:p%40ss%2Fword@127.0.0.1:15432/blog')
})

test('connectionString renders the database from resource.config.database', () => {
  const project = sampleProject()
  const resource = sampleResource()
  resource.config = { ...resource.config, database: 'blog_renamed' }

  const result = connectionString(project, resource, {
    host: '127.0.0.1',
    proxyPort: 5432,
    viaProxy: false,
  })
  assert.equal(result, 'postgres://postgres:abc123@127.0.0.1:15432/blog_renamed')
})
