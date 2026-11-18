// parseSourceConnection, renderServiceSection and redactor
// (packages/pg/src/import-source.ts): the source of `hobby import` is a
// credential, so these tests are as much about what never appears in an
// error as about what is parsed.

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { HobbyError } from '@hobby.sh/core'
import { CONTAINER_HOST_ALIAS, parseSourceConnection, redactor, renderServiceSection } from '../src/index.js'

const SECRET = 'S3cr3t-p@ss/word'

function kw(text: string): Record<string, string> {
  return Object.fromEntries(parseSourceConnection(text).keywords)
}

function refusal(text: string): HobbyError {
  try {
    parseSourceConnection(text)
  } catch (err) {
    assert.ok(err instanceof HobbyError)
    return err
  }
  assert.fail('expected a refusal')
}

test('a Neon-style URL becomes libpq keywords, sslmode kept, application_name set to hobby-import', () => {
  const k = kw('postgresql://alex:AbC123@ep-cool-name-123456.us-east-2.aws.neon.tech/neondb?sslmode=require&channel_binding=require')
  assert.deepEqual(k, {
    user: 'alex',
    password: 'AbC123',
    host: 'ep-cool-name-123456.us-east-2.aws.neon.tech',
    dbname: 'neondb',
    sslmode: 'require',
    channel_binding: 'require',
    application_name: 'hobby-import',
  })
})

test('percent-encoded passwords are decoded, and every spelling of them is a secret', () => {
  const encoded = encodeURIComponent(SECRET)
  const parsed = parseSourceConnection(`postgres://postgres.abcd:${encoded}@aws-0-eu-west-1.pooler.supabase.com:5432/postgres`)
  const k = Object.fromEntries(parsed.keywords)
  assert.equal(k['password'], SECRET)
  assert.equal(k['user'], 'postgres.abcd')
  assert.equal(k['port'], '5432')
  assert.ok(parsed.secrets.includes(SECRET))
  assert.ok(parsed.secrets.includes(encoded))
  assert.deepEqual(parsed.display, { host: 'aws-0-eu-west-1.pooler.supabase.com', database: 'postgres' })
})

test('multiple hosts, IPv6 and ssl=true follow libpq', () => {
  const k = kw('postgres://u:p@[2001:db8::1]:5433,db2.example.com:5434/app?ssl=true')
  assert.equal(k['host'], '2001:db8::1,db2.example.com')
  assert.equal(k['port'], '5433,5434')
  assert.equal(k['sslmode'], 'require')
})

test('keyword=value strings, quoted values and escapes, are parsed like libpq', () => {
  const k = kw(`host=db.example.com port = 5432 dbname=shop user=me password='it\\'s a secret' sslmode=verify-full sslrootcert=system`)
  assert.equal(k['password'], "it's a secret")
  assert.equal(k['port'], '5432')
  assert.equal(k['sslrootcert'], 'system')
})

test('a loopback host is rewritten to the container host alias, and the display keeps what was typed', () => {
  const parsed = parseSourceConnection('postgres://u:p@localhost:5432/app')
  assert.equal(Object.fromEntries(parsed.keywords)['host'], CONTAINER_HOST_ALIAS)
  assert.equal(parsed.loopbackRewritten, true)
  assert.equal(parsed.display.host, 'localhost')
  assert.equal(parseSourceConnection('host=127.0.0.1 user=u').loopbackRewritten, true)
  assert.equal(parseSourceConnection('host=db.example.com user=u').loopbackRewritten, false)
})

test('file keywords, replication, unknown keywords, sockets and a missing host are refused by name, never quoting the input', () => {
  const cases = [
    `host=h user=u password=${SECRET} sslcert=/home/me/cert.pem`,
    `host=h user=u password=${SECRET} passfile=/home/me/.pgpass`,
    `host=h user=u password=${SECRET} sslrootcert=/etc/ssl/root.crt`,
    `host=h user=u password=${SECRET} replication=database`,
    `host=h user=u password=${SECRET} bogus=1`,
    `host=/var/run/postgresql user=u password=${SECRET}`,
    `user=u password=${SECRET}`,
    `postgres://u:${encodeURIComponent(SECRET)}@/db`,
    `password='${SECRET}`,
    `postgres://u:${SECRET}%ZZ@h/db`,
    `mysql://u:${SECRET}@h/db`,
  ]
  for (const text of cases) {
    const err = refusal(text)
    assert.equal(err.code, 'usage', text)
    const wire = JSON.stringify(err.toWire())
    assert.ok(!wire.includes(SECRET), `refusal quoted the secret: ${wire}`)
    assert.ok(!wire.includes(encodeURIComponent(SECRET)), `refusal quoted the encoded secret: ${wire}`)
  }
})

test('a value that cannot be carried by a service file line is refused', () => {
  assert.equal(refusal("host=h user=u password='trailing '").code, 'usage')
  assert.equal(refusal("host=h user=u password='a\nb'").code, 'usage')
})

test('renderServiceSection writes one keyword per line under the section name', () => {
  assert.equal(renderServiceSection('source', [['host', 'h'], ['password', 'p w']]), '[source]\nhost=h\npassword=p w\n')
})

test('redactor replaces every secret, longest first, everywhere it appears', () => {
  const parsed = parseSourceConnection(`postgres://me:${encodeURIComponent(SECRET)}@db.example.com/app`)
  const redact = redactor(parsed.secrets)
  const noisy = `psql: error: invalid connection option in "postgres://me:${encodeURIComponent(SECRET)}@db.example.com/app"; password ${SECRET} rejected`
  const clean = redact(noisy)
  assert.ok(!clean.includes(SECRET))
  assert.ok(!clean.includes(encodeURIComponent(SECRET)))
  assert.match(clean, /\[redacted\]/)
  assert.equal(redact('nothing secret here'), 'nothing secret here')
})
