import assert from 'node:assert/strict'
import { test } from 'node:test'
import { addressAllowed, canonicalAllowlist, HobbyError, openStore, parseAllowEntry } from '../src/index.js'

test('parseAllowEntry: canonical forms', () => {
  const cases: Array<[string, string]> = [
    ['203.0.113.7', '203.0.113.7'],
    ['203.0.113.7/32', '203.0.113.7'],
    ['192.168.1.7/24', '192.168.1.0/24'],
    ['10.0.0.0/8', '10.0.0.0/8'],
    ['0.0.0.0/0', '0.0.0.0/0'],
    [' 172.16.0.0/12 ', '172.16.0.0/12'],
    ['2001:DB8::1', '2001:db8::1'],
    ['2001:0db8:0000:0000:0000:0000:0000:0001', '2001:db8::1'],
    ['2001:db8:0:0:1:0:0:1', '2001:db8::1:0:0:1'],
    ['2001:db8::1/32', '2001:db8::/32'],
    ['::1', '::1'],
    ['::/0', '::/0'],
    ['fe80::/10', 'fe80::/10'],
    ['::ffff:192.0.2.1', '192.0.2.1'],
    ['::ffff:192.0.2.0/120', '192.0.2.0/24'],
    ['1:2:3:4:5:6:7::', '1:2:3:4:5:6:7:0'],
  ]
  for (const [input, canonical] of cases) {
    assert.equal(parseAllowEntry(input).canonical, canonical, input)
  }
})

test('parseAllowEntry: refuses what is not an address or range', () => {
  for (const bad of ['', 'localhost', '256.0.0.1', '1.2.3', '01.2.3.4', '10.0.0.0/33', '10.0.0.0/', '10.0.0.0/x', '::1/129', '1::2::3', 'fe80::1%en0', '::ffff:1.2.3.4/64', '1:2:3:4:5:6:7:8:9']) {
    assert.throws(() => parseAllowEntry(bad), (err: unknown) => err instanceof HobbyError && err.code === 'usage', bad)
  }
})

test('canonicalAllowlist deduplicates by canonical form and keeps order', () => {
  assert.deepEqual(canonicalAllowlist(['10.1.2.3/8', '10.0.0.0/8', '::1', '0:0:0:0:0:0:0:1']), ['10.0.0.0/8', '::1'])
  assert.throws(() => canonicalAllowlist(Array.from({ length: 300 }, (_, i) => `10.0.${i >> 8}.${i & 255}`)), /at most 256/)
})

test('addressAllowed matches IPv4, IPv6, mapped and zoned client addresses', () => {
  const list = ['192.168.1.0/24', '2001:db8::/32', '203.0.113.7']
  assert.equal(addressAllowed(list, '192.168.1.200'), true)
  assert.equal(addressAllowed(list, '192.168.2.1'), false)
  assert.equal(addressAllowed(list, '::ffff:192.168.1.5'), true)
  assert.equal(addressAllowed(list, '203.0.113.7'), true)
  assert.equal(addressAllowed(list, '203.0.113.8'), false)
  assert.equal(addressAllowed(list, '2001:db8:ffff::9'), true)
  assert.equal(addressAllowed(list, '2001:db9::1'), false)
  assert.equal(addressAllowed(['fe80::/10'], 'fe80::1%en0'), true)
  assert.equal(addressAllowed(['0.0.0.0/0'], '8.8.8.8'), true)
  assert.equal(addressAllowed(['0.0.0.0/0'], '2001:db8::1'), false)
})

test('addressAllowed fails closed: no address, garbage, an empty list', () => {
  assert.equal(addressAllowed(['0.0.0.0/0'], undefined), false)
  assert.equal(addressAllowed(['0.0.0.0/0'], 'not-an-ip'), false)
  assert.equal(addressAllowed([], '10.0.0.1'), false)
  // A stored entry that no longer parses narrows the list, never widens it.
  assert.equal(addressAllowed(['garbage', '10.0.0.0/8'], '10.0.0.1'), true)
  assert.equal(addressAllowed(['garbage'], '10.0.0.1'), false)
})

test('the store keeps null (open), an empty list and a list apart', () => {
  const store = openStore(':memory:')
  try {
    const created = store.createProject({ name: 'blog', sleepAfterSeconds: 300 })
    assert.equal(created.allowlist, null)
    assert.equal(store.getProject(created.id)?.allowlist, null)
    store.setProjectAllowlist(created.id, ['10.0.0.0/8', '::1'])
    assert.deepEqual(store.getProjectByName('blog')?.allowlist, ['10.0.0.0/8', '::1'])
    store.setProjectAllowlist(created.id, [])
    assert.deepEqual(store.listProjects()[0]?.allowlist, [])
    store.setProjectAllowlist(created.id, null)
    assert.equal(store.getProject(created.id)?.allowlist, null)
  } finally {
    store.close()
  }
})
