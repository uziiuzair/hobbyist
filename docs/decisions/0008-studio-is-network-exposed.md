# 0008. Studio is network exposed, with an operator credential

Status: ACCEPTED
Date:   2026-08-07

## Context

Studio can create and destroy databases and run arbitrary SQL, which makes it the
highest-value target on the machine. The box is frequently a VPS with a public
IP.

Two shapes were considered. Bind to `127.0.0.1` and reach it over an SSH tunnel,
which ships no auth system at all and has essentially no attack surface. Or bind
to the network with TLS and authentication, which gives a shareable URL and phone
access at the cost of owning an auth system.

Localhost-plus-tunnel was recommended on liability grounds and was not chosen. A
panel you cannot open from your phone is a panel you stop using, and the success
metric is daily use.

## Decision

**Studio is reachable over the network, behind TLS, gated by a single operator
credential.**

The posture that makes this defensible is the whole decision, not a footnote:

- **One operator credential. No user accounts, no roles, no teams.**
- **The credential can only be created or changed by running `hobby studio
  passwd` on the box**, which means existing shell access is the root of trust.
  There is no bootstrap window where a fresh install is open.
- **No self-service signup, ever. No email-based password reset, ever.** No
  outbound mail means no mail dependency, no reset-token surface, and no account
  recovery flow to attack. If you lose it, you SSH in and set a new one.
- **Argon2id** for the credential, a random secret per install, `HttpOnly`
  `Secure` `SameSite=Strict` session cookies, and rate limiting with backoff on
  failed attempts.
- **The daemon's HTTP API binds to loopback only.** Caddy is the only thing that
  reaches it from outside, and TLS terminates in Caddy (ADR 0009). The daemon
  never listens on a public interface.
- **Local clients do not use this path at all.** CLI and MCP speak to the daemon
  over a unix socket, where filesystem permissions are the authentication and no
  credential exists to leak.

## Consequences accepted

- **We own an auth system, and it is a real security boundary.** Session
  handling, credential storage and rate limiting have to be correct rather than
  approximately correct, and they get reviewed as security code.
- **An exposed admin panel on other people's machines is a liability** we said we
  do not take on. The constraints above are the mitigation, and the licence
  disclaims warranty, but the honest statement is that this is the largest
  security surface in the project.
- **No account recovery.** Losing the credential without shell access means
  losing Studio access. That is deliberate.
- **Exposure is a choice the user makes**, and `hobby init` states plainly what
  is about to be reachable from the internet.

## What would have to change to revisit

A credential compromise in the wild, or the auth surface growing past a single
operator (teams, roles, tokens for third parties). Either is a signal to flip the
default to loopback with a tunnel and make exposure opt-in.
