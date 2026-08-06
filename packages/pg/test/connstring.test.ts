// Written but not executed in this task, see task-3-report.md.

import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { PostgresConfig, Project, Resource } from '@hobby.sh/core'
import { connectionString } from '../src/index.js'

function sampleProject(): Project {
  return {
    id: 'project-1',
    name: 'blog',
    networkName: 'hobby-blog',
    sleepAfterSeconds: 300,
    createdAt: new Date('2026-01-01T00:00:00Z'),
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

function sampleResource(): Resource {
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

test('connectionString renders the proxy form', () => {
  const result = connectionString(sampleProject(), sampleResource(), {
    host: 'db.example.com',
    port: 5432,
    viaProxy: true,
  })
  assert.equal(result, 'postgres://postgres:abc123@db.example.com:5432/blog')
})

test('connectionString renders the direct form with the host port', () => {
  const result = connectionString(sampleProject(), sampleResource(), {
    host: '127.0.0.1',
    port: 15432,
    viaProxy: false,
  })
  assert.equal(result, 'postgres://postgres:abc123@127.0.0.1:15432/blog')
})

test('connectionString URL-encodes superuser and password', () => {
  const project = sampleProject()
  const resource = sampleResource()
  resource.config = { ...resource.config, superuser: 'a b', password: 'p@ss/word' }

  const result = connectionString(project, resource, {
    host: '127.0.0.1',
    port: 15432,
    viaProxy: false,
  })
  assert.equal(result, 'postgres://a%20b:p%40ss%2Fword@127.0.0.1:15432/blog')
})
