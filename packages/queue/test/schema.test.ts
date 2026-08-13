import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { openQueueDb } from '../src/schema.js'

const roots: string[] = []
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'hobby-queue-'))
  roots.push(dir)
  return dir
}
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

test('opening a queue creates the messages table', () => {
  const db = openQueueDb(join(tempDir(), 'q.sqlite'))
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'messages'")
    .get() as { name: string } | undefined
  assert.equal(row?.name, 'messages')
  db.close()
})

test('opening the same queue twice is safe and keeps the rows', () => {
  const path = join(tempDir(), 'q.sqlite')
  const first = openQueueDb(path)
  first
    .prepare(
      'INSERT INTO messages (id, body, content_type, bytes, enqueued_at, visible_at, attempts) VALUES (?, ?, ?, ?, ?, ?, 0)'
    )
    .run('01AAA', '"x"', 'json', 3, 1000, 1000)
  first.close()

  const second = openQueueDb(path)
  const count = second.prepare('SELECT count(*) AS n FROM messages').get() as { n: number }
  assert.equal(count.n, 1)
  second.close()
})

test('opening a queue creates missing parent directories', () => {
  const db = openQueueDb(join(tempDir(), 'nested', 'deeper', 'q.sqlite'))
  db.close()
})
