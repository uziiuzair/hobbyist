import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createStopSignal } from '../src/index.js'

const settled = (): Promise<void> => Promise.resolve()
const never = (): Promise<void> => new Promise<void>(() => {})

test('a wait whose sleep settles first resolves true', async () => {
  const signal = createStopSignal()
  assert.equal(await signal.wait(settled()), true)
})

test('stop() interrupts a wait in flight, which resolves false', async () => {
  const signal = createStopSignal()
  const waiting = signal.wait(never())
  assert.equal(signal.pending, 1)
  signal.stop()
  assert.equal(await waiting, false)
  assert.equal(signal.stopped, true)
})

test('a wait started after stop() resolves false without waiting for its sleep', async () => {
  const signal = createStopSignal()
  signal.stop()
  assert.equal(await signal.wait(never()), false)
  assert.equal(signal.pending, 0)
})

test('stop() is idempotent', async () => {
  const signal = createStopSignal()
  signal.stop()
  signal.stop()
  assert.equal(signal.stopped, true)
})

// The regression this file exists for. The loops that use this used to race
// every sleep against .then() on one promise that stayed pending for the life
// of the daemon, and each of those reactions was kept forever: about 145
// bytes of heap a wait, four waits a second from the queue tick alone. The count read
// here is the intermediate value that leak lived in, so this reads it
// directly rather than inferring it from memory usage.
test('finished waits leave nothing behind, whichever way they finished', async () => {
  const signal = createStopSignal()
  for (let i = 0; i < 1000; i++) {
    await signal.wait(settled())
  }
  assert.equal(signal.pending, 0)

  const inFlight = [signal.wait(never()), signal.wait(never()), signal.wait(never())]
  assert.equal(signal.pending, 3)
  signal.stop()
  assert.deepEqual(await Promise.all(inFlight), [false, false, false])
  assert.equal(signal.pending, 0)
})

test('a sleep that rejects rejects the wait and still leaves nothing behind', async () => {
  const signal = createStopSignal()
  await assert.rejects(signal.wait(Promise.reject(new Error('timer broke'))), /timer broke/)
  assert.equal(signal.pending, 0)
})
