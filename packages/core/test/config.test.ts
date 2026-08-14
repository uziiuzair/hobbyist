// Config resolution had no test coverage in this repo before this file.
// resolveConfig is the exported entry point; DEFAULT_CONFIG and
// readEnvConfig are module-private, so these tests go through it rather
// than exporting internals just to make testing easier.
//
// cwd is a fresh temp directory holding no hobby.json, so resolveConfig
// never finds a file config and each case here exercises exactly
// DEFAULT_CONFIG merged with (at most) an env override.

import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { resolveConfig } from '../src/index.js'

const cwd = mkdtempSync(join(tmpdir(), 'hobby-config-test-'))

test('caddy is off by default, because starting it binds :80 and :443', () => {
  const config = resolveConfig({ env: {}, cwd })
  assert.equal(config.caddyEnabled, false)
  assert.equal(config.caddyAdminPort, 2019)
  assert.equal(config.caddyStudioHost, null)
})

test('HOBBY_CADDY_ENABLED=1 turns caddy on', () => {
  const config = resolveConfig({ env: { HOBBY_CADDY_ENABLED: '1' }, cwd })
  assert.equal(config.caddyEnabled, true)
})

test('HOBBY_CADDY_ENABLED=true turns caddy on', () => {
  const config = resolveConfig({ env: { HOBBY_CADDY_ENABLED: 'true' }, cwd })
  assert.equal(config.caddyEnabled, true)
})

test('HOBBY_CADDY_ENABLED fails closed on anything unrecognized', () => {
  const config = resolveConfig({ env: { HOBBY_CADDY_ENABLED: 'yes' }, cwd })
  assert.equal(config.caddyEnabled, false)
})

test('HOBBY_CADDY_ENABLED=false resolves to false, not Boolean("false")', () => {
  // Boolean('false') is true in JavaScript, which is exactly what the
  // allow-list in config.ts exists to defeat: an operator who explicitly
  // opted out must not end up with :80 and :443 bound anyway.
  const config = resolveConfig({ env: { HOBBY_CADDY_ENABLED: 'false' }, cwd })
  assert.equal(config.caddyEnabled, false)
})

test('HOBBY_CADDY_ENABLED=0 resolves to false', () => {
  const config = resolveConfig({ env: { HOBBY_CADDY_ENABLED: '0' }, cwd })
  assert.equal(config.caddyEnabled, false)
})

test('HOBBY_CADDY_ADMIN_PORT overrides the admin port', () => {
  const config = resolveConfig({ env: { HOBBY_CADDY_ADMIN_PORT: '2020' }, cwd })
  assert.equal(config.caddyAdminPort, 2020)
})

test('HOBBY_CADDY_STUDIO_HOST overrides the studio host', () => {
  const config = resolveConfig({
    env: { HOBBY_CADDY_STUDIO_HOST: 'studio.example.com' },
    cwd,
  })
  assert.equal(config.caddyStudioHost, 'studio.example.com')
})

test('all three caddy env overrides parse together', () => {
  const config = resolveConfig({
    env: {
      HOBBY_CADDY_ENABLED: '1',
      HOBBY_CADDY_ADMIN_PORT: '2020',
      HOBBY_CADDY_STUDIO_HOST: 'studio.example.com',
    },
    cwd,
  })
  assert.equal(config.caddyEnabled, true)
  assert.equal(config.caddyAdminPort, 2020)
  assert.equal(config.caddyStudioHost, 'studio.example.com')
})
