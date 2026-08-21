---
title: TLS and custom domains
description: Caddy as a managed container, why it is off by default, and the two things it does not do yet.
sidebar:
  order: 8
---

<p class="state state--starting">works, off by default</p>

[Caddy](https://caddyserver.com) is the HTTP front door: TLS, certificates, and
routing a hostname to an [app](/docs/guides/apps/) or
[worker](/docs/guides/workers/). It runs as a container Hobbyist manages, driven
through Caddy's admin API rather than a config file.
[ADR 0009](/docs/decisions/0009-caddy-as-http-front-door/).

## It is off by default

`caddyEnabled` is `false` in the default configuration. A box that runs
databases for one person over [Tailscale](/docs/guides/tailscale-and-tunnels/)
never needs a public front door, and shipping one that is on by default would
mean every install opens ports it was never asked to open.

Turn it on in `~/.hobby/hobby.json`:

```json
{
  "caddyEnabled": true,
  "domain": "example.com",
  "caddyStudioHost": "studio.example.com"
}
```

`caddyStudioHost` may be left `null`, which publishes no Studio route and serves
only the catch-all. That is the correct setting for a box that runs apps and
does not want its control plane on the network.

## Requirements

**Host networking.** Caddy binds 80 and 443 on the host, so the container runs
with `network: host`.

| Platform | State |
|---|---|
| Linux | Measured, works |
| macOS with OrbStack | Measured 2026-08-14, works in both directions |
| macOS with Docker Desktop | **Unmeasured.** Host networking is expected to be absent. `hobby init` detects it and warns rather than failing later |

**Ports 80 and 443 reachable.** Certificate issuance needs them.

## Known gaps

<p class="state state--failed">certificates are not persisted</p>

The Caddy container is created with no volume, so replacing it re-issues every
certificate it holds. On a busy box that runs into Let's Encrypt rate limits.
Avoid recreating the container casually until this is fixed.

The other gap is not a defect but is worth knowing: on-demand TLS is asked for
rather than assumed, so a hostname Hobbyist does not recognise does not get a
certificate issued on its behalf.

## The alternative

For a private box, skip all of this.
[Tailscale or a Cloudflare Tunnel](/docs/guides/tailscale-and-tunnels/) gives you
a working name and working TLS with no inbound ports at all, which is both less
setup and less surface.
