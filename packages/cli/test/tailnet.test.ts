// All fake: parsing is pure, and the detector takes an injected runner, so
// nothing here executes a real `tailscale` binary. The one production
// caller that does is createDaemonContext, which tests never call (see the
// comment on it in src/daemon/context.ts).

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createTailnetDetector, parseTailscaleStatus } from '../src/daemon/tailnet.js'

test('parseTailscaleStatus returns the DNS name without its trailing dot when running', () => {
  const stdout = JSON.stringify({
    BackendState: 'Running',
    Self: { DNSName: 'box.tail1234.ts.net.' },
  })
  assert.equal(parseTailscaleStatus(stdout), 'box.tail1234.ts.net')
})

test('parseTailscaleStatus returns null when the backend is not running', () => {
  const stdout = JSON.stringify({
    BackendState: 'NeedsLogin',
    Self: { DNSName: 'box.tail1234.ts.net.' },
  })
  assert.equal(parseTailscaleStatus(stdout), null)
})

test('parseTailscaleStatus returns null when Self is missing', () => {
  assert.equal(parseTailscaleStatus(JSON.stringify({ BackendState: 'Running' })), null)
})

test('parseTailscaleStatus returns null when the DNS name is empty', () => {
  const stdout = JSON.stringify({ BackendState: 'Running', Self: { DNSName: '' } })
  assert.equal(parseTailscaleStatus(stdout), null)
})

test('parseTailscaleStatus returns null on output that is not JSON', () => {
  assert.equal(parseTailscaleStatus('tailscale: command not found'), null)
})

test('detector resolves the name through the injected runner', async () => {
  const detect = createTailnetDetector({
    run: async () =>
      JSON.stringify({ BackendState: 'Running', Self: { DNSName: 'box.tail1234.ts.net.' } }),
  })
  assert.equal(await detect(), 'box.tail1234.ts.net')
})

test('detector returns null when the runner throws (no tailscale binary)', async () => {
  const detect = createTailnetDetector({
    run: async () => {
      throw new Error('spawn tailscale ENOENT')
    },
  })
  assert.equal(await detect(), null)
})

test('detector caches the result within the ttl and re-runs after it', async () => {
  let calls = 0
  let clock = 0
  const detect = createTailnetDetector({
    run: async () => {
      calls++
      return JSON.stringify({ BackendState: 'Running', Self: { DNSName: 'box.ts.net.' } })
    },
    ttlMs: 1000,
    now: () => clock,
  })
  assert.equal(await detect(), 'box.ts.net')
  assert.equal(await detect(), 'box.ts.net')
  assert.equal(calls, 1)
  clock = 1001
  assert.equal(await detect(), 'box.ts.net')
  assert.equal(calls, 2)
})

test('detector caches a null result too, not just success', async () => {
  let calls = 0
  const detect = createTailnetDetector({
    run: async () => {
      calls++
      throw new Error('ENOENT')
    },
    ttlMs: 1000,
    now: () => 0,
  })
  assert.equal(await detect(), null)
  assert.equal(await detect(), null)
  assert.equal(calls, 1)
})
