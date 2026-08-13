# Public ingress and private access: Cloudflare Tunnel and Tailscale

Status: PROPOSED. Research with a recommendation. No ADR exists yet; nothing
here is built, and nothing here is decided until an ADR in `docs/decisions/`
ratifies it.
Date:   2026-08-13

## Verdict

This is not one integration. It is two lanes, and conflating them is the trap:

| Lane | Tool | Carries | Why not the other |
|---|---|---|---|
| Public HTTP | Cloudflare Tunnel | `app`, `worker` | Tailscale Funnel: no custom domains, ports 443/8443/10000 only |
| Private everything | Tailscale | Postgres, Studio, SSH | Cloudflare Tunnel cannot carry Postgres without client-side software |

## 1. The existing design already has the socket for this

`CaddyFallback` in `packages/cli/src/daemon/caddy.ts` is one catch-all route to
the HTTP wake router. The comment above it says why: pushing a route per app
means an admin API call per deploy and drift.

cloudflared's ingress is the same shape: the last rule matches all traffic,
`service: http://127.0.0.1:<router>`. Hostname resolution stays in
`createHttpProxyDeps` (`packages/cli/src/daemon/context.ts`).

So Cloudflare Tunnel is a swap of one managed container for another, not a new
subsystem. `ensureRunning`, `addRoute` and `setFallback` map onto
`cloudflared tunnel run --token`. Caddy's on-demand TLS apparatus
(`TLS_ASK_PATH` in `caddy.ts`, `allowHostname` in `context.ts`) becomes dead
code in the tunnel path, because Cloudflare terminates TLS at the edge.

The catch-all decision, made for Caddy hygiene reasons, turns out to be the
portability seam. Any ingress that can express "send everything to one local
port" plugs in with zero per-resource state. Ingress that needs a config entry
per resource (nginx, remotely-managed tunnels) would not.

## 2. What Cloudflare Tunnel buys

- **No inbound ports.** Outbound-only to port 7844. Works behind CGNAT, a
  residential ISP, no port forwarding. This is the bedroom-hosting story and it
  is real.
- **No ACME on the box.** Kills the Let's Encrypt rate-limit failure mode and
  the ask endpoint, which is the one unauthenticated stranger-reachable surface
  in the current design (`packages/proxy/src/http.ts`).
- **One wildcard DNS record covers everything.** On Cloudflare's standard
  nameservers, a wildcard record is multi-level by default: `*.example.com`
  covers `abc.example.com` and `123.abc.example.com`. All plans can create and
  proxy wildcards. Combined with a wildcard ingress rule: zero Cloudflare API
  calls per deploy.
- **Timeouts are not a problem.** Proxy read timeout 125s, TCP handshake 19s.
  The cold start ceiling is 3s. Massive headroom.
- **WebSockets work**, with a 100s idle timeout on Free and Pro (600s on
  Business). Matters for Durable Object WebSocket hibernation later; needs an
  app-level heartbeat.

## 3. Four blockers, all real

### a. Postgres cannot go through it publicly

Arbitrary TCP over Cloudflare Tunnel requires the client to run
`cloudflared access tcp --hostname pg.example.com --url localhost:5432`, or
WARP plus Gateway. Spectrum handles arbitrary ports at Enterprise only.

This breaks the connection-string promise outright. `psql postgres://...` from
a laptop with nothing installed is the Neon feel; a per-client sidecar process
is not.

### b. Universal SSL is one label deep, and the hostname scheme is two

`parseAppHostname` (`packages/cli/src/daemon/context.ts`) requires exactly two
labels ahead of the domain, deliberately: `blog-api.blog.example.com`.
Cloudflare's tunnel troubleshooting docs state that a multi-level subdomain
requires an Advanced Certificate, because the Universal certificate does not
cover it.

Three ways out:

1. **Flatten to one label** (`<resource>--<project>.example.com`). Free, one
   wildcard record, Universal SSL covers it. Costs a rename of the routing
   scheme and a change to `parseAppHostname`.
2. **Advanced Certificate Manager**, $10/month. A not-a-business project
   telling users to pay Cloudflare monthly.
3. **Upload a Let's Encrypt DNS-01 wildcard** as a custom certificate; manual
   renewal.

Partial (CNAME) zones get per-hostname Universal SSL at any depth, but partial
setup is Business or Enterprise only. Not an out.

### c. Terms of Service

Section 2.8 is gone, but the CDN restriction moved to the Service-Specific
Terms: video and large files not hosted on a Cloudflare service remain
restricted. Media servers through a tunnel are still out of bounds. If Phase 3
object storage gets a public HTTP face, this bites.

### d. Leaveability, promise number one

A tunnel is a hard dependency on one vendor, plus an account, plus nameserver
control. Mitigations that hold: use locally-managed tunnels so ingress config
lives on the box rather than in Cloudflare's dashboard; keep the Caddy path as
a peer, not a legacy; `hobby eject` is unaffected because ingress is not data.

## 4. What Tailscale buys, and why it is the complement

- **Postgres works unchanged.** WireGuard carries the wire protocol natively.
  Bind the wake router (`packages/proxy/src/proxy.ts`) to the tailnet
  interface and wake-on-connect works over the tailnet with zero new code.
  This is the single largest win in the whole investigation, and it is a
  documentation task, not a build.
- **Tailscale Services** (`svc:` virtual IPs) gives multiple MagicDNS names
  and TCP endpoints from one tailscaled node. TCP is currently the only
  supported transport; Layer 4 forwards raw TCP to destinations like
  databases. That is per-resource private hostnames without one daemon per
  resource. Plan availability is unverified: the docs do not state tier.
- **The Docker shape matches `caddy.ts` exactly.** The `tailscale/tailscale`
  image, `TS_AUTHKEY`, `TS_STATE_DIR`, `TS_USERSPACE`, `TS_SERVE_CONFIG` (a
  JSON file; bind-mount the directory so changes are detected).
- **Funnel is not the public answer.** Ports 443, 8443 and 10000 only, no
  custom domain support (an open feature request), undisclosed bandwidth caps,
  and the current pricing page lists it as paid-tier. Also: Funnel routes TCP
  by SNI, and Postgres does a STARTTLS-style negotiation with no SNI at
  connect. It could not carry Postgres even if the rest fit.
- The Personal plan: 6 users, unlimited devices, MagicDNS, subnet routers,
  3 ACL groups. Free.

The split falls out of one property: Cloudflare's edge speaks HTTP and
terminates TLS for you; Tailscale is a layer-3 network that does not care what
protocol you run. That is exactly why the HTTP kinds want the first and the
wire-protocol kind wants the second. It is not a preference.

## 5. Against the wedge

**Wake survives both.** Both terminate at Hobbyist's own routers
(`packages/proxy/src/http.ts`, `packages/proxy/src/proxy.ts`), which call
`wake()`. The ADR 0009 seam holds unchanged: the proxy asks, the engine acts.

**Sleep does not benefit, and the footprint gets worse.** `cloudflared` and
`tailscaled` are always-on processes. Caddy already is one; this makes three.
On a five dollar VPS that is not free.

**Cold start gains an edge round trip** on every request, not just cold ones.
Unmeasured. The existing numbers (`app` p50 121ms, `worker` p50 299ms) are
Apple M5 Pro, and the five dollar VPS has still never been measured. That gap
predates this work, and this work makes it worse, since the tunnel adds a term
to a budget that has one favourable laptop data point.

## 6. Where it plugs in

| File | Change |
|---|---|
| `packages/cli/src/daemon/caddy.ts` | Generalise `CaddyManager` to an ingress interface; `cloudflared` becomes a second implementation |
| `packages/cli/src/daemon/context.ts` | `parseAppHostname`'s two-label rule is the thing Universal SSL collides with |
| `packages/proxy/src/proxy.ts` | Bind address for the tailnet path |
| `packages/core/src/config.ts` | `domain` grows a sibling: ingress mode |
| `docs/decisions/` | 0013 minimum, arguably three |

`createCaddyManager` still has no caller (a known Phase 1 loose end, unchanged
by this). Wiring ingress at all is open work; this research decides what gets
wired.

## 7. Recommendation

1. **Tailscale first, and it is nearly free.** Document `psql` over the
   tailnet, bind the proxy to it. Proves the private lane with no new
   dependency in the runtime path.
2. **Resolve the hostname scheme before writing any Cloudflare code.**
   Flattening to one label is the honest answer for a project with no revenue.
   Two labels means telling users to pay $10/month, which sits badly beside
   "nobody is expected to pay."
3. **Cloudflare Tunnel as an ingress adapter, locally-managed, Caddy retained
   as a peer.** An ADR that says plainly: this is a vendor dependency,
   accepted for the CGNAT case, and here is the exit.
4. **Measure the VPS before any of it.** The tunnel adds a term to a budget
   nobody has measured on the target hardware.

## 8. Unresolved

- Tailscale Services plan tier, and whether it is GA.
- Funnel's current plan gating (the pricing page and older docs disagree).
- Edge round-trip time added to cold start, on real hardware, both lanes.
- Whether `cloudflared` reconnects fast enough after the box wakes from sleep
  that the first request is not the one that pays for it.

## Sources

- [Cloudflare Tunnel configuration file and ingress](https://developers.cloudflare.com/tunnel/advanced/local-management/configuration-file/)
- [Cloudflare connection limits](https://developers.cloudflare.com/fundamentals/reference/connection-limits/)
- [Wildcard DNS records](https://developers.cloudflare.com/dns/manage-dns-records/reference/wildcard-dns-records/)
- [Advanced Certificate Manager](https://developers.cloudflare.com/ssl/edge-certificates/advanced-certificate-manager/)
- [Tunnel common errors, multi-level subdomain certificates](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/troubleshoot-tunnels/common-errors/)
- [Tunnel routing and DNS](https://developers.cloudflare.com/tunnel/routing/)
- [SMB over tunnel, the `cloudflared access tcp` client requirement](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/use-cases/smb/)
- [Partial zone setup](https://developers.cloudflare.com/dns/zone-setups/partial-setup/setup/)
- [Goodbye section 2.8 (Cloudflare ToS update)](https://blog.cloudflare.com/updated-tos)
- [Tailscale Services](https://tailscale.com/docs/features/tailscale-services)
- [Tailscale Serve](https://tailscale.com/kb/1312/serve)
- [Tailscale Funnel](https://tailscale.com/kb/1311/tailscale-funnel)
- [Funnel custom domain feature request](https://github.com/tailscale/tailscale/issues/11563)
- [Tailscale Docker parameters](https://tailscale.com/docs/features/containers/docker/docker-params)
- [Tailscale pricing](https://tailscale.com/pricing)
