---
title: Tailscale and Cloudflare Tunnel
description: The private lane. How to reach a box with no inbound ports open, which is how the author runs it.
sidebar:
  order: 9
---

<p class="state state--starting">works</p>

This is how the project's author actually runs it: a home server, reachable
through Tailscale and a Cloudflare Tunnel, hosting demo environments. No inbound
ports, no certificates to manage, nothing on the open internet.

For most people running this for themselves, it is a better answer than
[Caddy](/docs/guides/tls-and-domains/), and it is less work.

## Tailscale

When the daemon has a tailnet address, it reports a second connection string
alongside the local one:

```sh
hobby connect blog --json
```

```json
{
  "connectionString": "postgresql://...@127.0.0.1:5432/blog",
  "tailnetConnectionString": "postgresql://...@your-box.tailnet.ts.net:5432/blog"
}
```

Use the tailnet string from any other machine on your tailnet. Postgres over a
tailnet was researched and filed before it was relied on, in
`docs/proxy/research/2026-08-13-postgres-over-tailnet.md`.

An architecture decision record for the two ingress lanes is expected and has
not been filed at the time of writing. The implementation is on `main`.

## Cloudflare Tunnel

A tunnel gives an HTTP service a public hostname with no inbound port. Point
`cloudflared` at the HTTP router:

```yaml
# ~/.cloudflared/config.yml
tunnel: <your-tunnel-id>
credentials-file: /home/you/.cloudflared/<your-tunnel-id>.json

ingress:
  - hostname: app.example.com
    service: http://127.0.0.1:7433
  - service: http_status:404
```

7433 is the HTTP wake router. Requests arriving through the tunnel wake a
sleeping app or worker exactly as they would arriving through Caddy: the router
does not care what is in front of it.

For Studio, point a second hostname at the daemon's port, 7432, and put a
Cloudflare Access policy in front of it. Studio's own credential is
[a real boundary](/docs/guides/studio/), and an Access policy in front of it
means an attacker has to get through both.

## Reaching Studio over the tailnet

Studio binds `127.0.0.1` only, on purpose: it is a control plane that can create
and destroy databases, so it does not put itself on a network by default. Its
tailnet address will refuse a connection. `tailscale serve` is the way across,
and it is the recommended one, because it terminates TLS with your tailnet's own
certificate and exposes nothing beyond the tailnet.

```sh
tailscale serve --bg 7432
```

Then open the URL that prints, which is your machine's tailnet name over HTTPS.
To find it:

```sh
tailscale status --json | grep DNSName
```

Older `tailscale` builds want the longer form:

```sh
tailscale serve https / http://127.0.0.1:7432
```

To check or undo it:

```sh
tailscale serve status
tailscale serve --bg --https=443 off
```

Do not reach for `tailscale funnel` here. Funnel publishes to the open
internet, which is the opposite of the reason to use a tailnet, and Studio is
the last surface in this project that should be there.

### Without Tailscale, an SSH tunnel does the same job

Nothing to install or configure on the box:

```sh
ssh -L 7432:127.0.0.1:7432 you@your-box
```

Then open `http://127.0.0.1:7432` on your own machine. The tunnel lasts as long
as the SSH session.

## Why this is the recommendation

A tunnel or a tailnet removes an entire class of problem rather than mitigating
it. There is no certificate store to persist, no rate limit to hit, no port
scan to worry about, and no v0-alpha authentication surface exposed to the open
internet. Reaching for it costs about ten minutes.
