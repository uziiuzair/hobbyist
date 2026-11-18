# 0021. The proxy sees passwords for serverless driver traffic, and only for it

Status: ACCEPTED
Date:   2026-11-17

## Context

Issue #155 asked for `@neondatabase/serverless` clients to reach Hobby
Postgres. The driver has two modes, and both are now served on the Postgres
proxy port (`packages/proxy/src/serverless.ts`, `docs/proxy/CLAUDE.md`
amendment of 2026-11-17).

`docs/proxy/CLAUDE.md` has said since the proxy was designed that auth is
passthrough: the proxy forwards the startup packet and splices, SCRAM runs
between the client and Postgres, and the proxy never sees a password. The
driver breaks that in two places, and neither can be avoided without dropping
part of the driver.

- **`/sql`, the HTTP mode.** The password arrives in the `Neon-Connection-String`
  header of every request. The proxy must read it to open a Postgres
  connection for the request. There is no form of this protocol in which it
  does not.
- **`Pool` and `Client` with the driver's default `pipelineConnect:
  "password"`.** The driver sends a cleartext PasswordMessage before the server
  asks for one, to save a round trip. A SCRAM Postgres, which is what the stock
  image ships, rejects that. `PipelinedPasswordShim`
  (`packages/proxy/src/pipelined-auth.ts`) holds the early password and runs
  SCRAM with Postgres on the client's behalf, as Neon's own proxy does.

## Decision (proposed)

**For serverless driver traffic only, the proxy handles the password.** It
holds it in memory for one handshake or one request, never logs it, never
stores it, and still lets Postgres decide whether it is right. There is still
no user store. Ordinary TCP clients and WebSocket clients that do not pipeline
are spliced untouched, exactly as before.

Because the password now crosses the wire in a form the proxy reads, the TLS
rule is stricter than ADR 0019's rule for TCP: a driver request from another
machine must arrive over TLS even when `proxyTls` is unset, or it is refused
with a 403 that names what to configure. Loopback and the container gateway
listeners count as local.

## The alternative, stated properly

Keep the old promise by serving only the WebSocket mode and requiring
`neonConfig.pipelineConnect = false`. `/sql` and the driver's default
configuration would not work, which is most of what people copy from Neon's
docs, so #155 would be half closed.

## Consequences accepted

- "The proxy never sees a password" stops being true without qualification.
  It becomes "the proxy never sees a password from a TCP client".
- A bug in `pipelined-auth.ts` or `sql-over-http.ts` could expose a password in
  a way the splice could not. Both are covered by tests against a SCRAM fake
  (`packages/proxy/test/serverless.test.ts`) and were run against a real
  `postgres:18-alpine`.

## What would have to change to revisit

- A credential leak traced to this path, which would argue for the WebSocket
  only alternative.
- The driver changing its default away from pipelining, which would remove the
  shim's reason to exist, leaving only `/sql`.

## Amendment, 2026-11-18: accepted

Accepted by merging #222, which shipped the serverless driver support this
decision covers. The Status line above changed from PROPOSED to ACCEPTED on
this date. Nothing else in the decision changed.
