# 0019. The proxy terminates TLS, from certificate files the operator provides

Date: 2026-09-28
Status: ACCEPTED

## Context

ADR 0017 made loopback the default bind because the proxy answered every
`SSLRequest` with `N`, so a password crossed any network in cleartext. It
offered the tailnet as the way to reach a database from another machine.

That leaves out the obvious deployment: an application on a hosted platform
(Vercel, Fly, Render) that is not on the operator's tailnet and cannot easily
join it. The first person to put Hobbyist into production hit exactly this,
on 2026-09-28, with a public app host and a Postgres on a DigitalOcean
droplet. Without TLS, their options were a cleartext password over the
internet or not using Hobbyist.

`docs/proxy/CLAUDE.md` has said since Phase 1 that TLS must terminate at the
proxy, because routing reads the startup packet and the startup packet is
inside the TLS session. It left open where the certificate comes from.

## Decision

**The proxy terminates TLS when `proxyTls` is set, and refuses plaintext
startups from other machines once it is.**

- `proxyTls` is `{ certFile, keyFile, hostname }`, or the three environment
  variables `HOBBY_PROXY_TLS_CERT`, `HOBBY_PROXY_TLS_KEY` and
  `HOBBY_PROXY_TLS_HOSTNAME`. All three or none: a partial set stops the
  daemon from starting and names what is missing.
- **The certificate is the operator's files.** certbot's
  `/etc/letsencrypt/live/<name>/fullchain.pem` and `privkey.pem` is the
  expected case. The proxy re-reads them when their modification time
  changes, so a renewal needs no restart.
- **`SSLRequest` is answered `S`** and the handshake follows on the same
  connection, as Postgres itself does.
- **A plaintext startup from a non-loopback address is refused** with
  `FATAL 28000` and a message naming `sslmode=require`. Loopback stays
  plaintext: nothing leaves the machine, and `hobby connect` builds a
  `127.0.0.1` string. A plaintext `CancelRequest` is not refused, because it
  carries no credentials and libpq before 17 sends it in plaintext even on a
  `sslmode=require` connection.
- **The daemon reports a third connection string**, `publicConnectionString`,
  built from `hostname` with `?sslmode=require`, and `hobby new` prints it as
  `public:`. The tailnet string gains `?sslmode=require` too, since a tailnet
  peer is another machine. `require` rather than `verify-full` there, because
  the certificate names `hostname`, not the MagicDNS name.

With `proxyTls` set, `proxyHost: "all"` is the intended setup rather than the
footgun ADR 0017 warned about, and `hobby init` says so instead of warning.

## Why the certificate is not Caddy's

Caddy already runs an ACME client on the box (ADR 0009), and sharing its store
was the obvious alternative. It was not taken because Caddy is off by default,
its store is not persisted across container replacement (issue #18), and it
would make the database, the part of this project that must keep working,
depend on the HTTP front door that is optional. Reading two files couples to
nothing. If Caddy's store becomes persistent and Caddy becomes the default,
pointing `proxyTls` at Caddy's files is a configuration change, not a code
change.

## How it is built, and why that way

The direct implementation, `new tls.TLSSocket(socket, { isServer: true })` on
the accepted socket, works under Node and **hangs under Bun 1.3.14**: the
client's ClientHello is never answered. The daemon runs on Bun (ADR 0006). So
after the `S`, the proxy pipes the raw socket to a `tls.createServer` on an
ephemeral loopback port, and that server hands each decrypted connection back
to the ordinary connection handler. Measured working under both runtimes.

`server.setSecureContext()`, the documented way to swap a certificate, is
**a no-op under Bun** as well (same version, measured: the old certificate is
still served). So a changed certificate starts a new inner server and closes
the old one. A pair that fails to load (certbot caught with one file replaced)
leaves the old server in service, and the next connection tries again.

Both were found by spiking under Bun before writing any code. The unit tests
run under `node --test`, which would have passed either broken version, so
`packages/proxy/test/tls.test.ts` is also run under `bun test`.

## What this does not do

- **PostgreSQL 17's `sslnegotiation=direct`**, where the client sends a TLS
  ClientHello with no `SSLRequest` first. `parseStartup` rejects it as an
  implausible length. libpq's default is still the `SSLRequest` path, so this
  is a documented gap rather than a bug.
- **Client certificates.** Passwords only, as before. Auth still passes
  through to Postgres.
- **Obtaining the certificate.** The operator runs certbot, or anything else
  that produces a PEM pair. Automating ACME inside the daemon is a feature
  that has to earn its place by being demanded.
- **Rate limiting or blocking scanners.** A public Postgres port attracts
  password guessing. SCRAM makes each guess expensive, and the generated
  passwords are long and random, but nothing here throttles attempts.
