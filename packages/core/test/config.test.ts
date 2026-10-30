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
import { assertSocketPathFits, HobbyError, resolveConfig, resolvePaths, SOCKET_PATH_MAX_BYTES } from '../src/index.js'

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

test('proxyTls is off by default', () => {
  assert.equal(resolveConfig({ env: {}, cwd }).proxyTls, null)
})

test('the three HOBBY_PROXY_TLS_* variables set proxyTls', () => {
  const config = resolveConfig({
    env: {
      HOBBY_PROXY_TLS_CERT: '/etc/letsencrypt/live/db.example.com/fullchain.pem',
      HOBBY_PROXY_TLS_KEY: '/etc/letsencrypt/live/db.example.com/privkey.pem',
      HOBBY_PROXY_TLS_HOSTNAME: 'db.example.com',
    },
    cwd,
  })
  assert.deepEqual(config.proxyTls, {
    certFile: '/etc/letsencrypt/live/db.example.com/fullchain.pem',
    keyFile: '/etc/letsencrypt/live/db.example.com/privkey.pem',
    hostname: 'db.example.com',
  })
})

test('a partial HOBBY_PROXY_TLS_* set is kept partial, for the daemon to refuse, not dropped', () => {
  const config = resolveConfig({ env: { HOBBY_PROXY_TLS_CERT: '/c.pem' }, cwd })
  assert.deepEqual(config.proxyTls, { certFile: '/c.pem', keyFile: '', hostname: '' })
})

test('a malformed proxyTls in hobby.json becomes a partial config, never a silent null', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hobby-config-test-'))
  writeFileSync(join(dir, 'hobby.json'), JSON.stringify({ proxyTls: 'yes' }))
  assert.deepEqual(resolveConfig({ env: {}, cwd: dir }).proxyTls, { certFile: '', keyFile: '', hostname: '' })
})

// Issue #71: Number('5m') is NaN, and a NaN sleepAfterSeconds was stored as
// null, which means pinned, so a typo quietly turned hibernation off.
test('a non-numeric HOBBY_SLEEP_AFTER_SECONDS is refused by name rather than pinning every project', () => {
  assert.throws(
    () => resolveConfig({ env: { HOBBY_SLEEP_AFTER_SECONDS: '5m' }, cwd }),
    (err: unknown) => {
      assert.ok(err instanceof HobbyError)
      assert.equal(err.code, 'usage')
      assert.match(err.message, /HOBBY_SLEEP_AFTER_SECONDS/)
      assert.match(err.message, /"5m"/)
      return true
    }
  )
})

test('HOBBY_SLEEP_AFTER_SECONDS accepts a positive whole number, and the word null for pinned', () => {
  assert.equal(resolveConfig({ env: { HOBBY_SLEEP_AFTER_SECONDS: '300' }, cwd }).sleepAfterSeconds, 300)
  assert.equal(resolveConfig({ env: { HOBBY_SLEEP_AFTER_SECONDS: 'null' }, cwd }).sleepAfterSeconds, null)
  assert.throws(() => resolveConfig({ env: { HOBBY_SLEEP_AFTER_SECONDS: '0' }, cwd }), /HOBBY_SLEEP_AFTER_SECONDS/)
  assert.throws(() => resolveConfig({ env: { HOBBY_SLEEP_AFTER_SECONDS: '1.5' }, cwd }), /HOBBY_SLEEP_AFTER_SECONDS/)
})

test('a non-numeric port variable is refused by name instead of reaching Node as NaN', () => {
  assert.throws(() => resolveConfig({ env: { HOBBY_PROXY_PORT: 'abc' }, cwd }), /HOBBY_PROXY_PORT must be a whole number/)
  assert.throws(() => resolveConfig({ env: { HOBBY_API_PORT: '70000' }, cwd }), /HOBBY_API_PORT/)
  assert.equal(resolveConfig({ env: { HOBBY_PROXY_PORT: '15432' }, cwd }).proxyPort, 15432)
})

// Issue #106: a malformed hobby.json used to break every command with a bare
// JSON.parse message that named neither the file nor where it was found.
test('a malformed hobby.json is a usage error naming the file', () => {
  const fileCwd = mkdtempSync(join(tmpdir(), 'hobby-config-file-test-'))
  writeFileSync(join(fileCwd, 'hobby.json'), '{project: "x"}')

  assert.throws(
    () => resolveConfig({ env: {}, cwd: fileCwd }),
    (err: unknown) => {
      assert.ok(err instanceof HobbyError)
      assert.equal(err.code, 'usage')
      assert.match(err.message, /hobby\.json at .*hobby\.json is not valid JSON: /)
      assert.ok(err.message.includes(join(fileCwd, 'hobby.json')))
      return true
    }
  )
})

// Issue #107: sun_path is 104 bytes on macOS, and a HOBBY_HOME deep enough to
// overflow it used to pass `hobby init` and fail `hobby daemon` with a raw
// listen EINVAL.
test('assertSocketPathFits refuses a socket path over 103 bytes and names the fix', () => {
  assert.equal(SOCKET_PATH_MAX_BYTES, 103)
  assertSocketPathFits(resolvePaths({ HOBBY_HOME: '/tmp/short' }).socketPath)

  const deep = `/tmp/${'a'.repeat(110)}`
  const { socketPath } = resolvePaths({ HOBBY_HOME: deep })
  assert.throws(
    () => assertSocketPathFits(socketPath),
    (err: unknown) => {
      assert.ok(err instanceof HobbyError)
      assert.equal(err.code, 'usage')
      assert.ok(err.message.includes(socketPath))
      assert.ok(err.message.includes(`${Buffer.byteLength(socketPath)} bytes`))
      assert.ok(err.message.includes('103'))
      assert.match(err.hint ?? '', /HOBBY_HOME/)
      return true
    }
  )
})
