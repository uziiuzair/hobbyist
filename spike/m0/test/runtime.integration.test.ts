import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { create, start, stopClean, isRunning, removeIfExists } from '../src/runtime.ts'

const NAME = 'm0-runtime-test'
const DATA = mkdtempSync(join(tmpdir(), 'm0-runtime-'))

after(async () => {
  await removeIfExists(NAME)
})

test('a created container is not running until started, and stops cleanly', { timeout: 120_000 }, async () => {
  await removeIfExists(NAME)
  await create({ name: NAME, image: 'postgres:18-alpine', hostPort: 55599, password: 'spike', dataDir: DATA })
  assert.equal(await isRunning(NAME), false)

  await start(NAME)
  assert.equal(await isRunning(NAME), true)

  await stopClean(NAME)
  assert.equal(await isRunning(NAME), false)
})

test('isRunning is false for a container that does not exist', async () => {
  assert.equal(await isRunning('m0-definitely-not-here'), false)
})
