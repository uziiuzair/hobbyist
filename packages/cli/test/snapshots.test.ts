import assert from 'node:assert/strict'
import { test } from 'node:test'
import { resolvePaths, validateName } from '@hobby.sh/core'
import { projectSnapshotsDir, snapshotDir, snapshotId, verifyProjectName } from '../src/daemon/snapshots.js'

test('snapshotId is lowercase, sortable, and safe inside a project name', () => {
  const id = snapshotId(Date.UTC(2026, 7, 16, 14, 30, 0), 'a1b2c3')
  assert.equal(id, '20260816t143000z-a1b2c3')
  assert.equal(id, id.toLowerCase())
  // The whole reason for lowercase: verify names are built from this.
  assert.doesNotThrow(() => validateName(verifyProjectName(id)))
})

test('snapshotIds sort chronologically as strings', () => {
  const earlier = snapshotId(Date.UTC(2026, 7, 16, 9, 0, 0), 'aaaaaa')
  const later = snapshotId(Date.UTC(2026, 7, 16, 14, 0, 0), 'aaaaaa')
  assert.equal([later, earlier].sort()[0], earlier)
})

test('verify project names stay inside the 63 character limit', () => {
  const id = snapshotId(Date.UTC(2026, 7, 16, 14, 30, 0), 'a1b2c3')
  assert.equal(verifyProjectName(id), 'verify-a1b2c3')
  assert.ok(verifyProjectName(id).length <= 63)
})

test('snapshot paths hang off the hobby home, not the project directory', () => {
  const paths = resolvePaths({ HOBBY_HOME: '/tmp/hobby-test-home' })
  assert.equal(projectSnapshotsDir(paths, 'blog'), '/tmp/hobby-test-home/snapshots/blog')
  assert.equal(snapshotDir(paths, 'blog', '20260816t143000z-a1b2c3'), '/tmp/hobby-test-home/snapshots/blog/20260816t143000z-a1b2c3')
})
