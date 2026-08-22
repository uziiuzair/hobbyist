# 0017. The proxy binds loopback by default, and the tailnet on request

Date: 2026-08-22
Status: ACCEPTED

## Context

`docs/proxy/research/2026-08-22-the-proxy-binds-every-interface.md` measured two
DigitalOcean boxes installed from `hobby.sh/install` and found Postgres reachable
from the open internet on both. The proxy answers an `SSLRequest` with `N`, so
there is no TLS and a password crosses in cleartext.

This is not a misconfiguration. `packages/proxy/src/proxy.ts` defaults
`opts.host` to `0.0.0.0`, the daemon never passes one, and no `proxyHost`
setting exists, so an operator cannot change it without editing source.

The root `CLAUDE.md` says the project does not ship things whose failure mode is
someone else getting owned or losing data quietly. A plaintext Postgres on a
public cloud VM, with no warning, is exactly that.

The counter-argument is real: the whole point is to connect an application to a
database, and that application is often on another machine. A loopback-only
default breaks the obvious thing on day one.

## Decision

**`proxyHost` becomes a real setting. It defaults to `127.0.0.1`.**

It accepts three forms:

- an address, bound literally
- `"tailnet"`, which resolves this machine's Tailscale address and binds
  loopback plus that, and fails loudly if there is no tailnet
- `"all"`, which is the old `0.0.0.0` behaviour, spelled out

This is a breaking change for anyone who was reaching a database over a public
address. It is being made at `v0.1.0-alpha.1`, when the project has one user, and
the alternative is making it later when it has more.

## Why not the alternatives

**Keep `0.0.0.0` and only warn.** A warning that scrolls past during install
does not protect anyone, and the failure it warns about is somebody else's
database being read. Warnings are the right strength for the reflink case, where
the consequence is a slow copy. They are not the right strength here.

**Bind loopback and say nothing else.** Correct and unhelpful. The first thing a
user does after installing is connect something, and answering "use an SSH
tunnel" to a tool whose pitch is convenience gives away the pitch.

**Ship TLS on the proxy instead.** The better long-term answer, and much larger:
a certificate story, a rotation story, and a client configuration story, none of
which exist. Binding loopback is available today and does not conflict with
adding TLS later.

## Consequences

- A fresh install cannot reach its database from another machine until the
  operator chooses how. `hobby init` says so, and names the three ways.
- `"tailnet"` becomes the recommended answer, and is one word of configuration
  rather than a tunnel to run. It reuses the detection already written for the
  tailnet connection string.
- Anyone upgrading who relied on the old behaviour has to set `proxyHost` to
  `"all"`, and the release notes say so.
- The queue endpoint and the HTTP router are unaffected. Both already bind
  deliberately and are covered by their own decisions.
- This does not make the proxy safe to expose. It has no TLS. `"all"` remains a
  loaded gun and its documentation says so.
