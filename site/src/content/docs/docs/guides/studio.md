---
title: Studio
description: The web UI, its single operator credential, and why it should live behind a tunnel.
sidebar:
  order: 6
---

<p class="state state--starting">alpha, and network exposed by design</p>

Studio browses tables, runs SQL and reads schema. It is a client of the daemon
API like everything else, and it is the youngest surface in the project.

## Set it up

```sh
hobby studio passwd    # once, to set the operator password
hobby studio           # prints the URL, and opens it
```

The password prompt never echoes what you type, so the credential does not
appear on screen, in scrollback, or in a terminal recording.

Studio is served by the daemon itself, on `apiPort` (7432 by default), bound to
`127.0.0.1` only. There is no separate Studio server: `studioPort` exists in the
config and nothing listens on it. If you have
[configured a public host through Caddy](/docs/guides/tls-and-domains/),
`hobby studio` prints that instead of the loopback URL.

## One credential, and it is a real boundary

There is exactly one operator credential, and it belongs to you. Studio does not
ship user accounts, roles, or an auth system for anyone else's application, and
[it never will](/docs/decisions/0007-hobbyist-is-a-platform/): end-user auth as a
service is out of scope.

[ADR 0008](/docs/decisions/0008-studio-is-network-exposed/) is explicit that
because Studio is meant to be reachable from a browser on another machine, its
authentication is a security boundary rather than a formality. A control plane
that can create and destroy databases is worth as much as the databases.

## Put it behind a tunnel

The recommendation, plainly: **do not expose Studio on the open internet.** Reach
it over [Tailscale or a Cloudflare Tunnel](/docs/guides/tailscale-and-tunnels/).

Because it binds loopback, its tailnet address alone will refuse the connection.
One command bridges it:

```sh
tailscale serve --bg 7432
```

[The full instructions, including the SSH tunnel alternative](/docs/guides/tailscale-and-tunnels/#reaching-studio-over-the-tailnet).

This is not a statement that the authentication is known to be weak. It is that
this is a v0-alpha surface on a project with no security team, the failure mode
of getting it wrong is someone else owning your box, and a tunnel removes the
entire class of problem for about ten minutes of setup. The project's own
position is that it does not ship things whose failure mode is someone getting
owned quietly, and a tunnel is how this one is kept to that standard.

If you find something with a security impact, mail business@uziiuzair.com rather
than opening a public issue.

## What it can and cannot do

| | |
|---|---|
| Browse tables and rows | yes |
| Run SQL | yes |
| Read schema | yes |
| See sleep state, and wake something | yes |
| Create a `postgres` resource | yes |
| Create an `app` or `worker` | **not yet.** It hardcodes `kind: 'postgres'`, and the daemon side that would allow it has landed |
| API tokens | not built |

## Offline by design

Studio bundles its own fonts and ships no CDN references, because it runs on a
box that may have no internet. Nothing it renders makes a request that leaves
the machine.
