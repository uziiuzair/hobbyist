import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SqliteDatabase } from '@hobby.sh/core'
import { openQueueDb } from '../src/schema.js'

const roots: string[] = []

export function tempQueue(): SqliteDatabase {
  const dir = mkdtempSync(join(tmpdir(), 'hobby-queue-'))
  roots.push(dir)
  return openQueueDb(join(dir, 'q.sqlite'))
}

export function cleanupQueues(): void {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
  roots.length = 0
}

export const NOW = 1786375171389

export function json(value: unknown): { body: string; contentType: 'json' } {
  return { body: JSON.stringify(value), contentType: 'json' }
}
