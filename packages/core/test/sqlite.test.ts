// The contract sqlite.ts exists to hold: whichever runtime is underneath, a
// row that does not exist reads as `undefined`.
//
// This matters more than it looks. store.ts asks `row === undefined` on every
// lookup, and bun:sqlite answers a miss with `null` where node:sqlite answers
// `undefined`. Without the normalisation, `getProject` on an unknown id would
// have taken the found branch under Bun and called rowToProject(null): a wrong
// answer rather than a crash, on the most common read in the codebase.
//
// Run under whichever runtime is executing the suite, so it is the same
// assertion on both. Under Node it pins that nothing regressed; under Bun it
// pins the difference this file was written for.

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { openDatabase } from '../src/sqlite.js'

test('a row that does not exist reads as undefined, never null', () => {
  const db = openDatabase(':memory:')
  try {
    db.exec('CREATE TABLE t (id TEXT PRIMARY KEY, n INTEGER)')
    db.prepare('INSERT INTO t (id, n) VALUES (?, ?)').run('a', 1)

    // Asserted by reading properties, not by deep-equalling the object:
    // node:sqlite hands back null-prototype rows and bun:sqlite hands back
    // ordinary ones, which deepEqual treats as different shapes. store.ts only
    // ever reads properties off a row, so that difference is real and does not
    // matter; a test that failed on it would be testing the wrong thing.
    const hit = db.prepare('SELECT * FROM t WHERE id = ?').get('a') as { id: string; n: number }
    assert.equal(hit.id, 'a')
    assert.equal(hit.n, 1)

    const miss = db.prepare('SELECT * FROM t WHERE id = ?').get('nope')
    // Not assert.equal(miss, undefined): that passes for null under loose
    // rules and this is exactly the distinction being pinned.
    assert.strictEqual(miss, undefined)
    assert.strictEqual(miss === undefined, true)
  } finally {
    db.close()
  }
})

test('all returns an array, empty rather than absent, when nothing matches', () => {
  const db = openDatabase(':memory:')
  try {
    db.exec('CREATE TABLE t (id TEXT PRIMARY KEY)')
    assert.deepEqual(db.prepare('SELECT * FROM t').all(), [])
  } finally {
    db.close()
  }
})
