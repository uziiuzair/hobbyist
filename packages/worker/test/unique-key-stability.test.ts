// The sharpest data-loss edge in the Durable Objects work, asserted from both
// sides of the seam.
//
// `unsafeUniqueKey` becomes the on-disk directory name holding every object's
// SQLite file. If it changed on redeploy or on rename, every object's storage
// would be orphaned: not an error, not a warning, just a worker that comes
// back up with an empty database and a user who has no idea why. Nothing else
// in the system notices, because the old directory is still perfectly valid
// storage for a namespace nobody addresses any more.
//
// These live here rather than in @hobby.sh/do because uniqueKeyFor is this
// package's function; the parse half is imported from there, which is the
// direction the dependency already runs.

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseUniqueKey } from '@hobby.sh/do'
import { uniqueKeyFor } from '../src/worker.js'

const RESOURCE_ID = '8f14e45f-ceea-467a-9e73-8bdb0d1e1c2b'

test('the unique key is derived only from the resource id and the class name', () => {
  assert.equal(uniqueKeyFor(RESOURCE_ID, 'Room'), `${RESOURCE_ID}-Room`)
})

test('redeploying does not change the unique key, because nothing per-deploy feeds it', () => {
  // The resource id is assigned once at createResource and never rewritten, so
  // "redeploy" is just calling this again with the same resource.
  const before = uniqueKeyFor(RESOURCE_ID, 'Room')
  const after = uniqueKeyFor(RESOURCE_ID, 'Room')
  assert.equal(after, before)
})

test('renaming the project or the worker does not change the unique key', () => {
  // Neither name is an input. This test exists to fail loudly if either is
  // ever added as one, which is the tempting change: a human-readable
  // directory name is nicer right up until someone runs `hobby rename`.
  const key = uniqueKeyFor(RESOURCE_ID, 'Room')
  assert.equal(key.includes('chat'), false)
  assert.equal(key.includes('api'), false)
  assert.equal(key, `${RESOURCE_ID}-Room`)
})

test('two workers declaring the same class name do not share a directory', () => {
  // The failure the default modifier would have caused: with `unsafeUniqueKey`
  // unset, workerd names the directory `-<ClassName>`, so two workers each
  // declaring `Room` would write into one directory and interleave their
  // objects.
  const a = uniqueKeyFor('11111111-1111-1111-1111-111111111111', 'Room')
  const b = uniqueKeyFor('22222222-2222-2222-2222-222222222222', 'Room')
  assert.notEqual(a, b)
})

test('the key round-trips through the parser the catalog uses', () => {
  // The two halves of the seam agreeing. @hobby.sh/do splits at the LAST
  // hyphen because a UUID contains hyphens and a class name cannot; this
  // asserts that assumption against the real generator rather than against a
  // hand-written string.
  const parsed = parseUniqueKey(uniqueKeyFor(RESOURCE_ID, 'Room'))
  assert.deepEqual(parsed, { resourceId: RESOURCE_ID, className: 'Room' })
})
