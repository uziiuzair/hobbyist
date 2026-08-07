// Pure, no network, no real browser: a fake Storage stands in for
// localStorage so the round-trip (write, reload, still there) is a real
// assertion rather than a description of intent.

import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  clearHistory,
  deleteSnippet,
  loadHistory,
  loadSnippets,
  pushHistory,
  saveSnippet,
  type HistoryEntry,
  type Snippet,
  type StorageLike,
} from '../src/lib/sqlStorage.js'

function fakeStorage(): StorageLike {
  const data = new Map<string, string>()
  return {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => {
      data.set(key, value)
    },
  }
}

test('history round-trips through storage, newest first', () => {
  const storage = fakeStorage()
  const first: HistoryEntry = { id: '1', resourceId: 'res-a', sql: 'select 1', ranAt: '2026-01-01T00:00:00Z', ok: true }
  const second: HistoryEntry = { id: '2', resourceId: 'res-a', sql: 'select 2', ranAt: '2026-01-01T00:01:00Z', ok: true }

  pushHistory(storage, first)
  const result = pushHistory(storage, second)

  assert.deepEqual(result, [second, first])
  assert.deepEqual(loadHistory(storage), [second, first])
  assert.deepEqual(loadHistory(storage, 'res-a'), [second, first])
})

test('history is filterable by resourceId, since one browser can hold many projects', () => {
  const storage = fakeStorage()
  pushHistory(storage, { id: '1', resourceId: 'res-a', sql: 'select 1', ranAt: 't1', ok: true })
  pushHistory(storage, { id: '2', resourceId: 'res-b', sql: 'select 2', ranAt: 't2', ok: true })

  assert.deepEqual(
    loadHistory(storage, 'res-b').map((e) => e.id),
    ['2']
  )
})

test('clearHistory for one resource leaves the others alone', () => {
  const storage = fakeStorage()
  pushHistory(storage, { id: '1', resourceId: 'res-a', sql: 'select 1', ranAt: 't1', ok: true })
  pushHistory(storage, { id: '2', resourceId: 'res-b', sql: 'select 2', ranAt: 't2', ok: true })

  clearHistory(storage, 'res-a')

  assert.deepEqual(loadHistory(storage, 'res-a'), [])
  assert.equal(loadHistory(storage, 'res-b').length, 1)
})

test('loadHistory on an empty or corrupt key returns an empty array rather than throwing', () => {
  const storage = fakeStorage()
  assert.deepEqual(loadHistory(storage), [])

  storage.setItem('hobbystudio:sql:history', 'not json')
  assert.deepEqual(loadHistory(storage), [])

  storage.setItem('hobbystudio:sql:history', '{"not":"an array"}')
  assert.deepEqual(loadHistory(storage), [])
})

test('snippets round-trip and stay sorted by name', () => {
  const storage = fakeStorage()
  const b: Snippet = { id: 'b', name: 'bbb', sql: 'select b', savedAt: 't' }
  const a: Snippet = { id: 'a', name: 'aaa', sql: 'select a', savedAt: 't' }

  saveSnippet(storage, b)
  const result = saveSnippet(storage, a)

  assert.deepEqual(
    result.map((s) => s.id),
    ['a', 'b']
  )
  assert.deepEqual(
    loadSnippets(storage).map((s) => s.id),
    ['a', 'b']
  )
})

test('saving a snippet with an existing id replaces it rather than duplicating', () => {
  const storage = fakeStorage()
  saveSnippet(storage, { id: 'a', name: 'first name', sql: 'select 1', savedAt: 't1' })
  const result = saveSnippet(storage, { id: 'a', name: 'renamed', sql: 'select 2', savedAt: 't2' })

  assert.equal(result.length, 1)
  assert.equal(result[0]?.name, 'renamed')
  assert.equal(result[0]?.sql, 'select 2')
})

test('deleteSnippet removes only the matching id', () => {
  const storage = fakeStorage()
  saveSnippet(storage, { id: 'a', name: 'a', sql: 'select a', savedAt: 't' })
  saveSnippet(storage, { id: 'b', name: 'b', sql: 'select b', savedAt: 't' })

  const result = deleteSnippet(storage, 'a')

  assert.deepEqual(
    result.map((s) => s.id),
    ['b']
  )
})
