// Config resolution had no test coverage in this repo before this file.
// resolveConfig is the exported entry point; DEFAULT_CONFIG and
// readEnvConfig are module-private, so these tests go through it rather
// than exporting internals just to make testing easier.
//
// cwd is a fresh temp directory holding no hobby.json, so resolveConfig
// never finds a file config and each case here exercises exactly
// DEFAULT_CONFIG merged with (at most) an env override.

import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
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

test('a hobby.json holding the string "false" for caddyEnabled resolves to false, not Boolean("false")', () => {
  // readFileConfig parses hobby.json with an unchecked cast (JSON.parse(...)
  // as Partial<HobbyConfig>), so nothing before resolveConfig itself stops
  // an operator's file from holding the JSON string "false" for a field
  // HobbyConfig declares as boolean. Boolean('false') is true in
  // JavaScript, which is exactly the failure this guards: a hobby.json that
  // reads as "off" must not start Caddy anyway.
  const fileCwd = mkdtempSync(join(tmpdir(), 'hobby-config-file-test-'))
  writeFileSync(join(fileCwd, 'hobby.json'), JSON.stringify({ caddyEnabled: 'false' }))

  const config = resolveConfig({ env: {}, cwd: fileCwd })
  assert.equal(config.caddyEnabled, false)
})

test('a hobby.json holding the real boolean true for caddyEnabled still turns caddy on', () => {
  const fileCwd = mkdtempSync(join(tmpdir(), 'hobby-config-file-test-'))
  writeFileSync(join(fileCwd, 'hobby.json'), JSON.stringify({ caddyEnabled: true }))

  const config = resolveConfig({ env: {}, cwd: fileCwd })
  assert.equal(config.caddyEnabled, true)
})
