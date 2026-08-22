# Studio over a tailnet, verified

Status: NOTES, measured 2026-08-22. **The result is good, and it corrected the
project's own understanding of which surface is exposed.**

## What was verified

`tailscale serve --bg 7432` in front of the daemon, reached from another machine
on the tailnet:

| Check | Result |
|---|---|
| `GET /` over HTTPS | 200, valid tailnet certificate |
| Body | Studio's HTML, `<title>Hobbyist Studio</title>` |
| `GET /v1/health` | 200, unauthenticated, by design |
| `GET /studio/session` | 200, `{"authenticated":false}` |
| `GET /v1/projects` | **401** |
| `GET /v1/preflight` | **401** |
| `POST /v1/projects` | **401**, nothing created |

The session gate holds over the tailnet. `createStudioApp`
(`packages/cli/src/daemon/server.ts:337`) wraps the TCP listener and applies the
gate to every `/v1/` route, so exposing that port to a tailnet exposes Studio's
login and nothing else. Two independent layers end up in front of the control
plane: the tailnet ACL and the operator session.

`tailscale serve` is the right tool specifically because it does not change the
bind. The listener stays on `127.0.0.1` and tailscaled proxies to it, so the
daemon's own "never 0.0.0.0" rule is preserved.

## What it corrected

The documentation, including the pages written for the launch, described Studio
as the largest exposed surface and the one to keep behind a tunnel. Measured,
Studio is the *safest* listener on the box: loopback-bound and session-gated.

The Postgres proxy is the one actually reachable from the internet, in
cleartext, and nothing warns about it. Filed separately at
`docs/proxy/research/2026-08-22-the-proxy-binds-every-interface.md`.

## Verification method worth keeping

The auth check was done with status codes only and never with response bodies.
Confirming that an access control rejects a request needs the status; reading
what it would have returned does not, and on someone's live box the second is
not a thing to do casually.
