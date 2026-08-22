# The proxy binds every interface, and cannot be told not to

Status: NOTES, measured 2026-08-22 on two live DigitalOcean boxes.
**Unresolved. One decision below belongs to the author.**

Found while verifying that `tailscale serve` reaches Studio. It is not about
Studio, and it is more serious than the thing it was found looking for.

## What was measured

Two DigitalOcean droplets, both running an install from `hobby.sh/install` on
2026-08-22, both otherwise untouched.

```
204.48.21.231:5432   OPEN from the public internet
147.182.214.35:5432  OPEN from the public internet
```

Both answer the Postgres wire protocol. An `SSLRequest` (`Int32(8)
Int32(80877103)`) is answered with a single byte `N`, which in that protocol
means the server does not offer TLS. So a client reaching this from outside the
box negotiates no encryption and sends its password in cleartext.

Neither box had a firewall in the way, and neither was configured to remove
one:

| | vm-01 | vm-02 |
|---|---|---|
| `ss -ltn` on 0.0.0.0 | `5432`, `22` | `5432`, `22` |
| `ufw status` | inactive | inactive |
| `iptables -S INPUT` policy | ACCEPT | ACCEPT |
| rules mentioning 5432 | none | none |

Only throwaway `coldstart` projects existed on either, so no real data was
exposed. That is luck rather than design.

## Why it happens

`packages/proxy/src/proxy.ts:611`

```ts
server.listen(opts.port, opts.host ?? '0.0.0.0', () => {
```

`packages/cli/src/daemon/server.ts:359`

```ts
const proxy = await startPgProxy({
  port: ctx.config.proxyPort,
  deps: createProxyDeps(ctx),
  wakeTimeoutMs: ctx.config.wakeTimeoutMs,
})
```

The daemon never passes `host`, so the default applies and the proxy binds every
interface. There is no `proxyHost` field in `HobbyConfig`
(`packages/core/src/config.ts`) and no environment variable, so an operator
cannot change this without editing source. The `opts.host` parameter exists and
is simply never wired to configuration.

## This inverts the stated security posture

The project's documentation, including the pages written for the launch, says
Studio is the largest exposed surface and should be kept behind a tunnel. That
is now measured and it is the wrong way round.

| Surface | Binds | Unauthenticated request |
|---|---|---|
| Studio and the daemon API, `apiPort` | `127.0.0.1` only, deliberately (`server.ts:343`) | `/v1/projects`, `/v1/preflight`, `POST /v1/projects` all **401** |
| The Postgres proxy, `proxyPort` | **every interface** | speaks the protocol to anyone, no TLS |

Studio is fine. It is wrapped in `createStudioApp` (`server.ts:337`), which
applies the session gate to every `/v1/` route, and only `/v1/health` and the
three `/studio/*` session routes answer without a session. Verified over a
tailnet on 2026-08-22.

The proxy is the surface that is actually reachable, and nothing warns about it.
`hobby init` reports `proxy port 5432: free`, which describes the port being
available to bind, and says nothing about what binding it will expose.

## Mitigation for an operator today

Tailnet-only, keeping SSH reachable:

```sh
ufw allow 22/tcp
ufw allow in on tailscale0
ufw deny 5432/tcp
ufw --force enable
```

Untested by this document, and deliberately not run on the boxes above:
enabling a firewall remotely can lock an operator out, and it breaks any client
that reaches the database over the public address on purpose.

## Three changes, two of them uncontroversial

**1. Wire a `proxyHost` through configuration.** Strictly additive: add the
field to `HobbyConfig`, thread it into the `startPgProxy` call, keep the current
default so nothing changes for anyone. This only makes it *possible* to bind
loopback or a tailnet address, which today it is not.

**2. Warn in preflight.** When the proxy will bind a public interface and no
firewall rule covers the port, `hobby init` should say so, in the same shape as
the existing reflink and host-networking warnings. A warning is the right
strength: on a home server behind NAT this is harmless, and refusing would be
wrong.

**3. The default is the author's call, and is an ADR.** Changing `0.0.0.0` to
`127.0.0.1` matches the project's own stated line, that it does not ship things
whose failure mode is someone else getting owned quietly, and a plaintext
Postgres on a public cloud VM is exactly that. It also breaks connecting to a
database from a laptop, which is a real and common use, and the documented
answer for that is a tailnet the default cannot assume exists.

Recorded rather than decided, per the repo's own convention that a deliberate
change of this kind gets a record first.

## What this does not cover

- No test of whether Postgres itself would accept a connection from outside,
  which needs credentials and was not attempted.
- No check of other providers' default firewalls. DigitalOcean droplets ship
  with none; some providers ship one, and there the exposure would not occur.
- The HTTP router on `httpPort` binds `127.0.0.1` and was not part of this
  finding.
